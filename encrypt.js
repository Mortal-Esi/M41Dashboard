/**
 * encrypt.js
 * ----------
 * Encrypts dashboard_data.json into dashboard_data.enc so the plaintext data
 * never touches the public GitHub Pages repo — only the ciphertext does.
 * dashboard.html decrypts it in-browser (Web Crypto) with the password the
 * viewer types in.
 *
 * Format (v2): the data is gzipped, then encrypted once with a random data
 * key (AES-256-GCM). That data key is then encrypted separately under each
 * password ("slots"), using a key derived with PBKDF2-SHA256 at 600,000
 * iterations. The .enc file is public, so anyone can download it and guess
 * passwords offline — the slow key derivation is what makes each guess
 * expensive (the old format used a single MD5 round).
 *
 * The password(s) live in password.local.js, NOT in this file — that file is
 * gitignored and never committed. It can export either one shared password
 * string, or an object giving each person their own password:
 *   module.exports = { ali: '…', sara: '…' };
 * Removing someone's line and re-running revokes them without changing
 * anyone else's password.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PASSWORD_FILE = path.join(__dirname, 'password.local.js');
const JSON_PATH = path.join(__dirname, 'dashboard_data.json');
const ENC_PATH = path.join(__dirname, 'dashboard_data.enc');

const KDF_ITERATIONS = 600000;
const MIN_PASSWORD_LENGTH = 12;

function loadPasswords() {
  let config;
  try {
    config = require(PASSWORD_FILE);
  } catch (e) {
    throw new Error(
      'Missing password.local.js. Copy password.local.js.example to ' +
      'password.local.js and set your real password there, then try again.'
    );
  }
  const entries = typeof config === 'string' ? [['(shared)', config]] : Object.entries(config || {});
  const passwords = entries.filter(([, pw]) => typeof pw === 'string' && pw.length > 0);
  if (passwords.length === 0 || passwords.some(([, pw]) => pw === 'CHANGE_ME')) {
    throw new Error('Set a real password in password.local.js (it is empty or still has the CHANGE_ME placeholder).');
  }
  for (const [label, pw] of passwords) {
    if (pw.length < MIN_PASSWORD_LENGTH) {
      console.warn(`WARNING: password for ${label} is under ${MIN_PASSWORD_LENGTH} characters — the .enc file is public, so a short password can be guessed offline.`);
    }
  }
  return passwords.map(([, pw]) => pw);
}

function gcmEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  // Web Crypto expects the auth tag appended to the ciphertext.
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}

function encryptDashboardData(passwords = loadPasswords()) {
  const compressed = zlib.gzipSync(fs.readFileSync(JSON_PATH), { level: 9 });
  const salt = crypto.randomBytes(16);
  const dataKey = crypto.randomBytes(32);
  const slots = passwords.map((pw) => {
    const kek = crypto.pbkdf2Sync(pw.normalize('NFC'), salt, KDF_ITERATIONS, 32, 'sha256');
    return gcmEncrypt(kek, dataKey);
  });
  const payload = gcmEncrypt(dataKey, compressed);
  const envelope = {
    v: 2,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: salt.toString('base64') },
    slots,
    iv: payload.iv,
    data: payload.ct,
  };
  const out = JSON.stringify(envelope);
  fs.writeFileSync(ENC_PATH, out, 'utf-8');
  console.log(`Encrypted → ${ENC_PATH} (${(out.length / 1024).toFixed(0)} KB, ${slots.length} password slot${slots.length === 1 ? '' : 's'})`);
  return ENC_PATH;
}

if (require.main === module) {
  encryptDashboardData();
}

module.exports = { encryptDashboardData };

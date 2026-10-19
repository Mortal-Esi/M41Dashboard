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
 * Format v3 (current) adds usernames: password.local.js exports
 *   module.exports = { ali: '<password>', sara: '<password>' };
 * (manage it with `node make-users.js`). Each person's key is derived from
 * their password AND their username, so a password is useless without the
 * matching username. The public file only carries a salted hash of each
 * username (slot id), never the name itself. Removing someone's line and
 * re-running revokes them without changing anyone else's password.
 * A single shared password string is still accepted (no username).
 *
 * password.local.js is gitignored and never committed.
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
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;

const normUser = (u) => String(u).trim().toLowerCase();
// Slot id: salted hash of the username, so the public file lists no names.
function slotId(salt, username) {
  return crypto.createHmac('sha256', salt).update('user:' + username).digest('base64').slice(0, 22);
}
// KDF salt binds the key to the username ('' for a shared password).
function kdfSalt(salt, username) {
  return username ? Buffer.concat([salt, Buffer.from(':' + username, 'utf8')]) : salt;
}

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
  // [username, password]; username '' = one shared password, no username.
  const entries = typeof config === 'string' ? [['', config]] : Object.entries(config || {}).map(([u, pw]) => [normUser(u), pw]);
  const users = entries.filter(([, pw]) => typeof pw === 'string' && pw.length > 0);
  if (users.length === 0 || users.some(([, pw]) => pw === 'CHANGE_ME')) {
    throw new Error('Set a real password in password.local.js (it is empty or still has the CHANGE_ME placeholder). Run: node make-users.js add <username> …');
  }
  const seen = new Set();
  for (const [user, pw] of users) {
    if (user && !USERNAME_RE.test(user)) throw new Error(`Invalid username "${user}" in password.local.js — use 2-32 of a-z 0-9 . _ -`);
    if (seen.has(user)) throw new Error(`Username "${user}" appears twice in password.local.js.`);
    seen.add(user);
    if (pw.length < MIN_PASSWORD_LENGTH) {
      console.warn(`WARNING: password for ${user || '(shared)'} is under ${MIN_PASSWORD_LENGTH} characters — the .enc file is public, so a short password can be guessed offline.`);
    }
  }
  return users;
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
  const slots = passwords.map(([user, pw]) => {
    const kek = crypto.pbkdf2Sync(pw.normalize('NFC'), kdfSalt(salt, user), KDF_ITERATIONS, 32, 'sha256');
    return user ? { id: slotId(salt, user), ...gcmEncrypt(kek, dataKey) } : gcmEncrypt(kek, dataKey);
  });
  const payload = gcmEncrypt(dataKey, compressed);
  const envelope = {
    v: 3,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: salt.toString('base64') },
    slots,
    iv: payload.iv,
    data: payload.ct,
  };
  const out = JSON.stringify(envelope);
  fs.writeFileSync(ENC_PATH, out, 'utf-8');
  const named = passwords.filter(([u]) => u).map(([u]) => u);
  console.log(`Encrypted → ${ENC_PATH} (${(out.length / 1024).toFixed(0)} KB, ${slots.length} slot${slots.length === 1 ? '' : 's'}${named.length ? ': ' + named.join(', ') : ', shared password'})`);
  return ENC_PATH;
}

if (require.main === module) {
  encryptDashboardData();
}

module.exports = { encryptDashboardData };

/**
 * encrypt.js
 * ----------
 * Encrypts dashboard_data.json into dashboard_data.enc (AES, password-based)
 * so the plaintext data never touches the public GitHub Pages repo — only
 * the ciphertext does. dashboard.html decrypts it in-browser with CryptoJS
 * using the same password the viewer types in.
 *
 * The password lives in password.local.js, NOT in this file — that file is
 * gitignored and never committed, so the password never ends up in the
 * public repo (which would defeat the whole point of encrypting the data).
 * To set or rotate it: copy password.local.js.example to password.local.js
 * and edit the value there.
 */

const fs = require('fs');
const path = require('path');
const CryptoJS = require('crypto-js');

const PASSWORD_FILE = path.join(__dirname, 'password.local.js');
let DASHBOARD_PASSWORD;
try {
  DASHBOARD_PASSWORD = require(PASSWORD_FILE);
} catch (e) {
  throw new Error(
    'Missing password.local.js. Copy password.local.js.example to ' +
    'password.local.js and set your real password there, then try again.'
  );
}
if (!DASHBOARD_PASSWORD || DASHBOARD_PASSWORD === 'CHANGE_ME') {
  throw new Error('Set a real password in password.local.js (it still has the CHANGE_ME placeholder).');
}

const JSON_PATH = path.join(__dirname, 'dashboard_data.json');
const ENC_PATH = path.join(__dirname, 'dashboard_data.enc');

function encryptDashboardData(password = DASHBOARD_PASSWORD) {
  const plaintext = fs.readFileSync(JSON_PATH, 'utf-8');
  const ciphertext = CryptoJS.AES.encrypt(plaintext, password).toString();
  fs.writeFileSync(ENC_PATH, ciphertext, 'utf-8');
  console.log(`Encrypted → ${ENC_PATH} (${(ciphertext.length / 1024).toFixed(0)} KB)`);
  return ENC_PATH;
}

if (require.main === module) {
  encryptDashboardData();
}

module.exports = { encryptDashboardData, DASHBOARD_PASSWORD };

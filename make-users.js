/**
 * make-users.js
 * -------------
 * Manages dashboard logins in password.local.js (gitignored, never committed).
 * Every person gets their own username and a random password.
 *
 *   node make-users.js add ali sara     → new users, prints their passwords
 *   node make-users.js reset ali        → new password for ali (old one stops working)
 *   node make-users.js remove ali       → ali can no longer log in
 *   node make-users.js list             → usernames only
 *
 * Changes take effect for the live site the next time the data is
 * re-encrypted and pushed — run refresh-dashboard.bat afterwards.
 * Passwords are printed once; send each person theirs privately.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'password.local.js');
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;
// No look-alike characters (0/O, 1/l/I), so passwords can be read out or retyped safely.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_LENGTH = 20; // ≈ 117 bits of randomness

function generatePassword() {
  let pw = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) pw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return pw;
}

function load() {
  if (!fs.existsSync(FILE)) return { users: {}, hadShared: false };
  delete require.cache[require.resolve(FILE)];
  const cfg = require(FILE);
  if (typeof cfg === 'string') return { users: {}, hadShared: cfg !== 'CHANGE_ME' };
  const users = {};
  for (const [u, pw] of Object.entries(cfg || {})) {
    if (typeof pw === 'string' && pw && pw !== 'CHANGE_ME') users[u.trim().toLowerCase()] = pw;
  }
  return { users, hadShared: false };
}

function save(users) {
  const body = Object.entries(users)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([u, pw]) => `  ${JSON.stringify(u)}: ${JSON.stringify(pw)},`)
    .join('\n');
  const text = `// Dashboard logins — managed by make-users.js. NEVER commit this file.\nmodule.exports = {\n${body}\n};\n`;
  fs.writeFileSync(FILE, text, { encoding: 'utf-8', mode: 0o600 });
}

function printCredentials(rows) {
  if (!rows.length) return;
  const w = Math.max(8, ...rows.map(([u]) => u.length));
  console.log('\n  ' + 'Username'.padEnd(w) + '  Password');
  console.log('  ' + '-'.repeat(w) + '  ' + '-'.repeat(PASSWORD_LENGTH));
  for (const [u, pw] of rows) console.log('  ' + u.padEnd(w) + '  ' + pw);
  console.log('\nSend each person their own line privately (not in a group chat). This is the only time the passwords are shown here;');
  console.log('they are also stored in password.local.js on this computer.');
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const names = args.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const { users, hadShared } = load();

  if (!cmd || cmd === 'list') {
    const list = Object.keys(users).sort();
    console.log(list.length ? `Users (${list.length}): ${list.join(', ')}` : 'No users yet. Add some: node make-users.js add <username> …');
    if (hadShared) console.log('password.local.js still holds a single shared password (no usernames).');
    return;
  }

  for (const n of names) {
    if (!USERNAME_RE.test(n)) {
      console.error(`Invalid username "${n}" — use 2-32 characters: a-z 0-9 . _ -`);
      process.exit(1);
    }
  }
  if (!names.length) {
    console.error(`Usage: node make-users.js ${cmd} <username> [<username> …]`);
    process.exit(1);
  }

  const shown = [];
  if (cmd === 'add') {
    for (const n of names) {
      if (users[n]) { console.log(`  ${n} already exists — skipped (use "reset" to give them a new password).`); continue; }
      users[n] = generatePassword();
      shown.push([n, users[n]]);
    }
  } else if (cmd === 'reset') {
    for (const n of names) {
      if (!users[n]) { console.log(`  ${n} does not exist — skipped (use "add").`); continue; }
      users[n] = generatePassword();
      shown.push([n, users[n]]);
    }
  } else if (cmd === 'remove') {
    for (const n of names) {
      if (!users[n]) { console.log(`  ${n} does not exist — skipped.`); continue; }
      delete users[n];
      console.log(`  Removed ${n}.`);
    }
  } else {
    console.error(`Unknown command "${cmd}". Use: add | reset | remove | list`);
    process.exit(1);
  }

  if (Object.keys(users).length === 0) {
    console.error('That would leave no users at all — nothing was saved.');
    process.exit(1);
  }
  save(users);
  if (hadShared) console.log('\nThe old shared password was removed — from the next refresh only these usernames can log in.');
  printCredentials(shown);
  console.log('\nNext: run refresh-dashboard.bat so the live dashboard uses the new logins.');
}

main();

#!/usr/bin/env node
/**
 * Set the shared team password.
 *
 *   npm run set-password                # generates a strong password
 *   npm run set-password -- --prompt    # type your own (hidden, min 12 chars)
 *
 * Writes SHARED_PASSWORD_HASH (scrypt) into the repo-root .env and removes
 * the old single-account ADMIN_EMAIL / ADMIN_PASSWORD_HASH lines. The plain
 * password is never stored. Anyone with an @LOGIN_EMAIL_DOMAIN address
 * (default courserev.ai) signs in with it. Restart the server afterwards;
 * existing sessions end on restart.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = path.join(root, '.env');
const flag = process.argv[2];

if (flag && flag !== '--prompt') {
  console.error('usage: npm run set-password [-- --prompt]');
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

let password;
if (flag === '--prompt') {
  password = await promptHidden('New shared password (min 12 chars): ');
  if (password.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
} else {
  // 18 random bytes -> 24 base64url chars (~144 bits).
  password = crypto.randomBytes(18).toString('base64url');
}

const lines = (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : [])
  .filter((l) => !l.startsWith('ADMIN_EMAIL=') && !l.startsWith('ADMIN_PASSWORD_HASH='));
const line = `SHARED_PASSWORD_HASH='${hashPassword(password)}'`;
const i = lines.findIndex((l) => l.startsWith('SHARED_PASSWORD_HASH='));
if (i >= 0) lines[i] = line; else lines.push(line);
fs.writeFileSync(envFile, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });

console.log(`Shared password set in ${envFile}`);
if (!flag) console.log(`Generated password: ${password}\n(Shown once. Share it with the team through a password manager.)`);
console.log('Restart the server to apply.');

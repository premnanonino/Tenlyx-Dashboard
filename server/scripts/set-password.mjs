#!/usr/bin/env node
/**
 * Set the single dashboard login.
 *
 *   npm run set-password -- you@example.com            # generates a strong password
 *   npm run set-password -- you@example.com --prompt   # type your own (hidden)
 *
 * Writes ADMIN_EMAIL and ADMIN_PASSWORD_HASH (scrypt) into the repo-root .env.
 * The plain password is never stored. Restart the server afterwards.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = path.join(root, '.env');
const [email, flag] = process.argv.slice(2);

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('usage: npm run set-password -- <email> [--prompt]');
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
  password = await promptHidden('New password (min 12 chars): ');
  if (password.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
} else {
  // 18 random bytes -> 24 base64url chars (~144 bits).
  password = crypto.randomBytes(18).toString('base64url');
}

const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : [];
const set = (key, value) => {
  const line = `${key}='${value}'`;
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = line; else lines.push(line);
};
set('ADMIN_EMAIL', email.toLowerCase());
set('ADMIN_PASSWORD_HASH', hashPassword(password));
fs.writeFileSync(envFile, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });

console.log(`Login set for ${email.toLowerCase()} in ${envFile}`);
if (flag !== '--prompt') console.log(`Generated password: ${password}\n(Shown once. Store it in a password manager.)`);
console.log('Restart the server to apply.');

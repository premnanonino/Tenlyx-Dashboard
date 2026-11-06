// Runs backend (:8787, auto-restart on change) and Vite (:5173) together.
import { spawn } from 'node:child_process';

const procs = [
  ['api', 'npm', ['--prefix', 'server', 'run', 'dev']],
  ['web', 'npm', ['--prefix', 'client', 'run', 'dev']],
].map(([tag, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const pipe = (stream, out) => stream.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => out.write(`[${tag}] ${l}\n`)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => { console.log(`[${tag}] exited ${code}`); shutdown(); });
  return p;
});

function shutdown() { procs.forEach((p) => p.kill('SIGTERM')); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

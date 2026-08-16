/**
 * Launches the built app with SHEEP_SMOKE=1 and forwards its exit code.
 * The app boots, reports its checks, and quits itself.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import electronBinary from 'electron';

const HARD_TIMEOUT_MS = 90_000;

const child = spawn(electronBinary, ['.'], {
  env: { ...process.env, SHEEP_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const timeout = setTimeout(() => {
  process.stderr.write(`smoke: no exit after ${HARD_TIMEOUT_MS}ms, killing electron\n`);
  child.kill();
  process.exitCode = 1;
}, HARD_TIMEOUT_MS);

child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  if (code === 0) {
    process.stdout.write('smoke: app launched and exited cleanly\n');
    process.exitCode = 0;
  } else {
    process.stderr.write(`smoke: electron exited with code=${code} signal=${signal}\n`);
    process.exitCode = code ?? 1;
  }
});

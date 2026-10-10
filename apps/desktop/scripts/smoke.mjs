/**
 * Launches the app with SHEEP_SMOKE=1 and forwards its exit code.
 * The app boots, reports its checks, and quits itself.
 *
 *   node scripts/smoke.mjs              the build in out/, on the installed Electron
 *   node scripts/smoke.mjs --packaged   the packaged app in dist/, as an install runs it
 *
 * The packaged run is the one that proves an installer's contents: the app
 * finds its Python runtime, its rendering tools and its native modules where
 * packaging put them, or the checks that use them fail.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import electronBinary from 'electron';

const HARD_TIMEOUT_MS = 210_000;

const packaged = process.argv.includes('--packaged');
const packagedBinary = resolve(
  import.meta.dirname,
  '..',
  'dist',
  { win32: 'win-unpacked/Sheep.exe', darwin: 'mac/Sheep.app/Contents/MacOS/Sheep' }[
    process.platform
  ] ?? 'linux-unpacked/sheep',
);
if (packaged && !existsSync(packagedBinary)) {
  process.stderr.write(
    `smoke: no packaged app at ${packagedBinary}; run \`npm run dist -- --dir\`\n`,
  );
  process.exit(1);
}

const child = packaged
  ? spawn(packagedBinary, [], {
      env: { ...process.env, SHEEP_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawn(electronBinary, ['.'], {
      env: { ...process.env, SHEEP_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const timeout = setTimeout(() => {
  process.stderr.write(`smoke: no exit after ${HARD_TIMEOUT_MS}ms, killing the app\n`);
  child.kill();
  process.exitCode = 1;
}, HARD_TIMEOUT_MS);

child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  if (code === 0) {
    process.stdout.write(
      `smoke: ${packaged ? 'the packaged app' : 'app'} launched and exited cleanly\n`,
    );
    process.exitCode = 0;
  } else {
    process.stderr.write(`smoke: the app exited with code=${code} signal=${signal}\n`);
    process.exitCode = code ?? 1;
  }
});

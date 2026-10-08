/**
 * Installs the pinned Python runtime the sandbox executes in.
 *
 *   node scripts/fetch-runtime.mjs            install exactly what runtime.lock.json names
 *   node scripts/fetch-runtime.mjs --relock   re-resolve the wheel set and rewrite the lock
 *
 * Every download is checked against the sha256 in the lock before it is used,
 * so the runtime on disk is a function of the lock file and nothing else. The
 * hash of the lock entry is stamped into the runtime and recorded with every
 * execution: two runs with the same stamp ran on the same interpreter and the
 * same wheels.
 *
 * Deliberately not the system Python — wheel availability for whatever the
 * machine happens to have installed is not something a reproducible run can
 * rest on.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const packageDir = resolve(import.meta.dirname, '..');
const lockPath = join(packageDir, 'runtime.lock.json');
const runtimeDir = join(packageDir, 'runtime');
const cacheDir = join(packageDir, '.runtime-cache');
const markerPath = join(runtimeDir, 'sheep-runtime.json');

const platform = `${process.platform}-${process.arch}`;
const relock = process.argv.includes('--relock');

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const entry = lock[platform];
if (!entry) {
  // ponytail: win32-x64 only; macOS and Linux entries arrive with Phase 72 packaging.
  fail(`runtime.lock.json has no entry for ${platform}`);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** Must match `lockHash` in src/runtime.ts: both hash the parsed entry, re-serialised. */
const lockHashOf = (value) => sha256(JSON.stringify(value));

function fail(message) {
  process.stderr.write(`fetch-runtime: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`fetch-runtime: ${message}\n`);
}

/** Downloads into the cache unless a file with the right hash is already there. */
async function fetchVerified(url, expected) {
  mkdirSync(cacheDir, { recursive: true });
  const target = join(cacheDir, decodeURIComponent(basename(new URL(url).pathname)));
  if (existsSync(target) && sha256(readFileSync(target)) === expected) return target;

  log(`downloading ${basename(target)}`);
  const response = await fetch(url);
  if (!response.ok) fail(`${url} answered ${String(response.status)}`);
  const body = Buffer.from(await response.arrayBuffer());
  const actual = sha256(body);
  if (actual !== expected) {
    fail(`${basename(target)} hashes to ${actual}, but the lock pins ${expected}`);
  }
  writeFileSync(target, body);
  return target;
}

function pythonExe(dir) {
  return process.platform === 'win32' ? join(dir, 'python.exe') : join(dir, 'bin', 'python3');
}

function pip(dir, args) {
  execFileSync(
    pythonExe(dir),
    ['-I', '-m', 'pip', '--disable-pip-version-check', '--no-input', ...args],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
}

async function installPython() {
  const archive = await fetchVerified(entry.python.url, entry.python.sha256);
  const staging = join(tmpdir(), `sheep-runtime-${String(process.pid)}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Windows' own bsdtar by full path: a `tar` found on PATH may be an MSYS
  // build that reads `C:\...` as a remote host.
  const tar =
    process.platform === 'win32'
      ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  execFileSync(tar, ['-xzf', archive, '-C', staging], { stdio: 'inherit' });

  rmSync(runtimeDir, { recursive: true, force: true });
  renameSync(join(staging, 'python'), runtimeDir);
  rmSync(staging, { recursive: true, force: true });
}

/** Asks pip what the requirements resolve to, without installing any of it. */
function resolveWheels() {
  const reportPath = join(cacheDir, 'resolve-report.json');
  pip(runtimeDir, [
    'install',
    '--dry-run',
    '--ignore-installed',
    '--only-binary=:all:',
    '--quiet',
    '--report',
    reportPath,
    ...entry.requirements,
  ]);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  rmSync(reportPath, { force: true });

  return report.install
    .map((item) => {
      const hash = item.download_info.archive_info?.hashes?.sha256;
      if (!hash) fail(`pip reported no sha256 for ${item.metadata.name}`);
      return {
        name: item.metadata.name,
        version: item.metadata.version,
        url: item.download_info.url,
        sha256: hash,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  if (!relock && existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (marker.lockHash === lockHashOf(entry) && existsSync(pythonExe(runtimeDir))) {
      log(`up to date (${marker.lockHash.slice(0, 12)})`);
      return;
    }
  }

  await installPython();

  if (relock) {
    entry.wheels = resolveWheels();
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    log(`relocked ${String(entry.wheels.length)} wheels`);
  }

  const wheels = [];
  for (const wheel of entry.wheels) wheels.push(await fetchVerified(wheel.url, wheel.sha256));
  // --no-index and --no-deps: nothing is installed that the lock does not name.
  pip(runtimeDir, ['install', '--no-index', '--no-deps', '--no-warn-script-location', ...wheels]);

  const lockHash = lockHashOf(entry);
  writeFileSync(
    markerPath,
    `${JSON.stringify({ lockHash, platform, python: entry.python.version }, null, 2)}\n`,
  );
  log(`installed python ${entry.python.version} + ${String(wheels.length)} wheels`);
  log(`lock hash ${lockHash}`);
}

await main();

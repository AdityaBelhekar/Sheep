/**
 * Installs the pinned rendering tools: Graphviz for diagrams, Tectonic for
 * LaTeX, and the conference style files no TeX distribution carries.
 *
 *   node scripts/fetch-tools.mjs
 *
 * The same contract as the Python runtime: every download is checked against
 * the sha256 in tools.lock.json before it is used, and the hash of the lock
 * entry is stamped into the directory, so what renders a figure or a paper is
 * a function of the lock file and nothing else.
 *
 * Tectonic fetches TeX packages on demand. This script is the only place it is
 * allowed to: it typesets every document in `scripts/warm/` — one per paper
 * template, and one that loads what a figure may use — and the app then runs
 * Tectonic against that cache alone. Compiling never reaches the network.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const packageDir = resolve(import.meta.dirname, '..');
const toolsDir = join(packageDir, 'tools');
const cacheDir = join(packageDir, '.tools-cache');
const warmSourceDir = join(import.meta.dirname, 'warm');
const markerPath = join(toolsDir, 'sheep-tools.json');

const platform = `${process.platform}-${process.arch}`;
const lock = JSON.parse(readFileSync(join(packageDir, 'tools.lock.json'), 'utf8'));
const entry = lock[platform];
if (!entry) {
  // ponytail: win32-x64 only; macOS and Linux entries arrive with Phase 72 packaging.
  fail(`tools.lock.json has no entry for ${platform}`);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** Must match `expectedToolsHash` in src/tools.ts: both hash the parsed entry, re-serialised. */
const lockHash = sha256(JSON.stringify(entry));

const warmSources = readdirSync(warmSourceDir)
  .filter((name) => name.endsWith('.tex'))
  .sort();
/** Changes when a warm-up document does, so the cache is refilled without reinstalling the tools. */
const warmHash = sha256(warmSources.map((name) => readFileSync(join(warmSourceDir, name))).join());

function fail(message) {
  process.stderr.write(`fetch-tools: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`fetch-tools: ${message}\n`);
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

/** Windows' own bsdtar by full path; it reads zip, and an MSYS `tar` on PATH does not read `C:\`. */
function unzip(archive, into, strip) {
  const tar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  execFileSync(tar, ['-xf', archive, '-C', into, `--strip-components=${String(strip)}`], {
    stdio: 'inherit',
  });
}

const dot = join(toolsDir, 'graphviz', 'bin', 'dot.exe');
const tectonic = join(toolsDir, 'tectonic', 'tectonic.exe');
const stylesDir = join(toolsDir, 'styles');

async function installTools() {
  const graphvizZip = await fetchVerified(entry.graphviz.url, entry.graphviz.sha256);
  const tectonicZip = await fetchVerified(entry.tectonic.url, entry.tectonic.sha256);
  const styleZips = [];
  for (const style of entry.styles) {
    styleZips.push([style, await fetchVerified(style.url, style.sha256)]);
  }

  // Each tool's own directory is replaced. The TeX cache beside them is kept:
  // it is content-addressed, and refetching it would be the slow part.
  unzip(graphvizZip, join(toolsDir, 'graphviz'), 1);
  unzip(tectonicZip, join(toolsDir, 'tectonic'), 0);
  for (const [style, archive] of styleZips) {
    unzip(archive, join(stylesDir, style.name), style.strip);
  }

  // Writes the plugin registry beside dot.exe; without it dot knows no output formats.
  execFileSync(dot, ['-c'], { stdio: 'inherit' });

  // The first PDF on a machine waits while fontconfig indexes every installed
  // font. Paid here, once, rather than by whoever renders the first diagram.
  log('indexing fonts for graphviz (can take a few minutes the first time)');
  execFileSync(dot, ['-Tpdf'], { input: 'graph { a }', stdio: ['pipe', 'ignore', 'inherit'] });
}

/** Typesets every warm-up document online, so that all it loads is cached for offline use. */
function fillTexCache() {
  log('filling the TeX cache (the one time Tectonic may use the network)');
  const figure = execFileSync(dot, ['-Tpdf'], { input: 'digraph { source -> figure -> claim }' });

  for (const name of warmSources) {
    const dir = join(toolsDir, 'warm-up');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'figures'), { recursive: true });
    copyFileSync(join(warmSourceDir, name), join(dir, 'paper.tex'));
    writeFileSync(join(dir, 'figures', 'figure-1.pdf'), figure);
    // Exactly the style files the template names, as when a paper is compiled:
    // anything else it loads must come from the cache, so it has to get there now.
    const styles = /^% styles: (.+)$/m.exec(readFileSync(join(dir, 'paper.tex'), 'utf8'));
    for (const file of styles ? styles[1].trim().split(' ') : []) {
      copyFileSync(join(stylesDir, file), join(dir, basename(file)));
    }

    log(`  ${name}`);
    execFileSync(tectonic, ['-X', 'compile', '--untrusted', 'paper.tex'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, TECTONIC_CACHE_DIR: join(toolsDir, 'tex-cache') },
    });
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : {};
  const installed =
    marker.lockHash === lockHash &&
    existsSync(dot) &&
    existsSync(tectonic) &&
    entry.styles.every((style) => existsSync(join(stylesDir, style.name)));

  if (installed && marker.warmHash === warmHash) {
    log(`up to date (${lockHash.slice(0, 12)})`);
    return;
  }
  if (!installed) await installTools();
  fillTexCache();

  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        lockHash,
        warmHash,
        platform,
        graphviz: entry.graphviz.version,
        tectonic: entry.tectonic.version,
        styles: Object.fromEntries(entry.styles.map((style) => [style.name, style.version])),
      },
      null,
      2,
    )}\n`,
  );
  log(`installed graphviz ${entry.graphviz.version} + tectonic ${entry.tectonic.version}`);
  log(`lock hash ${lockHash}`);
}

await main();

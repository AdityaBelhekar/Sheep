/**
 * Installs the pinned rendering tools: Graphviz for diagrams, Tectonic for LaTeX.
 *
 *   node scripts/fetch-tools.mjs
 *
 * The same contract as the Python runtime: every download is checked against
 * the sha256 in tools.lock.json before it is used, and the hash of the lock
 * entry is stamped into the directory, so what renders a figure is a function
 * of the lock file and nothing else.
 *
 * Tectonic fetches TeX packages on demand. This script is the only place it is
 * allowed to: it typesets one document that loads everything a figure is
 * expected to need, and the app then runs Tectonic against that cache alone.
 * Rendering never reaches the network.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const packageDir = resolve(import.meta.dirname, '..');
const toolsDir = join(packageDir, 'tools');
const cacheDir = join(packageDir, '.tools-cache');
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
  mkdirSync(into, { recursive: true });
  execFileSync(tar, ['-xf', archive, '-C', into, `--strip-components=${String(strip)}`], {
    stdio: 'inherit',
  });
}

/**
 * Loads what a figure or a formula is expected to use, so that all of it is in
 * the cache before the app ever runs Tectonic offline. A package not loaded
 * here is one a figure cannot use.
 */
const WARM_UP = String.raw`\documentclass[tikz,border=2pt]{standalone}
\usepackage{amsmath,amssymb,amsfonts,mathtools,bm}
\usepackage{xcolor}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\usetikzlibrary{arrows.meta,positioning,calc,shapes.geometric,shapes.misc,decorations.pathreplacing,decorations.markings,fit,backgrounds,patterns,matrix,chains,trees,automata,intersections,angles,quotes}
\usepgfplotslibrary{fillbetween}
\begin{document}
\begin{tikzpicture}
  \node[draw, rounded corners] (a) {$\displaystyle \int_0^\infty e^{-x^2}\,\mathrm{d}x = \frac{\sqrt{\pi}}{2}$};
  \node[draw, right=of a] (b) {$\mathbb{R} \subset \mathbb{C}$, \textbf{bold} \textit{italic} \texttt{mono} \textsf{sans}};
  \draw[-{Stealth}] (a) -- (b);
\end{tikzpicture}
\begin{tikzpicture}
  \begin{axis}[xlabel=$x$, ylabel=$y$, legend entries={$\sin x$}]
    \addplot[domain=0:6.28, samples=40] {sin(deg(x))};
  \end{axis}
\end{tikzpicture}
\end{document}
`;

async function main() {
  const dot = join(toolsDir, 'graphviz', 'bin', 'dot.exe');
  const tectonic = join(toolsDir, 'tectonic', 'tectonic.exe');

  if (existsSync(markerPath) && existsSync(dot) && existsSync(tectonic)) {
    if (JSON.parse(readFileSync(markerPath, 'utf8')).lockHash === lockHash) {
      log(`up to date (${lockHash.slice(0, 12)})`);
      return;
    }
  }

  const graphvizZip = await fetchVerified(entry.graphviz.url, entry.graphviz.sha256);
  const tectonicZip = await fetchVerified(entry.tectonic.url, entry.tectonic.sha256);

  rmSync(toolsDir, { recursive: true, force: true });
  unzip(graphvizZip, join(toolsDir, 'graphviz'), 1);
  unzip(tectonicZip, join(toolsDir, 'tectonic'), 0);

  // Writes the plugin registry beside dot.exe; without it dot knows no output formats.
  execFileSync(dot, ['-c'], { stdio: 'inherit' });

  // The first PDF on a machine waits while fontconfig indexes every installed
  // font. Paid here, once, rather than by whoever renders the first diagram.
  log('indexing fonts for graphviz (can take a few minutes the first time)');
  execFileSync(dot, ['-Tpdf'], { input: 'graph { a }', stdio: ['pipe', 'ignore', 'inherit'] });

  log('filling the TeX cache (the one time Tectonic may use the network)');
  const warmDir = join(toolsDir, 'warm-up');
  mkdirSync(warmDir, { recursive: true });
  writeFileSync(join(warmDir, 'warm.tex'), WARM_UP);
  execFileSync(tectonic, ['-X', 'compile', '--untrusted', 'warm.tex'], {
    cwd: warmDir,
    stdio: 'inherit',
    env: { ...process.env, TECTONIC_CACHE_DIR: join(toolsDir, 'tex-cache') },
  });
  rmSync(warmDir, { recursive: true, force: true });

  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        lockHash,
        platform,
        graphviz: entry.graphviz.version,
        tectonic: entry.tectonic.version,
      },
      null,
      2,
    )}\n`,
  );
  log(`installed graphviz ${entry.graphviz.version} + tectonic ${entry.tectonic.version}`);
  log(`lock hash ${lockHash}`);
}

await main();

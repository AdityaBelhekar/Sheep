/**
 * Headless launch check.
 *
 * `SHEEP_SMOKE=1 electron .` boots the real app, waits for every expected check
 * to report, prints the results and exits non-zero if any check failed or never
 * arrived. It is how the roadmap's "the app must launch" rule is verified in a
 * non-interactive session; later phases register further checks.
 */
const TIMEOUT_MS = 30_000;

export const isSmokeRun = process.env['SHEEP_SMOKE'] === '1';

type CheckResult = { ok: boolean; detail?: string };

const expected = new Set<string>();
const results = new Map<string, CheckResult>();

let onFinish: ((exitCode: number) => void) | null = null;
let timer: NodeJS.Timeout | null = null;
let finished = false;

function log(line: string): void {
  process.stdout.write(`sheep-smoke: ${line}\n`);
}

function finish(): void {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);

  let failures = 0;
  for (const name of expected) {
    const result = results.get(name);
    if (!result) {
      failures += 1;
      log(`MISSING ${name}`);
    } else if (!result.ok) {
      failures += 1;
    }
  }
  log(failures === 0 ? 'OK' : `FAILED (${failures})`);
  onFinish?.(failures === 0 ? 0 : 1);
}

/** Declare a check that must report before the smoke run may pass. */
export function expectSmokeCheck(name: string): void {
  if (!isSmokeRun || finished) return;
  expected.add(name);
}

/** Report the outcome of a previously expected check. */
export function recordSmokeCheck(name: string, ok: boolean, detail?: string): void {
  if (!isSmokeRun || finished) return;
  expected.add(name);
  results.set(name, detail === undefined ? { ok } : { ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (expected.size === results.size) finish();
}

/** Start the smoke run's watchdog. Called once, early in main. */
export function beginSmokeRun(quit: (exitCode: number) => void): void {
  if (!isSmokeRun) return;
  onFinish = quit;
  timer = setTimeout(() => {
    log(`TIMEOUT after ${TIMEOUT_MS}ms`);
    finish();
  }, TIMEOUT_MS);
  timer.unref();
}

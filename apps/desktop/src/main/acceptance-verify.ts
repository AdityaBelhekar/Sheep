import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { RenderTools } from '@sheep/artifacts';
import { safeParseDomainEvent, type DomainEvent } from '@sheep/core';
import { reduceProtocol } from '@sheep/orchestrator';
import { buildPaper, bundleFiles, ProvenanceError, zip, type BuiltPaper } from '@sheep/paper';
import {
  exportSession,
  getExecution,
  getSession,
  importSession,
  listParticipants,
  openSheepStore,
  readLedger,
  SESSION_BUNDLE_EXTENSION,
  unzip,
  type SheepStore,
} from '@sheep/store';
import type { IpcResponse } from '@sheep/ipc';
import { readPaperSource, readSessionLog } from './paper-source';

/**
 * Acceptance: what a finished session has to be true of, checked in one place.
 *
 * Each check is one of the things Sheep exists to guarantee, asked of a real
 * session after the fact and answered from its record alone — the log, the
 * ledger, the store. None of them trusts what the session reported about
 * itself while it ran.
 *
 * Electron-free, so the end-to-end test holds a scripted session to exactly
 * the checks a real acceptance run is held to.
 */

export interface AcceptanceCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface AcceptanceReport {
  readonly sessionId: string;
  readonly title: string;
  readonly question: string;
  readonly ok: boolean;
  readonly checks: readonly AcceptanceCheck[];
  readonly spentUsd: number;
  /** Where the paper, the reproduction bundle, the session bundle and this report were written. */
  readonly files: Readonly<Record<'paper' | 'bundle' | 'session' | 'report', string>>;
}

export interface AcceptanceInput {
  readonly store: SheepStore;
  readonly sessionId: string;
  readonly tools: RenderTools;
  /** The interpreter the reproduction script is run with: the bundled one. */
  readonly python: string;
  /** A directory this run owns. Created; its contents are replaced. */
  readonly outDir: string;
  readonly template?: string;
}

const plural = (count: number, one: string): string =>
  `${String(count)} ${one}${count === 1 ? '' : 's'}`;

export async function verifySessionRecord(input: AcceptanceInput): Promise<AcceptanceReport> {
  const { store, sessionId, tools, outDir } = input;
  const session = getSession(store.db, sessionId);
  if (!session) throw new Error(`unknown session: ${sessionId}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const checks: AcceptanceCheck[] = [];
  /** Runs one check. A check that throws has failed, and says what it threw. */
  const check = async (name: string, body: () => Promise<string> | string): Promise<void> => {
    try {
      checks.push({ name, ok: true, detail: await body() });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const require = (condition: boolean, otherwise: string): void => {
    if (!condition) throw new Error(otherwise);
  };

  const events: DomainEvent[] = [];
  for (const record of store.events.stream({ sessionId })) {
    const parsed = safeParseDomainEvent(record.type, record.payload);
    if (parsed.ok) events.push(parsed.event);
  }
  const ledger = readLedger(store.events, sessionId);
  const roster = listParticipants(store.db, sessionId);
  const vendorOf = (participantId: string | null): string | undefined =>
    roster.find((entry) => entry.participantId === participantId)?.model.vendorId;

  await check('protocol', () => {
    const state = reduceProtocol(sessionId, events);
    const unfinished = state.phases.filter((phase) => phase.status !== 'complete');
    require(state.phases.length === 7 &&
      unfinished.length === 0, `the session did not complete all seven phases: ${
      state.phases.map((phase) => `${phase.kind} ${phase.status}`).join(', ') || 'none opened'
    }`);
    const gates = events.filter((event) => event.type === 'phase.gate-resolved').length;
    require(gates ===
      2, `a person decided ${String(gates)} times; the protocol has exactly two gates`);
    return 'seven phases complete; a person decided twice and nothing else waited';
  });

  await check('log', () => {
    const verification = store.events.verify();
    require(verification.ok, `the hash chain is broken at ${String(verification.failures.length)} entries`);
    require(ledger.rejected.length ===
      0, `the ledger refused ${String(ledger.rejected.length)} recorded events`);
    return `hash chain verified over ${String(verification.checked)} entries; the ledger refused nothing`;
  });

  await check('attribution (P1)', () => {
    const disputes = ledger.disputes();
    for (const dispute of disputes) {
      const author = vendorOf(ledger.claim(dispute.claimId).authorParticipantId);
      const critic = vendorOf(dispute.raisedByParticipantId);
      require(author === undefined ||
        critic === undefined ||
        author !== critic, `a ${critic ?? '?'} model critiqued a ${author ?? '?'} model's claim`);
    }
    const vendors = new Set(roster.map((entry) => entry.model.vendorId));
    require(vendors.size >=
      2, `the roster has ${plural(vendors.size, 'vendor')}; critique needs two`);
    return `${plural(disputes.length, 'dispute')}, each raised by a model of a different vendor than the claim's author; ${plural(vendors.size, 'vendor')} on the roster`;
  });

  await check('evidence (P2)', () => {
    const empirical = ledger.claims().filter((claim) => claim.claimType === 'EMPIRICAL');
    for (const claim of empirical) {
      const runs = claim.support.filter((evidence) => evidence.kind === 'EXECUTION');
      require(runs.length > 0, `an empirical claim rests on no run: ${claim.statement}`);
      for (const run of runs) {
        const execution = getExecution(store.db, run.ref);
        require(execution?.status ===
          'ok', `an empirical claim rests on a run that did not succeed`);
        require(store.blobs.has(
          execution?.codeHash ?? '',
        ), 'the code of a run is not in the store');
      }
    }
    require(empirical.length > 0, 'the session recorded no empirical finding');
    return `${plural(empirical.length, 'empirical claim')}, each resting on a recorded run that exited cleanly`;
  });

  await check('disagreement (P6)', () => {
    const open = ledger.disputes().filter((dispute) => dispute.status === 'open');
    require(open.length === 0, `${plural(open.length, 'dispute')} left without an ending`);
    const unresolved = ledger.resolutions().filter((entry) => entry.outcome === 'UNRESOLVED');
    for (const entry of unresolved) {
      require(entry.positions.length >= 2, 'an unresolved dispute does not carry both positions');
    }
    for (const entry of ledger.resolutions().filter((r) => r.outcome !== 'UNRESOLVED')) {
      const dispute = ledger.disputes().find((d) => d.disputeId === entry.disputeId);
      require(dispute?.test?.outcome ===
        entry.outcome, 'a dispute was resolved against its own test');
    }
    return `every dispute ended; ${plural(unresolved.length, 'open question')} kept with both positions; no resolution contradicts its test`;
  });

  const files = {
    paper: join(outDir, 'paper.pdf'),
    bundle: join(outDir, 'reproduction-bundle.zip'),
    session: join(outDir, `session.${SESSION_BUNDLE_EXTENSION}`),
    report: join(outDir, 'report.md'),
  };

  let paper: BuiltPaper | undefined;
  const source = readPaperSource(store, sessionId);
  await check('paper (P5)', async () => {
    const template = input.template ?? 'sheep';
    let note = 'every asserting sentence names a ledger claim';
    try {
      paper = await buildPaper(source, tools, { template });
    } catch (error) {
      if (!(error instanceof ProvenanceError)) throw error;
      // The strict build refusing is the rule working. The paper is then built
      // without those sentences, and says so.
      paper = await buildPaper(source, tools, { template, omitUnprovenanced: true });
      note = `the strict build refused ${plural(error.sentences.length, 'sentence')} that named no claim; compiled without them`;
    }
    writeFileSync(files.paper, paper.pdf);
    return `${plural(paper.document.labels.length, 'claim')} in a ${String(paper.pdf.byteLength)}-byte PDF; ${note}`;
  });

  await check('reproduction bundle', async () => {
    if (!paper) throw new Error('there is no paper to bundle');
    const archive = zip(
      bundleFiles(source, paper.document, paper, paper.build, {
        log: readSessionLog(store, sessionId),
        omitted: paper.omitted,
      }),
    );
    writeFileSync(files.bundle, archive);

    // Unpacked, and its figures deleted: nothing can be compared with itself.
    const dir = join(outDir, 'bundle');
    for (const [path, data] of unzip(archive, { maxEntries: 10_000, maxBytes: 2 ** 30 })) {
      if (path.startsWith('figures/')) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), data);
    }
    const { stdout } = await promisify(execFile)(
      input.python,
      ['reproduce.py', '--dot', tools.dot, '--tectonic', tools.tectonic],
      { cwd: dir, env: { ...process.env, TECTONIC_CACHE_DIR: tools.texCache }, windowsHide: true },
    ).catch((error: { stdout?: string; message: string }) => {
      throw new Error(`reproduce.py reported a failure:\n${error.stdout ?? error.message}`);
    });
    const lines = stdout.split(/\r?\n/).filter((line) => /^[A-Z]+ {2,}figures\//.test(line));
    const count = (word: string): number => lines.filter((line) => line.startsWith(word)).length;
    return lines.length === 0
      ? 'the paper has no figures to redraw'
      : `${plural(count('IDENTICAL'), 'figure')} redrawn from source byte-identical; ${String(count('SKIPPED'))} skipped (Mermaid needs a browser)`;
  });

  await check('portable', () => {
    const bundle = exportSession(store, sessionId);
    writeFileSync(files.session, bundle);
    const elsewhere = openSheepStore({ dataDir: join(outDir, 'imported') });
    try {
      const imported = importSession(elsewhere, bundle);
      const there = readLedger(elsewhere.events, sessionId);
      require(there.rejected.length === 0, 'the ledger refused part of the imported session');
      require(JSON.stringify(there.claims()) ===
        JSON.stringify(ledger.claims()), 'the imported session does not have the same ledger');
      return `exported and imported into an empty store: ${plural(imported.events, 'event')}, ${plural(imported.blobs, 'file')}, the same ledger`;
    } finally {
      elsewhere.close();
      rmSync(join(outDir, 'imported'), { recursive: true, force: true });
    }
  });

  const report: AcceptanceReport = {
    sessionId,
    title: session.title,
    question: session.question,
    ok: checks.every((entry) => entry.ok),
    checks,
    spentUsd: session.budget.spentUsd,
    files,
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    files.report,
    formatReport(
      report,
      roster.map((entry) => `${entry.model.vendorId}/${entry.model.modelId}`),
    ),
  );
  return report;
}

export function formatReport(report: AcceptanceReport, models: readonly string[]): string {
  return [
    `# Sheep acceptance run — ${report.ok ? 'PASSED' : 'FAILED'}`,
    '',
    `- Session: ${report.title} (\`${report.sessionId}\`)`,
    `- Question: ${report.question}`,
    `- Models: ${models.join(', ') || 'none recorded'}`,
    `- Spent: $${report.spentUsd.toFixed(4)}`,
    '',
    '| Check | Result | What was found |',
    '|---|---|---|',
    ...report.checks.map(
      (entry) =>
        `| ${entry.name} | ${entry.ok ? 'pass' : '**FAIL**'} | ${entry.detail.replace(/\r?\n/g, ' ').replaceAll('|', '/')} |`,
    ),
    '',
    'Written beside this report: `paper.pdf`, `reproduction-bundle.zip`,',
    `\`session.${SESSION_BUNDLE_EXTENSION}\` and \`report.json\`.`,
    '',
  ].join('\n');
}

/** A model a saved connection offers, as the roster panel lists it. */
export type OfferedModel = IpcResponse<'sheep:models-list'>['models'][number];

/**
 * Two cloud models from two vendors, and one local model.
 *
 * Named ones when names were given — `connection label/model id`, or just a
 * model id — and otherwise the first model of each of the first two cloud
 * vendors and the first local model. Throws, saying what is missing, when the
 * saved connections cannot supply that.
 */
export function chooseRoster(
  models: readonly OfferedModel[],
  named: readonly string[],
): OfferedModel[] {
  if (named.length > 0) {
    const chosen = named.map((name) => {
      const found = models.find(
        (model) => model.modelId === name || `${model.connectionLabel}/${model.modelId}` === name,
      );
      if (!found) throw new Error(`no saved connection offers a model called "${name}"`);
      return found;
    });
    const vendors = new Set(chosen.map((model) => model.vendorId));
    if (vendors.size < 2)
      throw new Error('the models named are all from one vendor; critique needs two');
    return chosen;
  }

  const cloud: OfferedModel[] = [];
  for (const model of models) {
    if (!model.local && !cloud.some((entry) => entry.vendorId === model.vendorId))
      cloud.push(model);
  }
  const local = models.find((model) => model.local);
  if (cloud.length < 2 || !local) {
    throw new Error(
      `an acceptance run needs two cloud models from different vendors and one local model; the saved connections offer ${String(cloud.length)} cloud vendor(s) and ${local ? 'a' : 'no'} local model. Add connections in the app, or name models with --models.`,
    );
  }
  return [...cloud.slice(0, 2), local];
}

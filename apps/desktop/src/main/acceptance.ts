import { join } from 'node:path';
import { app } from 'electron';
import type { IpcRegistry, IpcRequest, IpcResponse } from '@sheep/ipc';
import type { IpcChannel } from '@sheep/ipc';
import { getTools } from './artifacts';
import { chooseRoster, verifySessionRecord } from './acceptance-verify';
import { getSandbox } from './lab';
import { getStore } from './store';

/**
 * The acceptance run: one real research question, taken end to end on real
 * models, and then held to every check in `acceptance-verify`.
 *
 *   npm run acceptance -- --question "…" [--cap 2] [--models a,b,c] [--dry-run]
 *
 * It runs on the connections already saved in this copy of Sheep. It never
 * sees a key: the keys are in the operating system's credential store, where
 * the app put them when a person typed them in.
 *
 * It drives the session through the same channels the panes do — the same
 * handlers, the same contracts — so what it proves is what the app does. It
 * makes the two decisions the protocol leaves to a person, and makes them the
 * plainest way: it approves the Charter as drafted and pursues the
 * top-ranked hypothesis. Everything else is the protocol's own.
 *
 * `--dry-run` chooses the roster, states the cap, and stops. No model is
 * called and nothing is recorded.
 */

export const isAcceptanceRun = process.env['SHEEP_ACCEPTANCE'] === '1';

function say(line: string): void {
  process.stdout.write(`sheep-acceptance: ${line}\n`);
}

/** How long a whole session may take before the run gives up on it. */
const SESSION_TIMEOUT_MS = 60 * 60 * 1_000;

export async function runAcceptance(registry: IpcRegistry): Promise<number> {
  const call = async <C extends IpcChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>> => (await registry.dispatch(channel, request)) as IpcResponse<C>;

  const question = process.env['SHEEP_ACCEPTANCE_QUESTION']?.trim() ?? '';
  const capUsd = Number(process.env['SHEEP_ACCEPTANCE_CAP'] ?? '2');
  const named = (process.env['SHEEP_ACCEPTANCE_MODELS'] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const dryRun = process.env['SHEEP_ACCEPTANCE_DRY_RUN'] === '1';
  const outDir =
    process.env['SHEEP_ACCEPTANCE_OUT'] ?? join(app.getPath('documents'), 'Sheep acceptance');

  try {
    if (question === '') throw new Error('no question was given; pass --question "…"');
    if (!Number.isFinite(capUsd) || capUsd <= 0)
      throw new Error('--cap must be a positive number of dollars');

    const { models, failures } = await call('sheep:models-list', { refresh: true });
    for (const failure of failures) say(`a connection did not answer: ${failure.detail}`);
    const roster = chooseRoster(models, named);

    say(`question: ${question}`);
    for (const model of roster) {
      say(
        `model: ${model.vendorId}/${model.modelId} via "${model.connectionLabel}"${model.local ? ' (local)' : ''}`,
      );
    }
    say(`spend cap: $${capUsd.toFixed(2)}`);
    say(`output: ${outDir}`);
    if (dryRun) {
      say('dry run: no model was called and nothing was recorded');
      return 0;
    }

    const { sessionId } = await call('sheep:session-create', {
      title: `Acceptance: ${question}`.slice(0, 200),
      question,
    });
    await call('sheep:session-budget-set', { sessionId, capUsd });
    for (const model of roster) {
      await call('sheep:roster-attach', {
        sessionId,
        connectionId: model.connectionId,
        modelId: model.modelId,
        weight: 1,
        budgetCapUsd: null,
        preferredRole: null,
      });
    }
    say(`session ${sessionId}`);

    const deadline = Date.now() + SESSION_TIMEOUT_MS;
    let reply = await call('sheep:protocol-run', { sessionId });
    while (reply.status === 'awaiting-approval') {
      if (Date.now() > deadline) throw new Error('the session did not finish within an hour');
      const waiting = reply.state.phases.find((phase) => phase.gate?.decision === null);
      const gate = waiting?.gate;
      if (!gate) throw new Error('the session is waiting, but not at a gate');
      // The two decisions a person makes, made the plainest way.
      const [top] = gate.options;
      say(`gate: ${gate.gate} — approving${top ? ` "${top.label}"` : ' as drafted'}`);
      reply = await call('sheep:protocol-approve', {
        sessionId,
        gate: gate.gate,
        decision: 'approved',
        ...(top ? { selected: [top.optionId] } : {}),
      });
    }
    say(`protocol ${reply.status}: ${reply.detail}`);

    const report = await verifySessionRecord({
      store: getStore(),
      sessionId,
      tools: getTools(),
      python: getSandbox().runtime.python,
      outDir,
    });
    for (const check of report.checks)
      say(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`);
    say(`spent $${report.spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}`);
    say(`report: ${report.files.report}`);
    say(report.ok ? 'ACCEPTED' : 'NOT ACCEPTED');
    return report.ok ? 0 : 1;
  } catch (error) {
    say(`could not run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

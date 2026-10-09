import {
  domainEvent,
  type Dispute,
  type DisputeOutcome,
  type DomainEvent,
  type EvidenceRef,
  type VerificationStatus,
} from '@sheep/core';
import type { CheckRequest, OrchestratorPorts } from './ports';
import { clip } from './reading';

/**
 * Sending a proposed test to the thing that can decide it (P4).
 *
 * A critic says a claim is wrong and proposes a test. Nobody is then asked
 * whether the critic is right. The test goes to a checker — the sandbox,
 * SymPy, Z3, the statistical audit — by the route the critic named, and what
 * comes back is a verdict no model had a hand in: the test passed, it failed,
 * or it could not be decided. The model's part ended when it wrote the test.
 *
 * Routing is by payload as well as by name. A route with nothing to run — a
 * SANDBOX test with no script — is a description of a test, and goes nowhere.
 */

/** A proposed test's own wall clock. Checks are meant to be quick. */
export const TEST_TIMEOUT_MS = 120_000;

/** What a test script's last printed line must be for its result to count. */
const SENTINEL = /^SHEEP_TEST: (PASS|FAIL)$/;

type Runner = (ports: OrchestratorPorts, sessionId: string) => Promise<Decided>;

interface Decided {
  readonly verdict: VerificationStatus;
  readonly detail: string;
  readonly evidence: EvidenceRef | null;
}

const checked =
  (request: CheckRequest): Runner =>
  async (ports, sessionId) => {
    const result = await ports.check(sessionId, request);
    return { verdict: result.status, detail: result.detail, evidence: result.evidence };
  };

/** How a dispute's test would be run, or null when there is nothing a program can run. */
function runnerFor(dispute: Dispute): Runner | null {
  const test = dispute.proposedTest;
  if (!test) return null;

  if ((test.route === 'SANDBOX' || test.route === 'NUMERIC') && test.code !== undefined) {
    const code = test.code;
    return async (ports, sessionId) => {
      const run = await ports.execute(sessionId, { code, timeoutMs: TEST_TIMEOUT_MS });
      const { execution } = run;
      if (execution.status !== 'ok') {
        const why = clip(run.stderr.trim().split('\n').slice(-6).join('\n'), 1_500);
        return {
          verdict: 'UNCHECKABLE',
          detail: `the test script did not finish cleanly (${execution.status})${why ? `:\n${why}` : ''}`,
          evidence: null,
        };
      }
      const evidence: EvidenceRef = { kind: 'EXECUTION', ref: execution.executionId };
      const last = run.stdout.trimEnd().split('\n').at(-1)?.trim() ?? '';
      const verdict = SENTINEL.exec(last)?.[1] as 'PASS' | 'FAIL' | undefined;
      return verdict === undefined
        ? {
            verdict: 'UNCHECKABLE',
            detail: 'the test script ran but did not end with SHEEP_TEST: PASS or SHEEP_TEST: FAIL',
            evidence,
          }
        : { verdict, detail: `the test script reported ${verdict}`, evidence };
    };
  }
  if (test.route === 'SYMBOLIC' && test.derivation !== undefined) {
    return checked({ kind: 'derivation', derivation: test.derivation });
  }
  if (test.route === 'SMT' && test.constraint !== undefined) {
    return checked({ kind: 'constraint', claim: test.constraint });
  }
  if (test.route === 'STATISTICAL' && test.statistics !== undefined) {
    return checked({ kind: 'statistics', report: test.statistics });
  }
  return null;
}

/** Whether a dispute has a test a program can run and has not yet run. */
export function awaitsRouting(dispute: Dispute): boolean {
  return dispute.status === 'open' && dispute.test === null && runnerFor(dispute) !== null;
}

/**
 * What a verdict means for the dispute.
 *
 * The outcome is the claim's: `OVERTURNED` when the test came out the way the
 * critic said would falsify it, `UPHELD` when the claim survived its test. A
 * test that could not be decided settles nothing, and says so.
 */
export function outcomeOf(
  verdict: VerificationStatus,
  claimFailsIf: 'PASS' | 'FAIL' = 'FAIL',
): DisputeOutcome {
  if (verdict === 'UNCHECKABLE') return 'UNRESOLVED';
  return verdict === claimFailsIf ? 'OVERTURNED' : 'UPHELD';
}

/**
 * Runs one dispute's test and returns the event that records the result.
 *
 * A checker that cannot be reached is not allowed to stop the session: the
 * test is recorded as undecided, with the reason, and the dispute goes on to
 * RESOLUTION as an open question.
 */
export async function routeTest(
  ports: OrchestratorPorts,
  sessionId: string,
  dispute: Dispute,
): Promise<DomainEvent> {
  const runner = runnerFor(dispute);
  const test = dispute.proposedTest;
  if (!runner || !test) throw new Error(`dispute ${dispute.disputeId} has no test to route`);

  let decided: Decided;
  try {
    decided = await runner(ports, sessionId);
  } catch (error) {
    decided = {
      verdict: 'UNCHECKABLE',
      detail: `the test could not be run: ${error instanceof Error ? error.message : String(error)}`,
      evidence: null,
    };
  }

  // A resolution has to cite evidence. A verdict nothing kept a record of
  // cannot be cited, so it cannot be allowed to decide anything.
  if (decided.verdict !== 'UNCHECKABLE' && decided.evidence === null) {
    decided = {
      verdict: 'UNCHECKABLE',
      detail: `the checker answered ${decided.verdict} but kept no record of it: ${decided.detail}`,
      evidence: null,
    };
  }

  return domainEvent('dispute.tested', {
    sessionId,
    disputeId: dispute.disputeId,
    route: test.route,
    verdict: decided.verdict,
    outcome: outcomeOf(decided.verdict, test.claimFailsIf),
    detail: clip(decided.detail, 4_000) || 'no detail was given',
    ...(decided.evidence === null ? {} : { evidence: decided.evidence }),
  });
}

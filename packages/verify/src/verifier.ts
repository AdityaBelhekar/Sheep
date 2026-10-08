// The ambient declaration has to travel with this file into other packages' programs.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./raw.d.ts" />
import {
  constraintVerdictSchema,
  derivationVerdictSchema,
  quantityVerdictSchema,
  stepVerdictSchema,
  type Derivation,
  type ConstraintClaim,
  type ConstraintVerdict,
  type DerivationVerdict,
  type Quantity,
  type QuantityVerdict,
  type StepVerdict,
  type VerificationStatus,
} from '@sheep/core';
import type { Sandbox } from '@sheep/sandbox';
import checkerSource from '../python/checker.py?raw';

/**
 * Verification that is not a model (P4).
 *
 * Every check is a program run in the sandbox on the bundled runtime: SymPy
 * decides whether a step follows, and this class only carries the question in
 * and the findings out. The checker prints a finding the moment it has one, so
 * if it is killed — a simplification that never returns, say — everything it
 * had decided still stands, and whatever it had not reached is reported as
 * UNCHECKABLE with the reason. Nothing is ever assumed to have passed.
 */

/** Long enough for real algebra; a step that needs more is one SymPy cannot do. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface VerifierOptions {
  readonly timeoutMs?: number;
}

type Finding = Record<string, unknown>;

interface Outcome {
  /** Findings per request, in the order they were printed. */
  readonly findings: Finding[][];
  /** Why the checker stopped early, when it did. Null when it finished. */
  readonly stopped: string | null;
}

export class Verifier {
  readonly #sandbox: Sandbox;
  readonly #timeoutMs: number;

  constructor(sandbox: Sandbox, options: VerifierOptions = {}) {
    this.#sandbox = sandbox;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Checks each derivation step by step. One verdict per derivation, in order. */
  async checkDerivations(derivations: readonly Derivation[]): Promise<DerivationVerdict[]> {
    const { findings, stopped } = await this.#run(
      derivations.map((derivation) => ({ kind: 'derivation', derivation })),
    );

    return derivations.map((derivation, index) => {
      const reported = findings[index] ?? [];
      const steps = new Map<string, StepVerdict>();
      const given = new Map<string, DerivationVerdict['given'][number]>();
      for (const finding of reported) {
        const step = stepVerdictSchema.safeParse(finding['step']);
        if (step.success) steps.set(step.data.id, step.data);
        const premise = derivationVerdictSchema.shape.given.element.safeParse(finding['given']);
        if (premise.success) given.set(premise.data.id, premise.data);
      }

      const failure = reported.find((finding) => typeof finding['error'] === 'string');
      const why =
        stopped ??
        (failure
          ? `the checker failed: ${String(failure['error'])}`
          : 'the checker gave no verdict');

      return summarise(
        derivation.given.map(
          (premise) =>
            given.get(premise.id) ?? {
              id: premise.id,
              problem: why,
              latex: null,
              mathml: null,
              dimensions: null,
            },
        ),
        derivation.steps.map(
          (step) =>
            steps.get(step.id) ?? {
              id: step.id,
              status: 'UNCHECKABLE',
              reason: why,
              method: 'none',
              counterexample: null,
              latex: null,
              mathml: null,
              dimensions: null,
            },
        ),
      );
    });
  }

  /**
   * Checks that each reported quantity is the kind of quantity expected of it:
   * that a measured speed is in units of speed, whatever units those are.
   */
  async checkUnits(quantities: readonly Quantity[]): Promise<QuantityVerdict[]> {
    const { findings, stopped } = await this.#run([{ kind: 'units', quantities }]);
    const reported = (findings[0] ?? []).flatMap((finding) => {
      const parsed = quantityVerdictSchema.safeParse(finding['quantity']);
      return parsed.success ? [parsed.data] : [];
    });
    // Answered in order, one per quantity; a missing answer is an undecided one.
    return quantities.map(
      (quantity, index) =>
        reported[index] ?? {
          name: quantity.name,
          status: 'UNCHECKABLE',
          reason: stopped ?? 'the checker gave no verdict',
          factor: null,
        },
    );
  }

  /**
   * Decides logical and constraint claims with an SMT solver. A pass is a
   * proof that no case breaks the claim; a fail carries the case that does.
   */
  async checkConstraints(claims: readonly ConstraintClaim[]): Promise<ConstraintVerdict[]> {
    const { findings, stopped } = await this.#run([{ kind: 'constraints', claims }]);
    const reported = (findings[0] ?? []).flatMap((finding) => {
      const parsed = constraintVerdictSchema.safeParse(finding['constraint']);
      return parsed.success ? [parsed.data] : [];
    });
    return claims.map(
      (claim, index) =>
        reported[index] ?? {
          name: claim.name,
          status: 'UNCHECKABLE',
          reason: stopped ?? 'the checker gave no verdict',
          counterexample: null,
        },
    );
  }

  async #run(requests: readonly unknown[]): Promise<Outcome> {
    const result = await this.#sandbox.run({
      code: checkerSource,
      files: { 'input.json': JSON.stringify({ requests }) },
      limits: { timeoutMs: this.#timeoutMs },
    });
    result.dispose();

    const findings: Finding[][] = requests.map(() => []);
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      try {
        const finding = JSON.parse(line) as Finding;
        findings[finding['request'] as number]?.push(finding);
      } catch {
        // Not a finding. The checker prints nothing else, so nothing is lost.
      }
    }

    const finished = findings.every((reported) =>
      reported.some((finding) => finding['done'] === true || 'error' in finding),
    );
    if (finished) return { findings, stopped: null };

    const lastWords = result.stderr.trim().split('\n').at(-1);
    return {
      findings,
      stopped:
        result.status === 'timeout'
          ? `the checker ran out of time (${String(this.#timeoutMs / 1000)} s) before deciding this`
          : `the checker stopped before deciding this: ${
              result.detail ?? lastWords ?? result.status
            }`,
    };
  }
}

function summarise(
  given: DerivationVerdict['given'],
  steps: DerivationVerdict['steps'],
): DerivationVerdict {
  const count = (status: VerificationStatus): number =>
    steps.filter((step) => step.status === status).length;
  const counts = { pass: count('PASS'), fail: count('FAIL'), uncheckable: count('UNCHECKABLE') };
  return {
    // One failed step fails the derivation; one undecided step keeps it from passing.
    status:
      counts.fail > 0 || given.some((premise) => premise.dimensions?.status === 'FAIL')
        ? 'FAIL'
        : counts.uncheckable > 0
          ? 'UNCHECKABLE'
          : 'PASS',
    counts,
    given,
    steps,
  };
}

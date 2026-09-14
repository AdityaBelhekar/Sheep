/**
 * Blind-parallel execution: the anti-groupthink mechanism (P3).
 *
 * Models converge on whatever they read first. If four models answer in
 * sequence, the fourth is not a fourth opinion — it is a commentary on the
 * first. So every phase opens with a round in which each participant sees the
 * shared brief and nothing else, all of them answer at once, and no output is
 * revealed until every answer is committed.
 *
 * The isolation is structural rather than a matter of care. A participant's
 * prompt is built by `brief()`, which is handed only the shared context and the
 * participant — it has no way to reach another participant's answer, because
 * the answers do not exist in any object it is given. `reveal()` refuses before
 * the round is closed, so a caller cannot read early either.
 *
 * A failed turn does not stop the round: the others' answers were paid for and
 * are still a legitimate independent sample. The failure is reported alongside
 * them and the phase decides whether what survived is enough.
 */

export interface BlindTurnResult<T> {
  readonly participantId: string;
  readonly value: T | null;
  readonly error: Error | null;
}

export class BlindRevealError extends Error {
  constructor(committed: number, total: number) {
    super(
      `blind round is not finished: ${String(committed)} of ${String(total)} participants have committed`,
    );
    this.name = 'BlindRevealError';
  }
}

export interface BlindRoundOptions {
  /** Cap on concurrent calls. Six streams is the roadmap's working number. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

export const DEFAULT_BLIND_CONCURRENCY = 6;

/**
 * Runs one turn per participant with no participant able to see another's.
 *
 * `run` receives only a participant id — everything it needs to build a prompt
 * has to come from the shared context the caller closed over, which is exactly
 * the property that makes the round blind.
 */
export async function runBlindParallel<T>(
  participantIds: readonly string[],
  run: (participantId: string) => Promise<T>,
  options: BlindRoundOptions = {},
): Promise<BlindRoundResult<T>> {
  const limit = Math.max(1, options.concurrency ?? DEFAULT_BLIND_CONCURRENCY);
  const results: BlindTurnResult<T>[] = participantIds.map((participantId) => ({
    participantId,
    value: null,
    error: null,
  }));

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const participantId = participantIds[index];
      if (participantId === undefined) return;

      if (options.signal?.aborted) {
        results[index] = { participantId, value: null, error: new Error('round cancelled') };
        continue;
      }
      try {
        results[index] = { participantId, value: await run(participantId), error: null };
      } catch (error) {
        // Recorded, not thrown: one provider failing must not discard the
        // independent answers the others already produced.
        results[index] = {
          participantId,
          value: null,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, participantIds.length) }, () => worker()));
  return new BlindRoundResult(results);
}

/**
 * The commit-then-reveal half.
 *
 * Holding the results behind a method rather than returning an array is the
 * whole point: a caller that has not waited for every participant cannot read
 * any of them, so "reveal after commit" is enforced by the type rather than by
 * remembering to.
 */
export class BlindRoundResult<T> {
  readonly #results: readonly BlindTurnResult<T>[];

  constructor(results: readonly BlindTurnResult<T>[]) {
    this.#results = results;
  }

  get total(): number {
    return this.#results.length;
  }

  get committed(): number {
    return this.#results.filter((result) => result.value !== null || result.error !== null).length;
  }

  get complete(): boolean {
    return this.committed === this.total;
  }

  get failures(): readonly BlindTurnResult<T>[] {
    return this.#results.filter((result) => result.error !== null);
  }

  /** Every answer, in roster order. Throws while any participant is outstanding. */
  reveal(): readonly BlindTurnResult<T>[] {
    if (!this.complete) throw new BlindRevealError(this.committed, this.total);
    return this.#results;
  }

  /** The answers that arrived, without the failures. */
  answers(): readonly { participantId: string; value: T }[] {
    return this.reveal().flatMap((result) =>
      result.value === null ? [] : [{ participantId: result.participantId, value: result.value }],
    );
  }
}

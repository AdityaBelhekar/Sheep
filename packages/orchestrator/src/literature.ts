import type { PhaseKind, Source } from '@sheep/core';
import { quarantineBlock } from '@sheep/retrieval';
import type { SessionSnapshot } from './ports';
import type { PhaseState } from './state';

/**
 * The one place retrieved literature enters a prompt.
 *
 * There is exactly one, on purpose: every turn goes through the engine's turn
 * runner, the runner calls this, and this hands the text to the quarantine. A
 * phase cannot put a source in front of a model any other way, so there is no
 * prompt in which a source appears unfenced.
 */

/**
 * The phases that read literature: what is already known shapes which
 * hypotheses are worth testing, how to test them, and what to challenge.
 * FRAMING is deliberately blind to it, and the later phases work from the
 * session's own record.
 */
const READS_LITERATURE: ReadonlySet<PhaseKind> = new Set(['HYPOTHESIS', 'METHOD', 'CRITIQUE']);

/** The most sources put in front of a model at once: the most recently retrieved. */
const MAX_SOURCES = 12;

/**
 * The sources a phase may read: those retrieved before it opened.
 *
 * Fixed at the moment the phase opens, so that a search made while a round is
 * in flight does not change the prompt of a turn that is retried — the retry
 * would then be a different request, and be paid for twice.
 */
export function sourcesFor(snapshot: SessionSnapshot, phase: PhaseState): Source[] {
  if (!READS_LITERATURE.has(phase.kind)) return [];
  const sources: Source[] = [];
  for (const event of snapshot.events) {
    if (event.type === 'phase.opened' && event.payload.phaseId === phase.phaseId) break;
    if (event.type === 'retrieval.recorded') sources.push(...event.payload.sources);
  }
  return sources.slice(-MAX_SOURCES);
}

/** A prompt, with the phase's literature appended inside its quarantine. Unchanged when there is none. */
export function withLiterature(
  prompt: string,
  snapshot: SessionSnapshot,
  phase: PhaseState,
): string {
  const block = quarantineBlock(sourcesFor(snapshot, phase));
  return block === '' ? prompt : `${prompt}\n\n${block}`;
}

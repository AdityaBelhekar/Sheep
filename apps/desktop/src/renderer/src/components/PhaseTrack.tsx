import { Fragment, type ReactElement } from 'react';
import { PHASE_KINDS, type PhaseKind } from '@sheep/core';
import type { IpcResponse } from '@sheep/ipc';

export type PhaseView = IpcResponse<'sheep:protocol-state'>['state']['phases'][number];

/** The two phases that end at a gate — the only places a session waits for a person. */
const GATED: readonly PhaseKind[] = ['FRAMING', 'HYPOTHESIS'];

/**
 * The protocol as a track: seven stations, two gates.
 *
 * `mini` drops the names, for the running head, where the track is a glance at
 * where the session is rather than something to read.
 */
export function PhaseTrack({
  phases,
  mini = false,
}: {
  phases: readonly PhaseView[];
  mini?: boolean;
}): ReactElement {
  return (
    <ol className={mini ? 'track track--mini' : 'track'} aria-label="Protocol phases">
      {PHASE_KINDS.map((kind) => {
        const phase = phases.find((candidate) => candidate.kind === kind);
        return (
          <Fragment key={kind}>
            <li
              className="track__phase"
              data-status={phase?.status ?? 'pending'}
              title={describePhase(kind, phase)}
            >
              <span className="track__dot" />
              <span className="track__name">{kind.toLowerCase()}</span>
            </li>
            {GATED.includes(kind) && (
              <li className="track__gate" data-gate={gateState(phase)} title={gateTitle(phase)}>
                <GateIcon />
              </li>
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}

function gateState(phase: PhaseView | undefined): 'shut' | 'waiting' | 'open' {
  if (!phase?.gate) return 'shut';
  if (phase.gate.decision === 'approved') return 'open';
  return phase.gate.decision === null ? 'waiting' : 'shut';
}

function gateTitle(phase: PhaseView | undefined): string {
  const state = gateState(phase);
  if (state === 'open') return 'Gate — you approved this';
  return state === 'waiting'
    ? 'Gate — waiting for your decision'
    : 'Gate — your decision is needed here';
}

function describePhase(kind: string, phase: PhaseView | undefined): string {
  if (!phase) return `${kind} — not started`;
  const rounds = `${String(phase.rounds.length)} round${phase.rounds.length === 1 ? '' : 's'}`;
  return `${kind} — ${phase.status}, ${rounds}${phase.summary === null ? '' : `: ${phase.summary}`}`;
}

/** A field gate: two posts, two rails, one brace. */
function GateIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 14"
      width="14"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 1.5v11M14 1.5v11M2 4.5h12M2 9.5h12M2 9.5l12-5" />
    </svg>
  );
}

import { describe, expect, it } from 'vitest';
import type { ParticipantRole } from '@sheep/core';
import {
  solveRoles,
  UnsatisfiableRolesError,
  violations,
  type RoleDemand,
  type SolveRolesInput,
  type SolverParticipant,
} from './roles';

/**
 * The roadmap's bar for this phase is "property tests prove no assignment ever
 * violates a hard constraint", so the tests are generative rather than a list
 * of cases someone thought of. A hand-written example proves the solver handles
 * the roster its author imagined; a thousand random rosters prove P1 is a
 * property of the solver rather than of the example.
 */

const VENDORS = ['anthropic', 'openai', 'google', 'mistral'] as const;

/** A tiny deterministic PRNG, so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function randomCase(seed: number): SolveRolesInput {
  const next = rng(seed);
  const size = 2 + Math.floor(next() * 6);

  const participants: SolverParticipant[] = Array.from({ length: size }, (_, index) => ({
    participantId: `p${String(index)}`,
    vendorId: VENDORS[Math.floor(next() * VENDORS.length)] ?? 'anthropic',
    // At least one participant is always eligible: a roster of pure
    // observers is a user error, not a solver bug.
    weight: index > 0 && next() < 0.1 ? 0 : 1,
    preferredRole: next() < 0.3 ? 'CRITIC' : null,
  }));

  const authors = participants
    .filter(() => next() < 0.4)
    .map((participant) => participant.participantId);

  const demands: RoleDemand[] = [
    { role: 'PROPOSER', count: 1 },
    { role: 'CRITIC', count: 1, optional: true },
    { role: 'REFEREE', count: 1, optional: true },
    { role: 'DEVIL', count: next() < 0.5 ? 1 : 0, optional: true },
  ];

  return { participants, demands, authors, seed: `seed-${String(seed)}` };
}

describe('solveRoles', () => {
  it('never returns an assignment that breaks a hard constraint', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const input = randomCase(seed);
      const { assignments } = solveRoles(input);
      expect(violations(assignments, input), `seed ${String(seed)}`).toEqual([]);
    }
  });

  it('never assigns a participant two roles, or a zero-weight observer any role', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const input = randomCase(seed);
      const { assignments } = solveRoles(input);
      const ids = assignments.map((entry) => entry.participantId);
      expect(new Set(ids).size).toBe(ids.length);

      const observers = new Set(
        input.participants
          .filter((participant) => participant.weight === 0)
          .map((participant) => participant.participantId),
      );
      expect(ids.filter((id) => observers.has(id))).toEqual([]);
    }
  });

  it('is deterministic: the same input and seed give the same assignment', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const input = randomCase(seed);
      expect(solveRoles(input).assignments).toEqual(solveRoles(input).assignments);
    }
  });

  it('refuses a critic from the author’s vendor rather than producing one (P1)', () => {
    const input: SolveRolesInput = {
      participants: [
        { participantId: 'a', vendorId: 'anthropic' },
        { participantId: 'b', vendorId: 'anthropic' },
      ],
      demands: [{ role: 'CRITIC', count: 1 }],
      authors: ['a'],
    };
    expect(() => solveRoles(input)).toThrow(UnsatisfiableRolesError);
  });

  it('finds the only legal critic when there is exactly one', () => {
    const input: SolveRolesInput = {
      participants: [
        { participantId: 'a', vendorId: 'anthropic' },
        { participantId: 'b', vendorId: 'anthropic' },
        { participantId: 'c', vendorId: 'openai' },
      ],
      demands: [{ role: 'CRITIC', count: 1 }],
      authors: ['a'],
    };
    expect(solveRoles(input).assignments).toEqual([{ participantId: 'c', role: 'CRITIC' }]);
  });

  it('backtracks rather than letting an easy role consume the only legal critic', () => {
    // 'c' is the only participant that may be CRITIC. A greedy pass that filled
    // PROPOSER first could take it and then fail; the search must undo that.
    const input: SolveRolesInput = {
      participants: [
        { participantId: 'a', vendorId: 'anthropic' },
        { participantId: 'c', vendorId: 'openai', preferredRole: 'PROPOSER' },
      ],
      demands: [
        { role: 'PROPOSER', count: 1 },
        { role: 'CRITIC', count: 1 },
      ],
      authors: ['a'],
    };
    const { assignments } = solveRoles(input);
    expect(violations(assignments, input)).toEqual([]);
    expect(assignments).toContainEqual({ participantId: 'c', role: 'CRITIC' });
  });

  it('keeps the referee unstaked', () => {
    const input: SolveRolesInput = {
      participants: [
        { participantId: 'a', vendorId: 'anthropic' },
        { participantId: 'b', vendorId: 'openai' },
        { participantId: 'c', vendorId: 'google' },
      ],
      demands: [
        { role: 'CRITIC', count: 1 },
        { role: 'REFEREE', count: 1 },
      ],
      authors: ['a'],
    };
    const { assignments } = solveRoles(input);
    const referee = assignments.find((entry) => entry.role === 'REFEREE');
    expect(referee?.participantId).not.toBe('a');
    expect(violations(assignments, input)).toEqual([]);
  });

  it('drops an optional role rather than refusing the round', () => {
    const input: SolveRolesInput = {
      participants: [{ participantId: 'a', vendorId: 'anthropic' }],
      demands: [
        { role: 'PROPOSER', count: 1 },
        { role: 'CRITIC', count: 1, optional: true },
      ],
      authors: ['a'],
    };
    const result = solveRoles(input);
    expect(result.assignments).toEqual([{ participantId: 'a', role: 'PROPOSER' }]);
    expect(result.dropped).toEqual(['CRITIC']);
  });

  it('rotates: the model that held a role least often gets it next', () => {
    const participants: SolverParticipant[] = [
      { participantId: 'a', vendorId: 'anthropic' },
      { participantId: 'b', vendorId: 'openai' },
    ];
    const history = { a: { CRITIC: 3 } as Partial<Record<ParticipantRole, number>> };
    const { assignments } = solveRoles({
      participants,
      demands: [{ role: 'CRITIC', count: 1 }],
      history,
    });
    expect(assignments).toEqual([{ participantId: 'b', role: 'CRITIC' }]);
  });

  it('honours preferredRole only when it is legal', () => {
    const input: SolveRolesInput = {
      participants: [
        { participantId: 'a', vendorId: 'anthropic', preferredRole: 'CRITIC' },
        { participantId: 'b', vendorId: 'openai' },
      ],
      demands: [{ role: 'CRITIC', count: 1 }],
      authors: ['a'],
    };
    // 'a' asked for CRITIC and authored the material, so it does not get it.
    expect(solveRoles(input).assignments).toEqual([{ participantId: 'b', role: 'CRITIC' }]);
  });
});

describe('violations', () => {
  it('names every rule it catches', () => {
    const input: SolveRolesInput = {
      participants: [
        { participantId: 'a', vendorId: 'anthropic' },
        { participantId: 'b', vendorId: 'anthropic' },
      ],
      demands: [],
      authors: ['a'],
    };
    const problems = violations(
      [
        { participantId: 'a', role: 'CRITIC' },
        { participantId: 'a', role: 'REFEREE' },
        { participantId: 'b', role: 'CRITIC' },
      ],
      input,
    );
    expect(problems.join(' | ')).toContain('its own material');
    expect(problems.join(' | ')).toContain('shares vendor anthropic');
    expect(problems.join(' | ')).toContain('more than one role');
    expect(problems.join(' | ')).toContain('is staked');
  });
});

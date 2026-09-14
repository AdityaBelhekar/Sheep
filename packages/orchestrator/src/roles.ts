import type { ParticipantRole, RoleAssignment, VendorId } from '@sheep/core';
import type { RoleTally } from './state';

/**
 * Who holds which role for one round.
 *
 * This is where P1 stops being a slogan. "Attribution is physical" means a
 * critique is only worth recording if it came from a different set of weights
 * than the claim it attacks — so the solver refuses, rather than prefers, an
 * assignment that lets a vendor mark its own homework.
 *
 * Four hard constraints. None of them is negotiable, and `violations()` below
 * is the single definition of all four, so the property tests check the same
 * rules the solver enforces rather than a paraphrase of them:
 *
 * 1. **One role per participant per round.** A model arguing both sides is not
 *    two opinions.
 * 2. **No self-critique.** A CRITIC or DEVIL is never an author of the material
 *    under review.
 * 3. **Critic vendor ≠ author vendor.** The same company's weights, under a
 *    different participant id, are still the same company's weights.
 * 4. **The referee is unstaked.** A REFEREE authored none of the material and
 *    holds no other role in the round.
 *
 * Everything else — rotation, the user's `preferredRole`, weight — is a
 * preference, applied only to choose between assignments that are all legal.
 *
 * Search is plain backtracking over the demanded roles, most-constrained first.
 * A roster is a handful of models, so the cost is irrelevant and the guarantee
 * is what matters: if a legal assignment exists, it is found, and one that is
 * not legal is never returned.
 */

export interface SolverParticipant {
  readonly participantId: string;
  readonly vendorId: VendorId;
  /** Relative say. 0 makes an observer, which the solver leaves unassigned. */
  readonly weight?: number;
  readonly preferredRole?: ParticipantRole | null;
}

export interface RoleDemand {
  readonly role: ParticipantRole;
  /** How many participants must hold it. */
  readonly count: number;
  /**
   * Whether the round can proceed without it.
   *
   * An optional demand is dropped when no legal candidate exists — a two-model
   * roster has no spare body for a DEVIL, and refusing to run at all would be
   * worse than running without one.
   */
  readonly optional?: boolean;
}

export interface SolveRolesInput {
  readonly participants: readonly SolverParticipant[];
  readonly demands: readonly RoleDemand[];
  /** Participants that authored the material under review this round. */
  readonly authors?: readonly string[];
  /** Vendors staked in that material — usually the authors', plus any inherited. */
  readonly authorVendors?: readonly VendorId[];
  /** Roles each participant has already held, for rotation. */
  readonly history?: Readonly<Record<string, RoleTally>>;
  /** Makes tie-breaks deterministic and replayable. */
  readonly seed?: string;
}

export class UnsatisfiableRolesError extends Error {
  constructor(
    readonly detail: string,
    readonly unmet: readonly ParticipantRole[],
  ) {
    super(`no legal role assignment: ${detail}`);
    this.name = 'UnsatisfiableRolesError';
  }
}

/** Roles that stake their holder in the round's argument. */
const STAKED_ROLES: ReadonlySet<ParticipantRole> = new Set<ParticipantRole>([
  'PROPOSER',
  'CRITIC',
  'DEVIL',
]);

/**
 * Every hard constraint one assignment breaks.
 *
 * The solver calls this to prune, and the property tests call it to judge. One
 * definition, so a rule cannot be enforced in one place and forgotten in the
 * other.
 */
export function violations(
  assignments: readonly RoleAssignment[],
  input: SolveRolesInput,
): string[] {
  const vendorOf = new Map(input.participants.map((p) => [p.participantId, p.vendorId]));
  const authors = new Set(input.authors ?? []);
  const authorVendors = new Set<VendorId>([
    ...(input.authorVendors ?? []),
    ...[...authors].flatMap((id) => {
      const vendor = vendorOf.get(id);
      return vendor === undefined ? [] : [vendor];
    }),
  ]);

  const problems: string[] = [];
  const seen = new Set<string>();

  for (const { participantId, role } of assignments) {
    const vendor = vendorOf.get(participantId);
    if (vendor === undefined) {
      problems.push(`${participantId} is not on this roster`);
      continue;
    }
    if (seen.has(participantId)) {
      problems.push(`${participantId} holds more than one role`);
    }
    seen.add(participantId);

    if ((role === 'CRITIC' || role === 'DEVIL') && authors.has(participantId)) {
      problems.push(`${participantId} would be ${role} of its own material`);
    }
    if (role === 'CRITIC' && authorVendors.has(vendor)) {
      problems.push(`CRITIC ${participantId} shares vendor ${vendor} with the author`);
    }
    if (role === 'REFEREE' && authors.has(participantId)) {
      problems.push(`REFEREE ${participantId} is staked: it authored material under review`);
    }
  }

  // The referee holding a second role is a per-round property, so it is checked
  // over the whole assignment rather than per entry.
  const referees = assignments.filter((entry) => entry.role === 'REFEREE');
  for (const referee of referees) {
    const alsoStaked = assignments.some(
      (entry) => entry.participantId === referee.participantId && STAKED_ROLES.has(entry.role),
    );
    if (alsoStaked) problems.push(`REFEREE ${referee.participantId} also holds a staked role`);
  }

  return problems;
}

export interface SolveRolesResult {
  readonly assignments: readonly RoleAssignment[];
  /** Optional demands that had no legal candidate, so were dropped. */
  readonly dropped: readonly ParticipantRole[];
}

/**
 * Solves one round's roles, or throws if a required role cannot be filled
 * legally. Deterministic for a given input and seed.
 */
export function solveRoles(input: SolveRolesInput): SolveRolesResult {
  const slots = expandDemands(input.demands);
  const dropped: ParticipantRole[] = [];

  // Required slots first: an optional DEVIL must never consume the only model
  // that could legally have been the CRITIC.
  const ordered = [...slots].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return constraintRank(a.role) - constraintRank(b.role);
  });

  const eligible = input.participants.filter((p) => (p.weight ?? 1) > 0);
  const assigned: RoleAssignment[] = [];
  const taken = new Set<string>();

  const place = (index: number): boolean => {
    if (index >= ordered.length) return true;
    const slot = ordered[index];
    if (!slot) return true;

    for (const candidate of rank(eligible, slot.role, input, taken)) {
      const attempt = [...assigned, { participantId: candidate.participantId, role: slot.role }];
      if (violations(attempt, input).length > 0) continue;

      assigned.push({ participantId: candidate.participantId, role: slot.role });
      taken.add(candidate.participantId);
      if (place(index + 1)) return true;
      assigned.pop();
      taken.delete(candidate.participantId);
    }

    if (!slot.required) {
      dropped.push(slot.role);
      return place(index + 1);
    }
    return false;
  };

  if (!place(0)) {
    const unmet = ordered.filter((slot) => slot.required).map((slot) => slot.role);
    throw new UnsatisfiableRolesError(
      `${String(eligible.length)} eligible participant(s) cannot fill ${describe(input.demands)} ` +
        `without breaking a hard constraint`,
      [...new Set(unmet)],
    );
  }

  // Stable output order, so two replays of the same round record byte-identical
  // events — which is what makes a golden replay comparable at all.
  const assignments = [...assigned].sort(
    (a, b) =>
      constraintRank(a.role) - constraintRank(b.role) ||
      a.participantId.localeCompare(b.participantId),
  );
  return { assignments, dropped };
}

interface Slot {
  readonly role: ParticipantRole;
  readonly required: boolean;
}

function expandDemands(demands: readonly RoleDemand[]): Slot[] {
  const slots: Slot[] = [];
  for (const demand of demands) {
    for (let i = 0; i < demand.count; i += 1) {
      slots.push({ role: demand.role, required: demand.optional !== true });
    }
  }
  return slots;
}

/** How hard a role is to fill: the most constrained are placed first. */
function constraintRank(role: ParticipantRole): number {
  switch (role) {
    case 'REFEREE':
      return 0;
    case 'CRITIC':
      return 1;
    case 'DEVIL':
      return 2;
    case 'VERIFIER':
      return 3;
    case 'PROPOSER':
      return 4;
    case 'SCRIBE':
      return 5;
  }
}

/**
 * Candidates for one slot, best first.
 *
 * Preferences only. Every candidate returned here is still checked against
 * `violations` before it is accepted, so no amount of preference can talk the
 * solver into an illegal assignment.
 */
function rank(
  participants: readonly SolverParticipant[],
  role: ParticipantRole,
  input: SolveRolesInput,
  taken: ReadonlySet<string>,
): SolverParticipant[] {
  const history = input.history ?? {};
  const seed = input.seed ?? '';

  return participants
    .filter((participant) => !taken.has(participant.participantId))
    .map((participant) => {
      const tally = history[participant.participantId] ?? {};
      const timesInRole = tally[role] ?? 0;
      const timesOverall = Object.values(tally).reduce<number>((sum, n) => sum + (n ?? 0), 0);
      return {
        participant,
        // Lower is better: the user's preference wins, then whoever has held
        // this role least, then whoever has held fewest roles at all.
        score: [
          participant.preferredRole === role ? 0 : 1,
          timesInRole,
          timesOverall,
          -(participant.weight ?? 1),
        ] as const,
        tie: tieBreak(seed, participant.participantId, role),
      };
    })
    .sort((a, b) => {
      for (let i = 0; i < a.score.length; i += 1) {
        const difference = (a.score[i] ?? 0) - (b.score[i] ?? 0);
        if (difference !== 0) return difference;
      }
      return a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0;
    })
    .map((entry) => entry.participant);
}

/** A cheap deterministic hash. Only ever decides ties between equal candidates. */
function tieBreak(seed: string, participantId: string, role: string): number {
  const text = `${seed}:${participantId}:${role}`;
  let hash = 2_166_136_261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

function describe(demands: readonly RoleDemand[]): string {
  return demands
    .map((demand) => `${String(demand.count)}×${demand.role}${demand.optional ? '?' : ''}`)
    .join(' + ');
}

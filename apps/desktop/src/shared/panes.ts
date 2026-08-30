/**
 * The work surfaces.
 *
 * Two groups. `RESEARCH_PANES` is the seven a session moves through, in order.
 * `UTILITY_PANES` is app configuration — real surfaces, but not steps in a
 * research session, and separated in the navigation so the seven stay seven.
 *
 * These lists are the only place panes are declared: the navigation, the
 * router's notion of a valid route, and the smoke run's navigability check all
 * read them, so a pane cannot exist in one and be missing from another.
 *
 * Each stub says which phase fills it in. A pane that claims to be empty on
 * purpose is more useful than one that looks broken.
 */
export interface PaneDefinition {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  /** What will live here, and what it is for. */
  readonly detail: string;
  /** The roadmap phase that builds it out. */
  readonly arriving: string;
}

export const RESEARCH_PANES = [
  {
    id: 'sessions',
    label: 'Sessions',
    summary: 'Every research session, and the roster of models attached to it.',
    detail:
      'A session is one question, one roster and one event stream. This list is read from the sessions projection — rows rebuilt by replaying the event log, never written to directly.',
    arriving: 'Roster editing arrives in Phase 19',
  },
  {
    id: 'conversation',
    label: 'Conversation',
    summary: 'The turns themselves: proposals, critiques, referee rulings.',
    detail:
      'Phases open blind-parallel, so a model cannot see another model’s answer before committing its own. This surface shows what each said, once revealing is allowed.',
    arriving: 'Blind-parallel rounds arrive in Phase 25',
  },
  {
    id: 'ledger',
    label: 'Ledger',
    summary: 'Claims, evidence and disputes as a navigable graph.',
    detail:
      'Every claim is typed — DERIVED, EMPIRICAL, CITED or CONJECTURE — and an empirical claim with no execution record behind it cannot be recorded at all.',
    arriving: 'Phases 30 to 35',
  },
  {
    id: 'lab',
    label: 'Lab',
    summary: 'Code, runs and artifacts from the sandboxed Python runtime.',
    detail:
      'Bundled CPython under a Windows Job Object: capped memory, capped CPU, wall-clock timeout, no network. Results are hashed artifacts rather than model assertions.',
    arriving: 'Phases 36 to 42',
  },
  {
    id: 'verification',
    label: 'Verification',
    summary: 'Derivations checked step by step, and honestly labelled when they cannot be.',
    detail:
      'SymPy, pint and Z3 do the checking; a language model only routes a question to a checker. A step that cannot be verified is marked UNCHECKABLE rather than quietly assumed.',
    arriving: 'Phases 43 to 48',
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    summary: 'Figures, diagrams and files, each traceable to what produced it.',
    detail:
      'Every artifact keeps its generating source, so deleting a figure and regenerating it yields a byte-identical file. Content-addressed storage is already in place beneath this.',
    arriving: 'Phases 55 to 59',
  },
  {
    id: 'paper',
    label: 'Paper',
    summary: 'The compiled research record, with its provenance appendix.',
    detail:
      'A claim-bearing sentence with no ledger id fails the build. The emitted bundle reproduces every figure from scratch, or it is not a reproduction.',
    arriving: 'Phases 60 to 65',
  },
] as const satisfies readonly PaneDefinition[];

export const UTILITY_PANES = [
  {
    id: 'connections',
    label: 'Connections',
    summary: 'Providers Sheep can reach, and whether each one is answering.',
    detail:
      'A connection is configuration, not history: keys live in the OS credential store and only a reference is written down, so a connection can be renamed or deleted without disturbing the provenance of anything it produced.',
    arriving: 'Roster attachment arrives in Phase 19',
  },
] as const satisfies readonly PaneDefinition[];

export const PANES = [...RESEARCH_PANES, ...UTILITY_PANES] as const;

export type PaneId = (typeof PANES)[number]['id'];

export const PANE_IDS: readonly PaneId[] = PANES.map((pane) => pane.id);

export const DEFAULT_PANE: PaneId = PANES[0].id;

export function isPaneId(value: string): value is PaneId {
  return (PANE_IDS as readonly string[]).includes(value);
}

export function paneById(id: PaneId): PaneDefinition {
  const pane = PANES.find((candidate) => candidate.id === id);
  if (!pane) throw new Error(`unknown pane: ${id}`);
  return pane;
}

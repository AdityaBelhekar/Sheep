/**
 * The work surfaces.
 *
 * Three groups. `HOME_PANE` is where the app opens: start a session, or pick up
 * an old one. `RESEARCH_PANES` is the seven a session moves through, in order.
 * `UTILITY_PANES` is app configuration — real surfaces, but not steps in a
 * research session, and separated in the navigation so the seven stay seven.
 *
 * These lists are the only place panes are declared: the navigation, the
 * router's notion of a valid route, and the smoke run's navigability check all
 * read them, so a pane cannot exist in one and be missing from another.
 */
export interface PaneDefinition {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
}

export const HOME_PANE = {
  id: 'home',
  label: 'Home',
  summary: 'Start a session, or pick up an old one.',
} as const satisfies PaneDefinition;

export const RESEARCH_PANES = [
  {
    id: 'sessions',
    label: 'Sessions',
    summary: 'Every research question, and the models attached to it.',
  },
  {
    id: 'conversation',
    label: 'Conversation',
    summary: 'The protocol, round by round, with one lane per model.',
  },
  {
    id: 'ledger',
    label: 'Ledger',
    summary: 'Every claim, and what it rests on.',
  },
  {
    id: 'lab',
    label: 'Lab',
    summary: 'Python in the sandbox. Every run is recorded.',
  },
  {
    id: 'verification',
    label: 'Verification',
    summary: 'Derivations checked step by step.',
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    summary: 'Figures, diagrams and formulas, with what made them.',
  },
  {
    id: 'paper',
    label: 'Paper',
    summary: 'The compiled record, and its reproduction bundle.',
  },
] as const satisfies readonly PaneDefinition[];

export const UTILITY_PANES = [
  {
    id: 'connections',
    label: 'Connections',
    summary: 'The model providers Sheep can reach.',
  },
] as const satisfies readonly PaneDefinition[];

export const PANES = [HOME_PANE, ...RESEARCH_PANES, ...UTILITY_PANES] as const;

export type PaneId = (typeof PANES)[number]['id'];

export const PANE_IDS: readonly PaneId[] = PANES.map((pane) => pane.id);

export const DEFAULT_PANE: PaneId = HOME_PANE.id;

export function isPaneId(value: string): value is PaneId {
  return (PANE_IDS as readonly string[]).includes(value);
}

export function paneById(id: PaneId): PaneDefinition {
  const pane = PANES.find((candidate) => candidate.id === id);
  if (!pane) throw new Error(`unknown pane: ${id}`);
  return pane;
}

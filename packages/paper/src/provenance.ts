import type { Block, Fact, PaperDocument, PaperSource, Section, Sentence } from './ir';

/**
 * Provenance: the rule a paper is held to, and the appendix that lets a reader
 * hold it to more.
 *
 * The rule is one sentence long. A sentence in which the paper asserts
 * something must name a claim in the ledger, and a paper containing one that
 * does not is not compiled (P5). It is checked on the document, before any
 * LaTeX exists, so there is no template and no code path that gets a PDF out
 * of an unprovenanced sentence.
 */

/** An asserting sentence with no ledger claim behind it, and where it is. */
export interface Unprovenanced {
  readonly section: string;
  readonly text: string;
  /** Why: it names no claim, or names one the ledger does not hold. */
  readonly reason: string;
}

export class ProvenanceError extends Error {
  constructor(readonly sentences: readonly Unprovenanced[]) {
    super(
      `${String(sentences.length)} sentence(s) assert something with no ledger claim behind them:\n` +
        sentences.map((entry) => `  [${entry.section}] ${entry.text} — ${entry.reason}`).join('\n'),
    );
    this.name = 'ProvenanceError';
  }
}

const problemWith = (sentence: Sentence, known: ReadonlySet<string>): string | null => {
  if (!sentence.asserts) return null;
  if (sentence.claimIds.length === 0) return 'it names no claim in the ledger';
  const unknown = sentence.claimIds.find((claimId) => !known.has(claimId));
  return unknown === undefined ? null : `claim ${unknown} is not in the ledger`;
};

const sentencesOfBlock = (block: Block): readonly Sentence[] =>
  block.kind === 'paragraph' ? block.sentences : [];

/**
 * Every sentence the paper asserts without a ledger claim behind it.
 *
 * `known` is the set of claim ids the document itself declares, which a
 * builder fills from the ledger. A finding stated under an id the document
 * does not declare is caught the same way.
 */
export function unprovenanced(document: PaperDocument): Unprovenanced[] {
  const known = new Set(document.labels.map((entry) => entry.claimId));
  const found: Unprovenanced[] = [];
  const check = (section: string, sentences: readonly Sentence[]): void => {
    for (const sentence of sentences) {
      const reason = problemWith(sentence, known);
      if (reason !== null) found.push({ section, text: sentence.text, reason });
    }
  };

  check('Abstract', document.abstract);
  for (const section of [...document.sections, ...document.appendix]) {
    for (const block of section.blocks) {
      check(section.title, sentencesOfBlock(block));
      if (block.kind === 'finding' && !known.has(block.claimId)) {
        found.push({
          section: section.title,
          text: block.statement,
          reason: `claim ${block.claimId} is not in the ledger`,
        });
      }
    }
  }
  return found;
}

/** Throws `ProvenanceError` unless every asserting sentence names a ledger claim. */
export function assertProvenanced(document: PaperDocument): void {
  const sentences = unprovenanced(document);
  if (sentences.length > 0) throw new ProvenanceError(sentences);
}

/**
 * The document with its unprovenanced sentences left out.
 *
 * The other honest answer to a sentence with nothing behind it: not to print
 * it. What was left out is returned, so that it can be counted in the paper
 * and listed beside it; nothing is dropped quietly.
 */
export function withoutUnprovenanced(document: PaperDocument): {
  document: PaperDocument;
  omitted: Unprovenanced[];
} {
  const known = new Set(document.labels.map((entry) => entry.claimId));
  const keep = (sentence: Sentence): boolean => problemWith(sentence, known) === null;
  const strip = (section: Section): Section => ({
    ...section,
    blocks: section.blocks
      .map((block) =>
        block.kind === 'paragraph' ? { ...block, sentences: block.sentences.filter(keep) } : block,
      )
      .filter(
        (block) =>
          (block.kind !== 'paragraph' || block.sentences.length > 0) &&
          (block.kind !== 'finding' || known.has(block.claimId)),
      ),
  });
  return {
    omitted: unprovenanced(document),
    document: {
      ...document,
      abstract: document.abstract.filter(keep),
      sections: document.sections.map(strip),
      appendix: document.appendix.map(strip),
    },
  };
}

/** What compiled the paper, for the appendix to state. */
export interface BuildFacts {
  readonly template: string;
  /** The engine, with its version. */
  readonly engine: string;
  /** Identifies the rendering tools exactly. */
  readonly toolsLockHash: string;
  /** Asserting sentences left out because they named no claim. */
  readonly omitted: number;
}

const usd = (amount: number): string => `$${amount.toFixed(4)}`;

/**
 * The provenance appendix: everything needed to check the paper against the
 * session it came from, and to run the session's computations again.
 *
 * Who took part and what each cost, every run with its seed and the lock of
 * the environment it ran in, every artifact with the hash of its source and
 * of each rendering, and the head of the event log the paper was read from —
 * the one hash that covers all the rest.
 */
export function provenanceAppendix(source: PaperSource, build: BuildFacts): Section[] {
  const turnsOf = (participantId: string) =>
    source.messages.filter(
      (message) =>
        message.author.kind === 'MODEL' && message.author.participantId === participantId,
    );

  const record: Fact[] = [
    { term: 'Session', value: source.sessionId, mono: true },
    { term: 'Events in the session', value: String(source.events.length) },
    ...(source.head
      ? [
          { term: 'Event-log head', value: `entry ${String(source.head.seq)}` },
          { term: 'Root hash', value: source.head.entryHash, mono: true },
        ]
      : [{ term: 'Event log', value: 'empty' }]),
    { term: 'Template', value: build.template },
    { term: 'Typeset by', value: build.engine },
    { term: 'Tools lock', value: build.toolsLockHash, mono: true },
    ...(build.omitted === 0
      ? []
      : [
          {
            term: 'Left out',
            value: `${String(build.omitted)} sentence(s) of the synthesis named no finding in the ledger and are not printed`,
          },
        ]),
  ];

  const participants: Block[] = source.roster.map((entry) => {
    const turns = turnsOf(entry.participantId);
    const sum = (pick: (usage: NonNullable<(typeof turns)[number]['usage']>) => number): number =>
      turns.reduce((total, turn) => total + (turn.usage ? pick(turn.usage) : 0), 0);
    const priced = turns.filter((turn) => turn.usage !== null).length;
    const params = [
      ...new Set(
        turns.flatMap((turn) =>
          turn.params
            ? [
                `max ${String(turn.params.maxOutputTokens)} output tokens` +
                  (turn.params.temperature === undefined
                    ? ', provider default temperature'
                    : `, temperature ${String(turn.params.temperature)}`),
              ]
            : [],
        ),
      ),
    ];
    return {
      kind: 'facts',
      title: `${entry.model.vendorId}/${entry.model.modelId}`,
      facts: [
        { term: 'Participant', value: entry.participantId, mono: true },
        { term: 'Version', value: entry.model.version ?? 'not reported by the provider' },
        { term: 'Turns', value: String(turns.length) },
        {
          term: 'Tokens',
          value: `${String(sum((usage) => usage.inputTokens))} in, ${String(sum((usage) => usage.outputTokens))} out`,
        },
        {
          term: 'Cost',
          value:
            priced === 0
              ? 'not recorded'
              : `${usd(sum((usage) => usage.costUsd))} over ${String(priced)} priced turn(s)`,
        },
        { term: 'Parameters', value: params.join('; ') || 'not recorded' },
      ],
    };
  });

  const runs: Block[] = source.executions.toReversed().map((execution) => ({
    kind: 'facts',
    title: `Run ${execution.executionId.slice(0, 8)}`,
    facts: [
      { term: 'Execution', value: execution.executionId, mono: true },
      { term: 'Outcome', value: `${execution.status}, exit code ${String(execution.exitCode)}` },
      { term: 'Seed', value: String(execution.seed) },
      { term: 'Code', value: execution.codeHash, mono: true },
      { term: 'Environment lock', value: execution.envLockHash, mono: true },
      { term: 'Output', value: execution.stdoutHash, mono: true },
    ],
  }));

  const derivations: Block[] = source.derivations.toReversed().map((derivation) => ({
    kind: 'facts',
    title: `Derivation ${derivation.derivationId.slice(0, 8)}`,
    facts: [
      { term: 'Derivation', value: derivation.derivationId, mono: true },
      {
        term: 'Verdict',
        value: `${derivation.status}: ${String(derivation.counts.pass)} pass, ${String(derivation.counts.fail)} fail, ${String(derivation.counts.uncheckable)} uncheckable`,
      },
      { term: 'Body', value: derivation.bodyHash, mono: true },
      { term: 'Environment lock', value: derivation.envLockHash, mono: true },
    ],
  }));

  const artifacts: Block[] = source.artifacts.toReversed().map(({ record: artifact }) => ({
    kind: 'facts',
    title: `${artifact.title} (${artifact.kind})`,
    facts: [
      { term: 'Artifact', value: artifact.artifactId, mono: true },
      { term: 'Rendered by', value: artifact.toolchain },
      { term: 'Source', value: artifact.sourceHash, mono: true },
      ...artifact.outputs.map((output) => ({ term: output.path, value: output.hash, mono: true })),
    ],
  }));

  const intro = (text: string): Block => ({
    kind: 'paragraph',
    sentences: [{ text, asserts: false, claimIds: [] }],
  });
  const section = (id: string, title: string, lead: string, blocks: Block[]): Section[] =>
    blocks.length === 0 ? [] : [{ id, title, blocks: [intro(lead), ...blocks] }];

  return [
    {
      id: 'provenance',
      title: 'Provenance',
      blocks: [
        intro(
          'This paper was compiled from an append-only, hash-chained event log. The root hash below is the hash of its last entry when the paper was read from it, and covers every entry before it; a session that replays to the same hash is the same session.',
        ),
        { kind: 'facts', facts: record },
      ],
    },
    ...section(
      'provenance-participants',
      'Participants',
      'Every model that sat on the roster, with what it was asked and what it cost.',
      participants,
    ),
    ...section(
      'provenance-runs',
      'Sandbox Runs',
      'Every run of the session, whether it succeeded or not. A run is repeated by executing the code at its hash with its seed, in the environment its lock names.',
      runs,
    ),
    ...section(
      'provenance-derivations',
      'Checked Derivations',
      'Every derivation a checker was given, with the verdict it returned.',
      derivations,
    ),
    ...section(
      'provenance-artifacts',
      'Artifacts',
      'Every figure and diagram of the session, including those not placed in this paper, each with the hash of its source and of every rendering.',
      artifacts,
    ),
  ];
}

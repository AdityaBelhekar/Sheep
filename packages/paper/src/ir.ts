import { createHash } from 'node:crypto';
import type {
  ArtifactRecord,
  Claim,
  DerivationRecord,
  Dispute,
  DomainEvent,
  ExecutionRecord,
  Ledger,
  Message,
  PhaseKind,
  RosterEntry,
} from '@sheep/core';
import {
  charterOf,
  claimsOfPhase,
  finalMethod,
  reduceProtocol,
  turnsOf,
  type LabelledClaim,
  type PhaseState,
  type SessionSnapshot,
} from '@sheep/orchestrator';

/**
 * The paper, before it is LaTeX.
 *
 * A session's record is a ledger and a log; a paper is sections and sentences.
 * This is the step between: a document described as data, with no markup in
 * it, which any template can typeset and which can be checked before anything
 * is typeset at all.
 *
 * The one distinction it exists to carry is between two kinds of sentence. A
 * sentence that *asserts* something is the paper speaking, and must name the
 * claim in the ledger it rests on. Everything else is either the record quoted
 * verbatim — the question, the Charter, a critic's argument — and attributed
 * to whoever wrote it, or the connective wording Sheep itself supplies. A
 * paper built this way cannot say more than its ledger does (P5).
 */

export interface Sentence {
  readonly text: string;
  /** True when this is the paper making a claim, rather than framing or quoting one. */
  readonly asserts: boolean;
  /** The ledger claims it rests on. An asserting sentence with none is unprovenanced. */
  readonly claimIds: readonly string[];
}

export interface Fact {
  readonly term: string;
  readonly value: string;
  /** Set in a fixed-width face: an id, a hash. */
  readonly mono?: boolean;
}

export type Block =
  | { readonly kind: 'paragraph'; readonly lead?: string; readonly sentences: readonly Sentence[] }
  /** The record, verbatim, and who wrote it. */
  | { readonly kind: 'quote'; readonly text: string; readonly attribution: string }
  /** One claim from the ledger, with the status the evidence gave it. */
  | {
      readonly kind: 'finding';
      readonly label: string;
      readonly claimId: string;
      readonly claimType: Claim['claimType'];
      readonly status: Claim['status'];
      readonly statement: string;
    }
  | {
      readonly kind: 'figure';
      readonly artifactId: string;
      /** Where the emitter will find it, relative to the document. */
      readonly file: string;
      readonly hash: string;
      readonly title: string;
      /** Labels of the claims it supports. */
      readonly labels: readonly string[];
    }
  | { readonly kind: 'code'; readonly caption: string; readonly text: string }
  | { readonly kind: 'facts'; readonly title?: string; readonly facts: readonly Fact[] };

export interface Section {
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly Block[];
}

export interface PaperDocument {
  readonly sessionId: string;
  readonly title: string;
  readonly question: string;
  /** The models that took part. They are participants, and are listed as such. */
  readonly authors: readonly { readonly name: string; readonly detail: string }[];
  readonly abstract: readonly Sentence[];
  readonly sections: readonly Section[];
  readonly appendix: readonly Section[];
  /** What a `[n]` in the text refers to: a citation a CITED claim rests on. */
  readonly references: readonly string[];
  /** Every claim the paper names, by the label it is named with. */
  readonly labels: readonly { readonly label: string; readonly claimId: string }[];
}

/** Everything a paper is built from. Plain data and two readers, so this package opens no database. */
export interface PaperSource {
  readonly sessionId: string;
  readonly title: string;
  readonly question: string;
  /** Everyone who ever sat on the roster, so a detached author can still be named. */
  readonly roster: readonly RosterEntry[];
  /** The session's events, in chain order. */
  readonly events: readonly DomainEvent[];
  readonly ledger: Ledger;
  /** Each artifact, and the claims that rest on it. */
  readonly artifacts: readonly {
    readonly record: ArtifactRecord;
    readonly claimIds: readonly string[];
  }[];
  readonly executions: readonly ExecutionRecord[];
  readonly derivations: readonly DerivationRecord[];
  readonly messages: readonly Message[];
  /** The last entry of the event log when the record was read; null for an empty log. */
  readonly head: { readonly seq: number; readonly entryHash: string } | null;
  /** Reads a blob the session holds. */
  read(hash: string): Uint8Array;
}

const frame = (text: string): Sentence => ({ text, asserts: false, claimIds: [] });

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** Splits prose into sentences. Good enough for what a scribe writes; nothing here depends on it being perfect. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z([])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/** The labels a sentence cites: `C2`, `H1`. */
export function labelsIn(text: string): string[] {
  return [...new Set(text.match(/\b[HCN]\d+\b/g) ?? [])];
}

const SYNTHESIS_HEADINGS = ['ANSWER', 'WHAT STANDS', 'WHAT WAS REFUTED', 'OPEN QUESTIONS'];

/**
 * The scribe's account, as paragraphs of asserting sentences.
 *
 * The scribe was told to refer to findings by their labels. Each sentence is
 * tied to the claims whose labels it cites; a sentence that cites none is kept
 * here with nothing behind it, which is exactly what the build refuses.
 */
function synthesisBlocks(text: string, claimOf: ReadonlyMap<string, string>): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/^[#*\s]+/, '').trim();
    if (trimmed === '') continue;
    const heading = SYNTHESIS_HEADINGS.find((candidate) =>
      trimmed.toUpperCase().startsWith(candidate),
    );
    const body = heading
      ? trimmed
          .slice(heading.length)
          .replace(/^[\s*:—–-]+/, '')
          .trim()
      : trimmed;
    const sentences = sentencesOf(body).map((sentence): Sentence => ({
      text: sentence,
      asserts: true,
      claimIds: labelsIn(sentence).flatMap((label) => claimOf.get(label) ?? []),
    }));
    if (heading) {
      const lead = heading.charAt(0) + heading.slice(1).toLowerCase();
      blocks.push({ kind: 'paragraph', lead, sentences });
    } else if (sentences.length > 0) {
      blocks.push({ kind: 'paragraph', sentences });
    }
  }
  return blocks.filter((block) => block.kind !== 'paragraph' || block.sentences.length > 0);
}

const STATUS_WORDS: Readonly<Record<Claim['status'], string>> = {
  asserted: 'asserted, not yet tested',
  supported: 'supported',
  disputed: 'under dispute',
  refuted: 'refuted',
  unresolved: 'left with an open question',
  withdrawn: 'withdrawn',
};

/** What a rendering is included as. LaTeX takes a PDF or a PNG, and nothing else here. */
function printable(record: ArtifactRecord): ArtifactRecord['outputs'][number] | undefined {
  return (
    record.outputs.find((output) => output.path.toLowerCase().endsWith('.pdf')) ??
    record.outputs.find((output) => output.path.toLowerCase().endsWith('.png'))
  );
}

/**
 * Builds the document from the record.
 *
 * Reads only what is passed in and decides nothing: every status shown is the
 * ledger's, every quotation is from the log, and a session that stopped early
 * gets a shorter paper that says where it stopped.
 */
export function buildDocument(source: PaperSource): PaperDocument {
  const { ledger } = source;
  const snapshot: SessionSnapshot = {
    sessionId: source.sessionId,
    title: source.title,
    question: source.question,
    status: 'complete',
    budget: { capUsd: null, spentUsd: 0 },
    roster: source.roster,
    events: source.events,
  };
  const state = reduceProtocol(source.sessionId, source.events);
  const done = (kind: PhaseKind): PhaseState | undefined =>
    state.phases.find((phase) => phase.kind === kind && phase.status === 'complete');

  const who = (participantId: string | null): string => {
    if (participantId === null) return 'a person';
    const entry = source.roster.find((candidate) => candidate.participantId === participantId);
    return entry ? `${entry.model.vendorId}/${entry.model.modelId}` : 'a model no longer listed';
  };

  // --- labels: what each claim is called, here and in the scribe's account.
  const labelled = (kind: PhaseKind, prefix: string): LabelledClaim[] => {
    const phase = done(kind);
    return phase ? claimsOfPhase(snapshot, phase, prefix) : [];
  };
  const hypotheses = labelled('HYPOTHESIS', 'H');
  const findings = labelled('EXECUTION', 'C');
  const named = new Set([...hypotheses, ...findings].map((entry) => entry.claim.claimId));
  const others: LabelledClaim[] = ledger
    .claims()
    .filter((claim) => !named.has(claim.claimId))
    .map((claim, index) => ({ label: `N${String(index + 1)}`, claim }));
  const everyClaim = [...hypotheses, ...findings, ...others];
  const labelOf = new Map(everyClaim.map((entry) => [entry.claim.claimId, entry.label]));
  const claimOf = new Map(everyClaim.map((entry) => [entry.label, entry.claim.claimId]));

  // --- figures: every artifact a claim rests on that LaTeX can include.
  const figuresOf = new Map<string, Block[]>();
  let figureCount = 0;
  for (const { record, claimIds } of source.artifacts.toReversed()) {
    const output = printable(record);
    const [first] = claimIds;
    if (!output || first === undefined) continue;
    figureCount += 1;
    const extension = output.path.slice(output.path.lastIndexOf('.'));
    figuresOf.set(first, [
      ...(figuresOf.get(first) ?? []),
      {
        kind: 'figure',
        artifactId: record.artifactId,
        file: `figures/figure-${String(figureCount)}${extension.toLowerCase()}`,
        hash: output.hash,
        title: record.title,
        labels: claimIds.flatMap((claimId) => labelOf.get(claimId) ?? []),
      },
    ]);
  }

  const references: string[] = [];
  const cite = (ref: string): number => {
    if (!references.includes(ref)) references.push(ref);
    return references.indexOf(ref) + 1;
  };

  /** A claim as the paper states it: the statement, its status, what it rests on, its figures. */
  const claimBlocks = (entry: LabelledClaim): Block[] => {
    const claim = ledger.claim(entry.claim.claimId);
    const basis = claim.support.map((evidence): string => {
      switch (evidence.kind) {
        case 'EXECUTION':
          return `sandbox run ${evidence.ref.slice(0, 8)}`;
        case 'DERIVATION':
          return `checked derivation ${evidence.ref.slice(0, 8)}`;
        case 'CITATION':
          return `reference [${String(cite(evidence.ref))}]`;
        case 'ARTIFACT':
          return `artifact ${evidence.ref.slice(0, 8)}`;
        case 'CLAIM':
          return `claim ${labelOf.get(evidence.ref) ?? evidence.ref.slice(0, 8)}`;
        case 'ARGUMENT':
          return 'argument only';
      }
    });
    return [
      {
        kind: 'finding',
        label: entry.label,
        claimId: claim.claimId,
        claimType: claim.claimType,
        status: claim.status,
        statement: claim.statement,
      },
      {
        kind: 'paragraph',
        sentences: [
          frame(
            `Asserted by ${who(claim.authorParticipantId)}. ` +
              (basis.length > 0
                ? `Rests on: ${basis.join('; ')}.`
                : 'Nothing was offered in support of it.'),
          ),
        ],
      },
      ...(figuresOf.get(claim.claimId) ?? []),
    ];
  };

  /** A dispute as it happened: the challenge, the test, and how it ended. */
  const disputeBlocks = (dispute: Dispute): Block[] => {
    const resolution = ledger.resolutions().find((entry) => entry.disputeId === dispute.disputeId);
    const blocks: Block[] = [
      {
        kind: 'paragraph',
        sentences: [
          frame(
            `${labelOf.get(dispute.claimId) ?? 'A claim'} was challenged on ${dispute.axis
              .toLowerCase()
              .replaceAll(
                '_',
                ' ',
              )} (${dispute.severity}) by ${who(dispute.raisedByParticipantId)}:`,
          ),
        ],
      },
      { kind: 'quote', text: dispute.argument, attribution: who(dispute.raisedByParticipantId) },
    ];
    if (dispute.test) {
      blocks.push({
        kind: 'paragraph',
        sentences: [
          frame(
            `The proposed test was sent to a checker (${dispute.test.route.toLowerCase()}), which returned ${dispute.test.verdict}:`,
          ),
        ],
      });
      blocks.push({ kind: 'quote', text: dispute.test.detail, attribution: 'the checker' });
    }
    if (dispute.status === 'withdrawn') {
      blocks.push({
        kind: 'paragraph',
        sentences: [frame('The critic withdrew the challenge.')],
      });
    } else if (!resolution) {
      blocks.push({
        kind: 'paragraph',
        sentences: [frame('The challenge was still open when this record was compiled.')],
      });
    } else {
      const outcome =
        resolution.outcome === 'UPHELD'
          ? 'The claim survived the challenge.'
          : resolution.outcome === 'UNRESOLVED'
            ? 'No test discriminated between the two positions. The dispute is unresolved, and both positions are given as they were stated.'
            : 'The claim was refuted.';
      blocks.push({ kind: 'paragraph', sentences: [frame(outcome)] });
      // Where a test decided, the test is the account. Positions are given in
      // full only where nothing else could be: on a question left open.
      for (const position of resolution.outcome === 'UNRESOLVED' ? resolution.positions : []) {
        blocks.push({
          kind: 'quote',
          text: position.rationale ?? '(no rationale was given)',
          attribution: `${who(position.participantId)}, ${position.stance.toLowerCase()}, confidence ${position.confidence.toFixed(2)}`,
        });
      }
      blocks.push({
        kind: 'quote',
        text: resolution.rationale,
        attribution: `the referee, ${who(resolution.resolvedByParticipantId)} — a rationale, which decided nothing`,
      });
    }
    return blocks;
  };

  const sections: Section[] = [];

  // --- 1. the question and the charter
  const questionBlocks: Block[] = [
    {
      kind: 'paragraph',
      sentences: [
        frame('This record answers one question, fixed before any model was asked anything:'),
      ],
    },
    { kind: 'quote', text: source.question, attribution: 'the research question' },
  ];
  try {
    const charter = charterOf(snapshot);
    const approved = done('FRAMING') !== undefined;
    questionBlocks.push(
      {
        kind: 'paragraph',
        sentences: [
          frame(
            approved
              ? 'Each model first stated the problem independently and blind to the others. A referee drafted this Charter from those statements, and a person approved it:'
              : 'A referee drafted this Charter. It had not been approved when this record was compiled:',
          ),
        ],
      },
      { kind: 'quote', text: charter, attribution: 'the Charter' },
    );
  } catch {
    questionBlocks.push({
      kind: 'paragraph',
      sentences: [frame('The session had not drafted a Charter when this record was compiled.')],
    });
  }
  sections.push({ id: 'question', title: 'Question', blocks: questionBlocks });

  // --- 2. hypotheses
  if (hypotheses.length > 0) {
    sections.push({
      id: 'hypotheses',
      title: 'Hypotheses',
      blocks: [
        {
          kind: 'paragraph',
          sentences: [
            frame(
              'Hypotheses were generated blind and in parallel, scored blind, and selected by a person. These were pursued:',
            ),
          ],
        },
        ...hypotheses.flatMap(claimBlocks),
      ],
    });
  }

  // --- 3. method
  const methodPhase = done('METHOD');
  if (methodPhase) {
    const blocks: Block[] = [];
    try {
      const method = finalMethod(snapshot, methodPhase);
      const codeHash = createHash('sha256').update(method.code).digest('hex');
      const run = source.executions.find(
        (execution) => execution.codeHash === codeHash && execution.seed === method.seed,
      );
      blocks.push(
        {
          kind: 'paragraph',
          sentences: [
            frame(
              `The method below is ${who(method.authorId)}'s, as it stood after critique from models of other vendors.`,
            ),
          ],
        },
        { kind: 'quote', text: method.plan, attribution: `${who(method.authorId)}, the plan` },
        {
          kind: 'quote',
          text: method.analysis,
          attribution: `${who(method.authorId)}, the analysis`,
        },
        {
          kind: 'code',
          caption: `The script, exactly as run (seed ${String(method.seed)})`,
          text: method.code,
        },
      );
      if (run) {
        blocks.push({
          kind: 'facts',
          title: 'The run',
          facts: [
            { term: 'Execution', value: run.executionId, mono: true },
            { term: 'Outcome', value: `${run.status}, exit code ${String(run.exitCode)}` },
            { term: 'Seed', value: String(run.seed) },
            { term: 'Environment lock', value: run.envLockHash, mono: true },
            { term: 'Output', value: run.stdoutHash, mono: true },
          ],
        });
      }
    } catch {
      blocks.push({
        kind: 'paragraph',
        sentences: [frame('The METHOD phase closed without a method that could be read.')],
      });
    }
    sections.push({ id: 'method', title: 'Method', blocks });
  }

  // --- 4. findings, and what was raised against them
  if (findings.length > 0) {
    sections.push({
      id: 'findings',
      title: 'Findings',
      blocks: [
        {
          kind: 'paragraph',
          sentences: [
            frame(
              'Each finding is stated as it was recorded, with the status the evidence gave it. A finding could be recorded only if a sandbox run or a checked derivation stood behind it.',
            ),
          ],
        },
        ...findings.flatMap((entry) => [
          ...claimBlocks(entry),
          ...ledger
            .disputesOf(entry.claim.claimId)
            .filter((dispute) => {
              const resolution = ledger
                .resolutions()
                .find((candidate) => candidate.disputeId === dispute.disputeId);
              return resolution?.outcome !== 'UNRESOLVED';
            })
            .flatMap(disputeBlocks),
        ]),
      ],
    });
  }

  // --- 5. open questions (P6): disagreement is output
  const unresolved = ledger.disputes().filter((dispute) => {
    const resolution = ledger
      .resolutions()
      .find((candidate) => candidate.disputeId === dispute.disputeId);
    return resolution?.outcome === 'UNRESOLVED';
  });
  if (unresolved.length > 0) {
    sections.push({
      id: 'open-questions',
      title: 'Open Questions',
      blocks: [
        {
          kind: 'paragraph',
          sentences: [
            frame(
              'These disputes ended without evidence that could decide them. They are results of the session, not omissions from it, and nobody was asked to settle by argument what could not be settled by a test.',
            ),
          ],
        },
        ...unresolved.flatMap(disputeBlocks),
      ],
    });
  }

  // --- 6. anything recorded outside the protocol
  if (others.length > 0) {
    sections.push({
      id: 'other-claims',
      title: 'Other Recorded Claims',
      blocks: [
        {
          kind: 'paragraph',
          sentences: [frame('These claims were recorded in the session outside the phases above.')],
        },
        ...others.flatMap(claimBlocks),
      ],
    });
  }

  // --- 7. the scribe's account
  const synthesisPhase = done('SYNTHESIS');
  const scribe = synthesisPhase?.rounds
    .flatMap((round) => turnsOf(source.events, round.roundId))
    .findLast((turn) => turn.role === 'SCRIBE');
  if (scribe) {
    sections.push({
      id: 'synthesis',
      title: 'Synthesis',
      blocks: [
        {
          kind: 'paragraph',
          sentences: [
            frame(
              `Written by ${who(scribe.participantId)} from the ledger above. Each sentence is tied to the findings it names.`,
            ),
          ],
        },
        ...synthesisBlocks(scribe.text, claimOf),
      ],
    });
  }

  // --- abstract: what the record contains, counted
  const count = (status: Claim['status']): number =>
    findings.filter((entry) => ledger.claim(entry.claim.claimId).status === status).length;
  const vendors = new Set(source.roster.map((entry) => entry.model.vendorId));
  const reached = [...state.phases].reverse().find((phase) => phase.status === 'complete');
  const abstract: Sentence[] = [
    frame(`This is the record of one research session on the question: ${source.question}`),
    frame(
      `${plural(source.roster.length, 'model')} from ${plural(vendors.size, 'vendor')} took part, each critiqued only by models of a different vendor.`,
    ),
    frame(
      findings.length === 0
        ? `No finding had been recorded when it was compiled; the last phase completed was ${reached?.kind ?? 'none'}.`
        : `Of ${plural(findings.length, 'finding')}, ${String(count('supported'))} ${count('supported') === 1 ? 'is' : 'are'} supported, ${String(count('refuted'))} refuted and ${String(count('unresolved'))} left with an open question.`,
    ),
    frame(
      'Every finding rests on a recorded sandbox run or a checked derivation, and every status was given by evidence rather than by a model.',
    ),
  ];

  return {
    sessionId: source.sessionId,
    title: source.title,
    question: source.question,
    authors: source.roster.map((entry) => ({
      name: `${entry.model.vendorId}/${entry.model.modelId}`,
      detail: entry.model.version ?? 'version not reported',
    })),
    abstract,
    sections,
    appendix: [],
    references,
    labels: everyClaim.map((entry) => ({ label: entry.label, claimId: entry.claim.claimId })),
  };
}

export { STATUS_WORDS };

/** Every figure the document includes, in order. */
export function figuresIn(document: PaperDocument): Extract<Block, { kind: 'figure' }>[] {
  return [...document.sections, ...document.appendix].flatMap((section) =>
    section.blocks.filter((block) => block.kind === 'figure'),
  );
}

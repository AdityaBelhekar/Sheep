import { z } from 'zod';

/**
 * What the models are actually told.
 *
 * Kept in one file, apart from the engine, for a reason that outlives tidiness:
 * a prompt is an experimental instrument. When a session's results look
 * different from last month's, the first question is whether the instrument
 * changed — and that question is only answerable if every word a model was
 * given lives somewhere a diff can show.
 *
 * Two rules run through all of them. Models are told to state uncertainty
 * rather than smooth it over, because a confident wrong statement is the
 * expensive failure. And they are never told what the other models said before
 * they have committed their own answer (P3) — the blind rounds below take a
 * question and nothing else.
 */

export const BASE_SYSTEM =
  'You are one participant in a multi-model research session run by Sheep. ' +
  'Other models, from other vendors, are working the same problem independently ' +
  'and will critique your output. Be specific and falsifiable. State plainly what ' +
  'you are uncertain about instead of smoothing over it, and never assert an ' +
  'empirical result you have not seen produced by an execution.';

export function systemFor(role: string): string {
  return `${BASE_SYSTEM}\n\nYour role this round: ${role}.`;
}

// ---------------------------------------------------------------------------
// FRAMING
// ---------------------------------------------------------------------------

/** Blind: the question, and deliberately nothing else. */
export function framingStatementPrompt(question: string): string {
  return [
    'A research question has been proposed:',
    '',
    question,
    '',
    'Working alone, write the problem statement you think this question should be',
    'turned into. Cover, in prose and in this order:',
    '',
    '1. What is actually being asked, restated precisely.',
    '2. The scope: what is in, and what is explicitly out.',
    '3. What would count as an answer, and how it could be checked.',
    '4. The assumptions your framing depends on, and which of them you are least',
    '   confident about.',
    '',
    'Under 400 words. No preamble, no restating these instructions.',
  ].join('\n');
}

/** Sequential: the referee sees the deduplicated statements and drafts a charter. */
export function charterPrompt(
  question: string,
  clusters: readonly { label: string; support: number; text: string }[],
  revisionNote?: string,
): string {
  const lines = [
    'You are the REFEREE. The research question is:',
    '',
    question,
    '',
    'The other participants framed it independently, without seeing each other.',
    'Their statements have been grouped; a group backed by several participants is',
    'agreement, and a group of one is a minority view that must not be quietly dropped.',
    '',
  ];

  clusters.forEach((cluster, index) => {
    lines.push(
      `--- Framing ${String(index + 1)} (${String(cluster.support)} participant(s)) ---`,
      cluster.text,
      '',
    );
  });

  if (revisionNote !== undefined) {
    lines.push(
      'A previous charter draft was rejected by the human running this session, who said:',
      '',
      revisionNote,
      '',
      'Address that directly in this draft.',
      '',
    );
  }

  lines.push(
    'Draft the Charter for this session. Write it as prose under these headings:',
    '',
    'QUESTION — the question this session will answer, stated in one sentence.',
    'SCOPE — what is in and what is out.',
    'SUCCESS CRITERIA — what would settle the question, and how it would be checked.',
    'ASSUMPTIONS — what is being taken for granted.',
    'OPEN DISAGREEMENTS — where the framings conflicted, preserved rather than resolved.',
    '',
    'You arbitrate framing; you do not decide the answer. Where the participants',
    'disagreed on substance, record the disagreement instead of picking a side.',
    'Under 600 words.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HYPOTHESIS
// ---------------------------------------------------------------------------

export const HYPOTHESES_PER_MODEL = 3;

/** Blind: charter only. No participant sees another's hypotheses. */
export function hypothesisPrompt(charter: string, count = HYPOTHESES_PER_MODEL): string {
  return [
    'The Charter for this session, approved by the human running it:',
    '',
    charter,
    '',
    `Working alone, propose ${String(count)} candidate hypotheses that this session could test.`,
    'Each must be falsifiable: there must be a concrete result that would make it wrong.',
    'Prefer hypotheses that can be settled by computation or derivation over ones that',
    'would need resources this session does not have.',
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"hypotheses":[{"label":"one sentence, under 200 characters",',
    '"detail":"what it claims, how it could be tested, and what would falsify it"}]}',
  ].join('\n');
}

/** Blind scoring: every participant scores every candidate, unaware of others' scores. */
export function hypothesisScoringPrompt(
  charter: string,
  candidates: readonly { id: string; label: string; detail: string }[],
): string {
  const lines = [
    'The Charter for this session:',
    '',
    charter,
    '',
    'These candidate hypotheses were proposed independently by the participants,',
    'then grouped. Score each one. You are scoring blind: no other participant’s',
    'scores are available to you, and yours will not be shown to them.',
    '',
  ];

  for (const candidate of candidates) {
    lines.push(`[${candidate.id}] ${candidate.label}`, candidate.detail, '');
  }

  lines.push(
    'Score each on three axes, each from 0 to 1:',
    '',
    'testability — can it actually be falsified with computation or derivation?',
    'novelty — would settling it tell anyone something they did not already know?',
    'feasibility — can it be settled within one session, with no new data collection?',
    '',
    'Score your own proposals by the same standard you apply to everyone else’s.',
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"scores":[{"id":"H1","testability":0.0,"novelty":0.0,"feasibility":0.0,',
    '"note":"one sentence"}]}',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parsing what comes back
// ---------------------------------------------------------------------------

export const hypothesisListSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        label: z.string().min(1).max(400),
        detail: z.string().min(1).max(4_000).optional(),
      }),
    )
    .min(1),
});

export const hypothesisScoresSchema = z.object({
  scores: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        testability: z.number().min(0).max(1),
        novelty: z.number().min(0).max(1),
        feasibility: z.number().min(0).max(1),
        note: z.string().max(1_000).optional(),
      }),
    )
    .min(1),
});

export class ModelOutputError extends Error {
  constructor(
    readonly participantId: string,
    detail: string,
  ) {
    super(`unusable model output from ${participantId}: ${detail}`);
    this.name = 'ModelOutputError';
  }
}

/**
 * Pulls a JSON object out of a model's reply.
 *
 * Models fence JSON, apologise before it, and add a sentence after it, however
 * plainly they are asked not to. Refusing those replies would throw away turns
 * that were paid for and did contain the answer, so the first balanced `{…}`
 * span is extracted and parsed. A reply with no object at all is still an
 * error — recovering from *that* would mean inventing data.
 */
export function parseJsonReply<T>(text: string, schema: z.ZodType<T>, participantId: string): T {
  const candidate = extractJsonObject(text);
  if (candidate === null) {
    throw new ModelOutputError(participantId, 'the reply contained no JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new ModelOutputError(
      participantId,
      `the JSON did not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ModelOutputError(
      participantId,
      result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }
  return result.data;
}

/** The first balanced brace span, ignoring braces inside strings. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

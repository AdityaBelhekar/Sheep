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
// METHOD
// ---------------------------------------------------------------------------

/** What a hypothesis or claim is called in a prompt, with what it says. */
export interface PromptClaim {
  readonly label: string;
  readonly claim: { readonly statement: string };
}

const listClaims = (claims: readonly PromptClaim[]): string[] =>
  claims.map((entry) => `[${entry.label}] ${entry.claim.statement}`);

/** What a script may and may not do. Stated once, wherever a model writes code. */
export const SANDBOX_RULES = [
  'The script runs in a sandbox, and these are facts about it, not requests:',
  '- Python 3.12 with numpy, scipy, pandas, scikit-learn, matplotlib, sympy and networkx.',
  '- No network, no subprocesses, and no file access outside the working directory.',
  '- Memory and wall-clock time are capped; it is killed when it exceeds either.',
  '- It is seeded, so the same script gives the same output on every run.',
  '- No data files are provided. Anything it analyses, it must generate or compute.',
  '- Every number you will later want to state as a result must be printed.',
  '- Figures are saved with plt.savefig("name.png"); there is no display.',
].join('\n');

/**
 * The six axes a method is attacked along.
 *
 * Fixed, so that two critics' objections are comparable and so that none of
 * the six can be skipped by a critic who would rather discuss something else.
 */
export const METHOD_AXES = [
  'INTERNAL_VALIDITY',
  'CONFOUNDS',
  'LEAKAGE',
  'POWER',
  'BASELINES',
  'REPRODUCIBILITY',
] as const;

const AXIS_QUESTIONS: Readonly<Record<(typeof METHOD_AXES)[number], string>> = {
  INTERNAL_VALIDITY: 'does the script measure what the plan says it measures?',
  CONFOUNDS: 'could something other than the hypothesised cause produce the result?',
  LEAKAGE: 'does information reach the test that should not — tuning on test data, peeking?',
  POWER: 'is there enough data, and enough repetition, to detect the effect at all?',
  BASELINES: 'is the result compared with the obvious alternative, and a trivial one?',
  REPRODUCIBILITY: 'would the same script give the same answer again, anywhere?',
};

export interface MethodDraft {
  readonly plan: string;
  readonly analysis: string;
  readonly code: string;
}

export interface MethodCritique {
  readonly axis: (typeof METHOD_AXES)[number];
  readonly severity: 'blocking' | 'major' | 'minor';
  readonly argument: string;
}

/**
 * Sequential: one proposer drafts the method, or revises its own.
 *
 * A revision is shown what happened when the previous draft was actually run
 * — not a description of what might happen — and every critique of it.
 */
export function methodPrompt(
  charter: string,
  hypotheses: readonly PromptClaim[],
  revision?: {
    readonly previous: MethodDraft | null;
    readonly report: string;
    readonly critiques: readonly MethodCritique[];
  },
): string {
  const lines = [
    'The Charter for this session:',
    '',
    charter,
    '',
    'The hypotheses the human running it selected to test:',
    '',
    ...listClaims(hypotheses),
    '',
    SANDBOX_RULES,
    '',
  ];

  if (revision === undefined) {
    lines.push('Design the method that will test them, and write the script that carries it out.');
  } else {
    if (revision.previous !== null) {
      lines.push(
        'Your previous method:',
        '',
        revision.previous.plan,
        '',
        '```python',
        revision.previous.code.trimEnd(),
        '```',
        '',
      );
    }
    lines.push('What happened when it was run in the sandbox:', '', revision.report, '');
    if (revision.critiques.length > 0) {
      lines.push('Models from other vendors critiqued it independently:', '');
      for (const critique of revision.critiques) {
        lines.push(`- ${critique.axis} (${critique.severity}): ${critique.argument}`);
      }
      lines.push('');
    }
    lines.push(
      'Revise the method. Fix what failed, and answer each critique by changing the',
      'method or by saying in the plan why it does not apply. Reply with the whole',
      'method again, not a patch.',
    );
  }

  lines.push(
    '',
    'Reply with one JSON object, then the complete script in one fenced python block:',
    '',
    '{"plan":"what will be done and why it tests the hypotheses",',
    '"analysis":"for each hypothesis, what printed result would support it and what would refute it",',
    '"seed":0}',
    '',
    '```python',
    '# the whole script',
    '```',
  );
  return lines.join('\n');
}

/** Blind: each critic sees the method and its smoke run, and no other critique. */
export function methodCritiquePrompt(
  charter: string,
  hypotheses: readonly PromptClaim[],
  method: MethodDraft,
  report: string,
): string {
  return [
    'The Charter for this session:',
    '',
    charter,
    '',
    'The hypotheses under test:',
    '',
    ...listClaims(hypotheses),
    '',
    'Another participant, from a different vendor, proposed this method:',
    '',
    method.plan,
    '',
    'How it says the results should be read:',
    '',
    method.analysis,
    '',
    '```python',
    method.code.trimEnd(),
    '```',
    '',
    'What happened when the script was smoke-run in the sandbox:',
    '',
    report,
    '',
    'Critique the method before it is run in full. You are working blind: no other',
    'critic’s view is available to you. Consider each of these axes in turn:',
    '',
    ...METHOD_AXES.map((axis) => `${axis} — ${AXIS_QUESTIONS[axis]}`),
    '',
    'Raise a critique only where you can say specifically what is wrong and what',
    'would fix it. An axis with no problem gets no entry; an empty list is an honest',
    'answer when the method is sound.',
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"critiques":[{"axis":"CONFOUNDS","severity":"blocking|major|minor",',
    '"argument":"what is wrong and what would fix it"}]}',
  ].join('\n');
}

export const methodSchema = z.object({
  plan: z.string().min(1).max(8_000),
  analysis: z.string().min(1).max(8_000),
  seed: z.number().int().min(0).max(0xffff_ffff).optional(),
  /** Accepted when a model inlines the script instead of fencing it. */
  code: z.string().max(200_000).optional(),
});

export const methodCritiquesSchema = z.object({
  critiques: z
    .array(
      z.object({
        axis: z.enum(METHOD_AXES),
        severity: z.enum(['blocking', 'major', 'minor']),
        argument: z.string().min(1).max(4_000),
      }),
    )
    .max(12),
});

// ---------------------------------------------------------------------------
// EXECUTION
// ---------------------------------------------------------------------------

/** How much of a run's output a prompt carries. The whole of it is in the store. */
const OUTPUT_IN_PROMPT = 16_000;

const clipOutput = (text: string): string =>
  text.length <= OUTPUT_IN_PROMPT
    ? text
    : `${text.slice(0, OUTPUT_IN_PROMPT)}\n[… ${String(text.length - OUTPUT_IN_PROMPT)} more characters not shown]`;

export interface PromptRun {
  readonly stdout: string;
  readonly execution: { readonly artifacts: readonly { readonly path: string }[] };
}

/** Sequential: the method's author reads its output and states what it found. */
export function findingsPrompt(
  charter: string,
  hypotheses: readonly PromptClaim[],
  method: MethodDraft,
  run: PromptRun,
): string {
  const artifacts = run.execution.artifacts.map((artifact) => artifact.path);
  return [
    'The Charter for this session:',
    '',
    charter,
    '',
    'The hypotheses under test:',
    '',
    ...listClaims(hypotheses),
    '',
    'Your method, as it was run:',
    '',
    method.plan,
    '',
    'How you said the results should be read:',
    '',
    method.analysis,
    '',
    'The script ran to completion in the sandbox. Everything it printed:',
    '',
    '--- output ---',
    clipOutput(run.stdout.trimEnd()),
    '--- end of output ---',
    '',
    artifacts.length === 0
      ? 'It saved no files.'
      : `It saved these files: ${artifacts.join(', ')}.`,
    '',
    'State what the run found, as separate findings. Two kinds:',
    '',
    'EMPIRICAL — read directly off the output above. Quote figures exactly as',
    'printed. A figure that does not appear in the output was not measured, and a',
    'finding that quotes one will be refused.',
    'CONJECTURE — what you think the output means beyond what it shows. Labelled',
    'as conjecture because that is what it is.',
    '',
    'If the output refutes a hypothesis, say so: that is a finding. If it settles',
    'nothing, say that. Each statement is one falsifiable sentence.',
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"findings":[{"statement":"...","type":"EMPIRICAL","hypothesis":"H1","confidence":0.0}]}',
  ].join('\n');
}

export const findingsSchema = z.object({
  findings: z
    .array(
      z.object({
        statement: z.string().min(1).max(2_000),
        type: z.enum(['EMPIRICAL', 'CONJECTURE']),
        hypothesis: z.string().max(40).optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(12),
});

// ---------------------------------------------------------------------------
// CRITIQUE
// ---------------------------------------------------------------------------

/**
 * How a critic writes a test a program can run. Stated once, in full, because
 * a test in the wrong shape is a test that cannot be routed anywhere.
 */
export const TEST_FORMATS = [
  'A test is something a program can run whose result would settle your point.',
  'Give one wherever one exists. "route" says where it runs:',
  '',
  'SANDBOX — a python script, in "code". It runs under the same rules as the',
  'method. Its last printed line must be exactly "SHEEP_TEST: PASS" or',
  '"SHEEP_TEST: FAIL"; anything else is inconclusive.',
  '',
  'SYMBOLIC — a derivation, in "derivation", checked step by step by SymPy:',
  '{"given":[{"id":"g1","statement":"y = x**2"}],"steps":[{"id":"s1",',
  '"statement":"Derivative(y, x) = 2*x","operation":"differentiate","args":{"var":"x"}}]}',
  'Statements are SymPy expressions. Operations: rewrite, substitute, add, subtract,',
  'multiply, divide, power, apply, differentiate, integrate, solve. PASS means every',
  'step follows.',
  '',
  'SMT — a logical claim, in "constraint", decided by Z3:',
  '{"name":"...","variables":{"x":"real"},"assumptions":["x > 0"],"claim":"x*x > 0"}',
  'PASS means the claim holds in every case the assumptions allow.',
  '',
  'STATISTICAL — reported statistics, in "statistics", audited for consistency:',
  '{"name":"...","n":40,"tests":[{"name":"...","test":"t","statistic":2.1,"df":38,"p":0.04}]}',
  'PASS means the numbers are complete and agree with each other.',
  '',
  'MANUAL — a test that cannot be run here. Describe it; it will be recorded and',
  'the dispute will stay open as a question.',
  '',
  '"claimFailsIf" says which result would falsify the claim: "FAIL" if the claim',
  'should pass your test, "PASS" if your test passing is what refutes it.',
].join('\n');

/** Blind: each critic sees the method, the run and the findings — and no other critique. */
export function critiquePrompt(
  charter: string,
  hypotheses: readonly PromptClaim[],
  method: MethodDraft,
  run: PromptRun,
  findings: readonly (PromptClaim & { readonly claim: { readonly claimType: string } })[],
): string {
  return [
    'The Charter for this session:',
    '',
    charter,
    '',
    'The hypotheses under test:',
    '',
    ...listClaims(hypotheses),
    '',
    'Another participant, from a different vendor, ran this method:',
    '',
    method.plan,
    '',
    '```python',
    method.code.trimEnd(),
    '```',
    '',
    'Everything the script printed:',
    '',
    '--- output ---',
    clipOutput(run.stdout.trimEnd()),
    '--- end of output ---',
    '',
    'From that output it recorded these findings:',
    '',
    ...findings.map(
      (entry) => `[${entry.label}] (${entry.claim.claimType}) ${entry.claim.statement}`,
    ),
    '',
    'Critique the findings. You are working blind: no other critic’s view is',
    'available to you. For each finding ask whether the output actually supports',
    'it, and whether the method could have produced that output for another reason.',
    '',
    'Each critique names one finding and attacks along one axis:',
    'INTERNAL_VALIDITY, CONFOUNDS, LEAKAGE, POWER, BASELINES, REPRODUCIBILITY,',
    'DERIVATION, UNITS, STATISTICS, SCOPE, NOVELTY.',
    '',
    TEST_FORMATS,
    '',
    'A finding you can find nothing wrong with gets no critique; an empty list is an',
    'honest answer. At most five critiques, most serious first.',
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"critiques":[{"claim":"C1","axis":"BASELINES","severity":"blocking|major|minor",',
    '"argument":"what is wrong",',
    '"proposedTest":{"route":"SANDBOX","description":"what it checks",',
    '"falsifies":"what result would refute the finding","claimFailsIf":"FAIL","code":"..."}}]}',
  ].join('\n');
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

import { z } from 'zod';
import { idSchema, sha256Schema, timestampSchema, titleSchema } from './primitives';

/**
 * A derivation, written so that a program can check it (P4).
 *
 * Prose cannot be verified, so a derivation is not prose. It is a list of
 * premises and an ordered list of steps, and every step declares the one
 * operation that is supposed to take the statement it starts from to the
 * statement it makes: "differentiate with respect to x", "divide both sides by
 * m", "substitute using g2". A checker can test exactly that and nothing else.
 *
 * Statements are in SymPy's expression syntax — `m*a`, `x**2 + 1`,
 * `sin(theta)` — and an equation is two expressions around a single `=`.
 *
 * The verdict for a step is one of three, and the third matters as much as the
 * other two: `UNCHECKABLE` is what a step gets when no checker could decide
 * it. It is never rounded to a pass.
 */

export const VERIFICATION_STATUSES = ['PASS', 'FAIL', 'UNCHECKABLE'] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

/** A name a statement may be referred to by: `g1`, `s3`, `energy`. */
const statementIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, 'expected a short identifier');

const statementSchema = z.string().min(1).max(2_000);

const symbolNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/, 'expected a symbol');

/** What may be assumed of a symbol. They decide, for one, whether dividing by it is safe. */
export const SYMBOL_ASSUMPTIONS = [
  'real',
  'positive',
  'negative',
  'nonzero',
  'nonnegative',
  'integer',
] as const;

export const derivationSymbolSchema = z.strictObject({
  assumptions: z.array(z.enum(SYMBOL_ASSUMPTIONS)).optional(),
  /**
   * What the symbol is measured in, as pint reads it: `m/s`, `kg*m**2/s**2`,
   * `dimensionless`. Declaring any turns on dimensional analysis for the
   * derivation.
   */
  units: z.string().min(1).max(80).optional(),
});

export const derivationGivenSchema = z.strictObject({
  id: statementIdSchema,
  statement: statementSchema,
  note: z.string().max(500).optional(),
});

export const derivationStepSchema = z.strictObject({
  id: statementIdSchema,
  statement: statementSchema,
  /**
   * What is claimed to produce this statement. Free text on purpose: an
   * operation the checker has never heard of is a step it reports as
   * `UNCHECKABLE`, not a derivation it refuses to read.
   */
  operation: z.string().min(1).max(40),
  /** The statement this step starts from. Defaults to the one before it. */
  from: statementIdSchema.optional(),
  /** A second statement the operation draws on: the equation substituted, or added. */
  using: statementIdSchema.optional(),
  /** Operation parameters, each an expression: `{ "var": "x" }`, `{ "value": "2*m" }`. */
  args: z.record(z.string().max(20), statementSchema).optional(),
  note: z.string().max(500).optional(),
});
export type DerivationStep = z.infer<typeof derivationStepSchema>;

export const derivationSchema = z.strictObject({
  title: titleSchema.optional(),
  /** Symbols that carry assumptions. One not listed is an unconstrained symbol. */
  symbols: z.record(symbolNameSchema, derivationSymbolSchema).optional(),
  /** Premises. Taken as stated; they are what the derivation is conditional on. */
  given: z.array(derivationGivenSchema).max(50),
  steps: z.array(derivationStepSchema).min(1).max(200),
});
export type Derivation = z.infer<typeof derivationSchema>;

/**
 * Whether a statement is dimensionally sound — that it never adds a length to
 * a time, or sets one equal to the other. `UNCHECKABLE` when a symbol in it
 * has no units declared.
 */
export const dimensionVerdictSchema = z.strictObject({
  status: verificationStatusSchema,
  reason: z.string(),
});
export type DimensionVerdict = z.infer<typeof dimensionVerdictSchema>;

/** How a statement is displayed: LaTeX is canonical, MathML is for the screen. */
const renderedSchema = {
  latex: z.string().nullable(),
  mathml: z.string().nullable(),
  /** Null when the derivation declares no units, so the check was not asked for. */
  dimensions: dimensionVerdictSchema.nullable(),
};

export const stepVerdictSchema = z.strictObject({
  id: z.string(),
  status: verificationStatusSchema,
  /** Why, in a sentence a person can act on. */
  reason: z.string(),
  /** Which checker decided: `symbolic`, `structural`, `numeric`, `dimensional`, or `none`. */
  method: z.string(),
  /**
   * For a step falsified numerically: the point at which the two sides
   * differ, and what each came to there (`left` is the step as stated).
   */
  counterexample: z.record(z.string(), z.string()).nullable(),
  ...renderedSchema,
});
export type StepVerdict = z.infer<typeof stepVerdictSchema>;

export const derivationVerdictSchema = z.strictObject({
  /**
   * `FAIL` if any step fails or a premise is dimensionally unsound; otherwise
   * `UNCHECKABLE` if any step is; otherwise `PASS`.
   */
  status: verificationStatusSchema,
  counts: z.strictObject({
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    uncheckable: z.number().int().nonnegative(),
  }),
  given: z.array(
    z.strictObject({
      id: z.string(),
      /** Set when the premise itself could not be read. */
      problem: z.string().nullable(),
      ...renderedSchema,
    }),
  ),
  steps: z.array(stepVerdictSchema),
});
export type DerivationVerdict = z.infer<typeof derivationVerdictSchema>;

/**
 * A derivation that has been checked, as the log records it.
 *
 * The derivation and its verdict travel as content addresses. What is kept in
 * the event itself is what the ledger decides on: the outcome and the count of
 * steps in each state, so that a derivation with a failed step can be refused
 * as backing without reading a blob.
 */
export const derivationFields = {
  derivationId: idSchema,
  /** The derivation as submitted. */
  bodyHash: sha256Schema,
  /** Every step's verdict, as the checker gave it. */
  verdictHash: sha256Schema,
  status: verificationStatusSchema,
  counts: derivationVerdictSchema.shape.counts,
  /** Which interpreter and libraries did the checking: the runtime's lock hash. */
  envLockHash: sha256Schema,
} as const;

export const derivationRecordSchema = z.strictObject({
  sessionId: idSchema,
  ...derivationFields,
  title: titleSchema.nullable(),
  recordedAt: timestampSchema,
});
export type DerivationRecord = z.infer<typeof derivationRecordSchema>;

/** A reported quantity, and the kind of quantity it is supposed to be. */
export const quantitySchema = z.strictObject({
  name: z.string().min(1).max(200),
  units: z.string().min(1).max(80),
  expected: z.string().min(1).max(80),
});
export type Quantity = z.infer<typeof quantitySchema>;

/**
 * A logical or constraint claim: that something holds in every case the
 * assumptions allow. Formulas are comparisons and arithmetic joined with
 * `and`, `or`, `not`, or `Implies(a, b)`: `x > 0 and y >= x`.
 */
export const constraintClaimSchema = z.strictObject({
  name: z.string().min(1).max(200),
  variables: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/, 'expected a variable name'),
    z.enum(['real', 'int', 'bool']),
  ),
  assumptions: z.array(z.string().min(1).max(2_000)).max(50),
  claim: z.string().min(1).max(2_000),
});
export type ConstraintClaim = z.infer<typeof constraintClaimSchema>;

export const constraintVerdictSchema = z.strictObject({
  name: z.string(),
  /** `PASS` is a proof; `FAIL` comes with the case that breaks the claim. */
  status: verificationStatusSchema,
  reason: z.string(),
  counterexample: z.record(z.string(), z.string()).nullable(),
});
export type ConstraintVerdict = z.infer<typeof constraintVerdictSchema>;

export const quantityVerdictSchema = z.strictObject({
  name: z.string(),
  status: verificationStatusSchema,
  reason: z.string(),
  /** Multiply by this to convert to the expected units. Null unless they are compatible. */
  factor: z.number().nullable(),
});
export type QuantityVerdict = z.infer<typeof quantityVerdictSchema>;

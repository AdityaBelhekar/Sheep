import { describe, expect, it } from 'vitest';
import type { ConstraintClaim } from '@sheep/core';
import { derivation, testVerifier } from './test-support';

const verifier = testVerifier();

describe('numeric spot-check', () => {
  it('falsifies a wrong identity with the point at which it breaks', async () => {
    const wrong = derivation(
      ['log(a + b)'],
      [{ statement: 'log(a) + log(b)', operation: 'expand' }],
      { a: { assumptions: ['positive'] }, b: { assumptions: ['positive'] } },
    );
    const [first, again] = await verifier.checkDerivations([wrong, wrong]);
    const step = first!.steps[0]!;

    expect(step).toMatchObject({ status: 'FAIL', method: 'numeric' });
    expect(Object.keys(step.counterexample!).sort()).toEqual(['a', 'b', 'left', 'right']);
    // The counterexample is real: the two sides, evaluated where it says.
    const { a, b, left, right } = step.counterexample!;
    expect(Number(left)).toBeCloseTo(Math.log(Number(a)) + Math.log(Number(b)), 4);
    expect(Number(right)).toBeCloseTo(Math.log(Number(a) + Number(b)), 4);
    expect(step.reason).toContain(`a = ${a!}`);
    // Seeded: the same question gets the same counterexample.
    expect(again!.steps[0]!.counterexample).toEqual(step.counterexample);
  });

  it('samples only where the stated assumptions allow', async () => {
    const [verdict] = await verifier.checkDerivations([
      derivation(
        ['sqrt(x**2)', 'log(x*y)', 'Abs(n)'],
        [
          // Each is false for some real numbers, and true for all of these.
          { statement: 'x', operation: 'simplify', from: 'g1' },
          { statement: 'log(x) + log(y)', operation: 'expand', from: 'g2' },
          { statement: '-n', operation: 'simplify', from: 'g3' },
        ],
        {
          x: { assumptions: ['positive'] },
          y: { assumptions: ['positive'] },
          n: { assumptions: ['negative', 'integer'] },
        },
      ),
    ]);

    expect(verdict!.steps.map((step) => step.status)).toEqual(['PASS', 'PASS', 'PASS']);
    expect(verdict!.steps.every((step) => step.counterexample === null)).toBe(true);
  });

  it('decides at once what symbolic work alone would never finish', async () => {
    const started = Date.now();
    const [verdict] = await verifier.checkDerivations([
      derivation(
        ['(x + y + z + w)**9999'],
        [{ statement: '(x + y + z - w)**9999', operation: 'rewrite' }],
      ),
    ]);

    expect(verdict!.steps[0]).toMatchObject({ status: 'FAIL', method: 'numeric' });
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('treats agreement at sampled points as evidence, never as proof', async () => {
    const [verdict] = await verifier.checkDerivations([
      derivation(['Max(a, b) + Min(a, b)'], [{ statement: 'a + b', operation: 'rewrite' }], {
        a: { assumptions: ['real'] },
        b: { assumptions: ['real'] },
      }),
    ]);

    // True, and it agrees everywhere it was tried. That is still not a proof.
    expect(verdict!.steps[0]).toMatchObject({ status: 'UNCHECKABLE', method: 'numeric' });
    expect(verdict!.steps[0]!.reason).toMatch(
      /agrees at all 12 points sampled, but SymPy could not prove/,
    );
    expect(verdict!.status).toBe('UNCHECKABLE');
  });
});

describe('constraint claims', () => {
  const real = { x: 'real', y: 'real' } as const;
  const claim = (
    assumptions: string[],
    goal: string,
    variables: ConstraintClaim['variables'] = real,
  ): ConstraintClaim => ({ name: goal, variables, assumptions, claim: goal });

  it('proves what follows, and produces the case that breaks what does not', async () => {
    const [proved, broken] = await verifier.checkConstraints([
      claim(['x > 0', 'y > x'], 'y > 0'),
      claim(['x > 0'], 'x*y > 0'),
    ]);

    expect(proved).toMatchObject({ status: 'PASS', counterexample: null });
    expect(broken!.status).toBe('FAIL');
    const { x, y } = broken!.counterexample!;
    // The counterexample satisfies the assumption and breaks the claim.
    const value = (text: string): number => {
      const [top, bottom] = text.split('/');
      return Number(top) / Number(bottom ?? 1);
    };
    expect(value(x!)).toBeGreaterThan(0);
    expect(value(x!) * value(y!)).toBeLessThanOrEqual(0);
  });

  it('knows an integer from a real', async () => {
    const [whole, continuous] = await verifier.checkConstraints([
      claim(['n > 2'], 'n >= 3', { n: 'int' }),
      claim(['n > 2'], 'n >= 3', { n: 'real' }),
    ]);

    expect(whole!.status).toBe('PASS');
    expect(continuous!.status).toBe('FAIL');
  });

  it('reads chained comparisons, logic, and division as division', async () => {
    const verdicts = await verifier.checkConstraints([
      claim(['0 < x < 1'], 'x*x < x'),
      claim(['Implies(p, q)', 'p'], 'q', { p: 'bool', q: 'bool' }),
      claim(['Implies(p, q)', 'q'], 'p', { p: 'bool', q: 'bool' }),
      claim(['x > 0 or y > 0', 'not (x > 0)'], 'y > 0'),
      // Half of three is one and a half. Truncated, it would be one, and fail.
      claim(['n == 3'], 'n/2 > 1', { n: 'int' }),
      claim([], 'Abs(x) >= x and Max(x, y) >= Min(x, y)'),
    ]);

    expect(verdicts.map((verdict) => verdict.status)).toEqual([
      'PASS',
      'PASS',
      'FAIL',
      'PASS',
      'PASS',
      'PASS',
    ]);
  });

  it('refuses a proof from assumptions that contradict each other', async () => {
    const [verdict] = await verifier.checkConstraints([claim(['x > 1', 'x < 0'], 'y == 42')]);

    expect(verdict).toMatchObject({ status: 'FAIL' });
    expect(verdict!.reason).toMatch(/contradict each other/);
  });

  it('labels what it cannot read, and never runs it', async () => {
    const verdicts = await verifier.checkConstraints([
      claim(['z > 0'], 'x > 0'),
      claim([], '__import__("os").system("echo hi") == 0'),
      claim([], 'x.real > 0'),
      claim([], 'x + 1'),
      claim([], 'x >'),
    ]);

    expect(verdicts.map((verdict) => verdict.status)).toEqual(Array(5).fill('UNCHECKABLE'));
    expect(verdicts[0]!.reason).toMatch(/z is not a declared variable/);
    expect(verdicts[3]!.reason).toMatch(/true or false, not a number/);
  });
});

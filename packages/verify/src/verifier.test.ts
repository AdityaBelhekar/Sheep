import { describe, expect, it } from 'vitest';
import { derivationSchema } from '@sheep/core';
import { derivation, testVerifier } from './test-support';

const verifier = testVerifier();

/** Runs one derivation and returns `id: STATUS` per step, with the full verdict. */
async function check(...args: Parameters<typeof derivation>) {
  const input = derivationSchema.parse(derivation(...args));
  const [verdict] = await verifier.checkDerivations([input]);
  return { verdict: verdict!, statuses: verdict!.steps.map((step) => step.status) };
}

describe('step checker', () => {
  it('passes a derivation in which every step follows', async () => {
    // Kinetic energy from the work done by a constant force.
    const { verdict, statuses } = await check(
      ['W = F*d', 'F = m*a', 'v**2 = 2*a*d'],
      [
        { statement: 'W = m*a*d', operation: 'substitute', from: 'g1', using: 'g2' },
        { statement: 'a*d = v**2/2', operation: 'divide', from: 'g3', args: { value: '2' } },
        { statement: 'W = m*v**2/2', operation: 'substitute', from: 's1', using: 's2' },
      ],
    );

    expect(statuses).toEqual(['PASS', 'PASS', 'PASS']);
    expect(verdict.status).toBe('PASS');
    expect(verdict.counts).toEqual({ pass: 3, fail: 0, uncheckable: 0 });
    expect(verdict.steps[2]!.latex).toContain('W =');
    expect(verdict.steps[2]!.mathml).toContain('<mi>W</mi>');
    expect(verdict.given.map((premise) => premise.problem)).toEqual([null, null, null]);
  });

  it('fails the step that does not follow, and only that step', async () => {
    const { verdict, statuses } = await check(
      ['y = (x + 1)**2'],
      [
        { statement: 'y = x**2 + 2*x + 1', operation: 'expand' },
        // A sign slipped while differentiating.
        { statement: 'Derivative(y, x) = 2*x - 2', operation: 'differentiate', args: { var: 'x' } },
        { statement: 'Derivative(y, x)/2 = x - 1', operation: 'divide', args: { value: '2' } },
      ],
    );

    // The step after the bad one is checked against what was written, and
    // does follow from it: the error is located, not smeared.
    expect(statuses).toEqual(['PASS', 'FAIL', 'PASS']);
    expect(verdict.status).toBe('FAIL');
    expect(verdict.steps[1]!.reason).toMatch(/where the operation gives/);
  });

  it('checks each operation against what it actually does', async () => {
    const { statuses } = await check(
      ['a*x + b = c', 'p = q'],
      [
        { statement: 'a*x = c - b', operation: 'subtract', from: 'g1', args: { value: 'b' } },
        { statement: 'a*x + b + 1 = c + 1', operation: 'add', from: 'g1', args: { value: '1' } },
        { statement: '2*a*x = 2*c - 2*b', operation: 'multiply', from: 's1', args: { value: '2' } },
        { statement: 'p**2 = q**2', operation: 'power', from: 'g2', args: { value: '2' } },
        { statement: 'exp(p) = exp(q)', operation: 'apply', from: 'g2', args: { function: 'exp' } },
        { statement: 'a*x + b + p = c + q', operation: 'add-equations', from: 'g1', using: 'g2' },
        {
          statement: 'a*x + b - p = c - q',
          operation: 'subtract-equations',
          from: 'g1',
          using: 'g2',
        },
        { statement: 'x = (c - b)/a', operation: 'solve', from: 'g1', args: { for: 'x' } },
        // And each of them catches its own kind of mistake.
        { statement: 'a*x = c + b', operation: 'subtract', from: 'g1', args: { value: 'b' } },
        { statement: 'p**2 = q', operation: 'power', from: 'g2', args: { value: '2' } },
        { statement: 'x = (c + b)/a', operation: 'solve', from: 'g1', args: { for: 'x' } },
      ],
    );

    expect(statuses).toEqual([...Array<string>(8).fill('PASS'), 'FAIL', 'FAIL', 'FAIL']);
  });

  it('checks calculus by doing it', async () => {
    const x = { var: 'x' };
    const { statuses } = await check(
      ['f = x**3*sin(x)', 'x'],
      [
        {
          statement: 'Derivative(f, x) = 3*x**2*sin(x) + x**3*cos(x)',
          operation: 'differentiate',
          from: 'g1',
          args: x,
        },
        {
          statement: 'Derivative(f, x) = 3*x**2*sin(x) - x**3*cos(x)',
          operation: 'differentiate',
          from: 'g1',
          args: x,
        },
        // Any constant of integration is an antiderivative.
        { statement: 'x**2/2 + 7', operation: 'integrate', from: 'g2', args: x },
        { statement: 'x**2', operation: 'integrate', from: 'g2', args: x },
      ],
    );

    expect(statuses).toEqual(['PASS', 'FAIL', 'PASS', 'FAIL']);
  });

  it('treats an equation as the same claim with its sides swapped or a term moved', async () => {
    const { statuses } = await check(
      ['E = m*c**2'],
      [
        { statement: 'm*c**2 = E', operation: 'rewrite' },
        { statement: 'E - m*c**2 = 0', operation: 'rearrange' },
        // But not with one side scaled: that is a different operation.
        { statement: '2*E = m*c**2', operation: 'rewrite', from: 'g1' },
      ],
    );

    expect(statuses).toEqual(['PASS', 'PASS', 'FAIL']);
  });

  it('proves trigonometric and algebraic identities symbolically', async () => {
    const { statuses } = await check(
      ['sin(x)**2 + cos(x)**2', '(a + b)**3'],
      [
        { statement: '1', operation: 'simplify', from: 'g1' },
        { statement: 'a**3 + 3*a**2*b + 3*a*b**2 + b**3', operation: 'expand', from: 'g2' },
        { statement: 'a**3 + b**3', operation: 'expand', from: 'g2' },
      ],
    );

    expect(statuses).toEqual(['PASS', 'PASS', 'FAIL']);
  });
});

describe('honest labelling', () => {
  it('reports an operation it has no checker for as UNCHECKABLE, never as a pass', async () => {
    const { verdict, statuses } = await check(
      ['S = n*(n - 1)/2 + n'],
      [
        // True, as it happens. The checker still has no way to know that.
        { statement: 'S = n*(n + 1)/2', operation: 'by induction' },
        { statement: '2*S = n*(n + 1)', operation: 'multiply', args: { value: '2' } },
      ],
    );

    expect(statuses).toEqual(['UNCHECKABLE', 'PASS']);
    expect(verdict.steps[0]!.reason).toBe("no checker for the operation 'by induction'");
    // One undecided step is enough to keep the derivation from passing.
    expect(verdict.status).toBe('UNCHECKABLE');
  });

  it('will not divide by something it cannot show is nonzero', async () => {
    const steps = [{ statement: 'x = 1', operation: 'divide', args: { value: 'a' } }];

    const unknown = await check(['a*x = a'], steps);
    expect(unknown.statuses).toEqual(['UNCHECKABLE']);
    expect(unknown.verdict.steps[0]!.reason).toMatch(/nothing shows a is not zero/);

    // With the assumption stated, the same step is checked and passes.
    const assumed = await check(['a*x = a'], steps, { a: { assumptions: ['nonzero'] } });
    expect(assumed.statuses).toEqual(['PASS']);

    const zero = await check(
      ['x = y'],
      [{ statement: 'x/0 = y/0', operation: 'divide', args: { value: '0' } }],
    );
    expect(zero.statuses).not.toEqual(['PASS']);
  });

  it('will not pick a branch of a solution for the author', async () => {
    const steps = [{ statement: 'x = 2', operation: 'solve', args: { for: 'x' } }];

    const either = await check(['x**2 = 4'], steps);
    expect(either.statuses).toEqual(['UNCHECKABLE']);
    expect(either.verdict.steps[0]!.reason).toMatch(/one of 2 solutions/);

    // The assumption that rules the other root out makes it decidable.
    const positive = await check(['x**2 = 4'], steps, { x: { assumptions: ['positive'] } });
    expect(positive.statuses).toEqual(['PASS']);
  });

  it('labels a statement it cannot read, and everything resting on it', async () => {
    const { verdict, statuses } = await check(
      ['y = x'],
      [
        { statement: 'y = x +', operation: 'rewrite' },
        { statement: 'y = x', operation: 'rewrite' },
        { statement: 'y = x', operation: 'rewrite', from: 'nowhere' },
        { statement: 'y = x', operation: 'substitute', from: 'g1' },
        { statement: 'y < x', operation: 'rewrite', from: 'g1' },
      ],
    );

    expect(statuses).toEqual(Array(5).fill('UNCHECKABLE'));
    expect(verdict.steps.map((step) => step.reason)).toEqual([
      expect.stringMatching(/could not read the statement/),
      'it depends on s1, which could not be read',
      '`from` names nowhere, which is not an earlier statement',
      expect.stringMatching(/needs a second statement/),
      expect.stringMatching(/inequality is a constraint/),
    ]);
  });
});

describe('statements are data, never code', () => {
  it.each([
    ['an attribute access', 'x.__class__'],
    ['a call to anything but a known function', '__import__("os")'],
    ['a string', '"PASS"'],
    ['a subscript', 'x[0]'],
    ['a lambda', '(lambda: 1)()'],
    ['a comprehension', '[x for x in (1, 2)]'],
    ['a method call', 'x.subs(x, 1)'],
    ['a forged finding', 'print(\'{"request": 0, "step": {"id": "s1", "status": "PASS"}}\')'],
  ])('refuses %s', async (_what, statement) => {
    const { verdict, statuses } = await check(['x'], [{ statement, operation: 'rewrite' }]);

    expect(statuses).toEqual(['UNCHECKABLE']);
    expect(verdict.steps[0]!.reason).toMatch(/could not read the statement/);
  });
});

describe('a checker that does not finish', () => {
  it('passes nothing it did not decide', async () => {
    // Not even enough time to import SymPy.
    const [verdict] = await testVerifier({ timeoutMs: 200 }).checkDerivations([
      derivation(['a = b'], [{ statement: 'b = a', operation: 'rewrite' }]),
    ]);

    expect(verdict).toMatchObject({
      status: 'UNCHECKABLE',
      counts: { pass: 0, fail: 0, uncheckable: 1 },
    });
    expect(verdict!.steps[0]!.reason).toMatch(/ran out of time/);
    expect(verdict!.given[0]!.problem).toMatch(/ran out of time/);
  });
});

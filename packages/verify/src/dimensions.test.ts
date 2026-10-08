import { describe, expect, it } from 'vitest';
import { derivationSchema, type Derivation } from '@sheep/core';
import { derivation, testVerifier } from './test-support';

const verifier = testVerifier();

const units = (table: Record<string, string>): Derivation['symbols'] =>
  Object.fromEntries(Object.entries(table).map(([name, unit]) => [name, { units: unit }]));

async function check(...args: Parameters<typeof derivation>) {
  const [verdict] = await verifier.checkDerivations([derivationSchema.parse(derivation(...args))]);
  return verdict!;
}

describe('dimensional analysis', () => {
  it('follows units through a derivation and finds every statement sound', async () => {
    const verdict = await check(
      ['v = u + a*t', 's = u*t + a*t**2/2', 'v**2 = u**2 + 2*a*s'],
      [
        { statement: 'v - u = a*t', operation: 'subtract', from: 'g1', args: { value: 'u' } },
        { statement: 'v**2 - u**2 = 2*a*s', operation: 'rearrange', from: 'g3' },
      ],
      units({ v: 'm/s', u: 'm/s', a: 'm/s**2', t: 's', s: 'm' }),
    );

    expect(verdict.status).toBe('PASS');
    expect(verdict.given.map((premise) => premise.dimensions)).toEqual([
      { status: 'PASS', reason: 'both sides are [length] / [time]' },
      { status: 'PASS', reason: 'both sides are [length]' },
      { status: 'PASS', reason: 'both sides are [length] ** 2 / [time] ** 2' },
    ]);
    expect(verdict.steps.map((step) => step.dimensions?.status)).toEqual(['PASS', 'PASS']);
  });

  it('fails a premise that equates unlike quantities, and the derivation with it', async () => {
    const verdict = await check(
      ['d = v*t', 'd = v + t'],
      [{ statement: 'v*t = d', operation: 'rewrite', from: 'g1' }],
      units({ d: 'm', v: 'm/s', t: 's' }),
    );

    expect(verdict.given[1]!.dimensions).toEqual({
      status: 'FAIL',
      reason: 'it adds [time] and [length] / [time]',
    });
    // The step itself is fine. The derivation is not: it rests on that premise.
    expect(verdict.steps[0]!.status).toBe('PASS');
    expect(verdict.status).toBe('FAIL');
  });

  it('fails a step that follows algebraically but is dimensional nonsense', async () => {
    const verdict = await check(
      ['x = y'],
      [{ statement: 'x + 1 = y + 1', operation: 'add', args: { value: '1' } }],
      units({ x: 'm', y: 'm' }),
    );

    expect(verdict.steps[0]).toMatchObject({
      status: 'FAIL',
      method: 'dimensional',
      reason: 'dimensionally inconsistent: it adds dimensionless and [length]',
    });
  });

  it('catches the two sides of an equation disagreeing', async () => {
    const verdict = await check(
      ['E = m*c'],
      [{ statement: 'm*c = E', operation: 'rewrite' }],
      units({ E: 'joule', m: 'kg', c: 'm/s' }),
    );

    expect(verdict.steps[0]!.dimensions).toEqual({
      status: 'FAIL',
      reason:
        'the left side is [length] * [mass] / [time] but the right side is [mass] * [length] ** 2 / [time] ** 2',
    });
  });

  it('requires the argument of a transcendental function to be dimensionless', async () => {
    const decay = (exponent: string, symbols: Record<string, string>) =>
      check(
        [`N = N0*exp(${exponent})`],
        [{ statement: `N/N0 = exp(${exponent})`, operation: 'divide', args: { value: 'N0' } }],
        {
          ...units({ N: 'dimensionless', ...symbols }),
          N0: { units: 'dimensionless', assumptions: ['nonzero'] },
        },
      );

    const wrong = await decay('-t', { t: 's' });
    expect(wrong.given[0]!.dimensions).toEqual({
      status: 'FAIL',
      reason: 'the argument of exp has to be dimensionless, but is [time]',
    });

    const right = await decay('-k*t', { t: 's', k: '1/s' });
    expect(right.status).toBe('PASS');
    expect(right.steps[0]!.dimensions?.status).toBe('PASS');
  });

  it('handles derivatives, roots and a bare zero', async () => {
    const verdict = await check(
      ['v = Derivative(x, t)', 'T = 2*pi*sqrt(L/g)', 'E - m*c**2 = 0', 'a = Derivative(x, (t, 2))'],
      [{ statement: 'E = m*c**2', operation: 'rearrange', from: 'g3' }],
      units({
        v: 'm/s',
        x: 'm',
        t: 's',
        T: 's',
        L: 'm',
        g: 'm/s**2',
        E: 'joule',
        m: 'kg',
        c: 'm/s',
        a: 'm/s**2',
      }),
    );

    expect(verdict.given.map((premise) => premise.dimensions?.status)).toEqual([
      'PASS',
      'PASS',
      'PASS',
      'PASS',
    ]);
    expect(verdict.status).toBe('PASS');
  });

  it('says so when it has no units to go on, instead of assuming', async () => {
    const partial = await check(
      ['F = m*a'],
      [{ statement: 'm*a = F', operation: 'rewrite' }],
      units({ F: 'newton', m: 'kg' }),
    );
    expect(partial.steps[0]).toMatchObject({
      // The algebra is still decided; only the dimensional question is open.
      status: 'PASS',
      dimensions: { status: 'UNCHECKABLE', reason: 'no units are declared for a' },
    });

    const unreadable = await check(
      ['F = m*a'],
      [{ statement: 'm*a = F', operation: 'rewrite' }],
      units({ F: 'florps' }),
    );
    expect(unreadable.steps[0]!.dimensions).toEqual({
      status: 'UNCHECKABLE',
      reason: 'the units of F could not be read: florps',
    });
  });

  it('does not run at all when no units are declared', async () => {
    const verdict = await check(['x = y'], [{ statement: 'y = x', operation: 'rewrite' }]);

    expect(verdict.steps[0]!.dimensions).toBeNull();
    expect(verdict.given[0]!.dimensions).toBeNull();
  });
});

describe('units of empirical results', () => {
  it('accepts compatible units, rejects incompatible ones, and labels unreadable ones', async () => {
    const verdicts = await verifier.checkUnits([
      { name: 'mean speed', units: 'km/hour', expected: 'm/s' },
      { name: 'energy', units: 'kW*hour', expected: 'joule' },
      { name: 'mean speed', units: 'kg', expected: 'm/s' },
      { name: 'accuracy', units: 'percent', expected: 'dimensionless' },
      { name: 'mystery', units: 'florps', expected: 'm' },
    ]);

    expect(verdicts.map((verdict) => verdict.status)).toEqual([
      'PASS',
      'PASS',
      'FAIL',
      'PASS',
      'UNCHECKABLE',
    ]);
    expect(verdicts[0]!.factor).toBeCloseTo(1 / 3.6);
    expect(verdicts[1]!.factor).toBeCloseTo(3.6e6);
    expect(verdicts[2]).toMatchObject({
      reason: 'kg is [mass], but m/s is [length] / [time]',
      factor: null,
    });
  });
});

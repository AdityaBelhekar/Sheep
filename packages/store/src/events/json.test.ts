import { describe, expect, it } from 'vitest';
import { canonicalJson, CanonicalJsonError, parseJson, type JsonValue } from './json';

describe('canonicalJson', () => {
  it('serialises object keys in a stable order regardless of insertion order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });

    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('round-trips through parseJson', () => {
    const value: JsonValue = { s: 'x', n: 1.5, b: true, nul: null, arr: [1, { k: 'v' }] };
    expect(parseJson(canonicalJson(value))).toEqual(value);
  });

  it('escapes strings and keys the same way JSON does', () => {
    expect(canonicalJson({ 'a"b': 'line\nbreak' })).toBe('{"a\\"b":"line\\nbreak"}');
  });

  it('treats -0 and 0 as the same value', () => {
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
  });

  it('refuses values that cannot round-trip', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(undefined as unknown as JsonValue)).toThrow(CanonicalJsonError);
  });

  it('refuses circular structures', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    expect(() => canonicalJson(circular as JsonValue)).toThrow(CanonicalJsonError);
  });
});

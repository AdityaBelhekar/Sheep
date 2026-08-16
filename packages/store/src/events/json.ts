export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Deterministic JSON: object keys sorted by code unit, no insignificant
 * whitespace, no host-dependent formatting.
 *
 * Hashes are only meaningful if the same value always serialises to the same
 * bytes, so anything that cannot round-trip — NaN, Infinity, undefined,
 * functions — is rejected rather than silently turned into null.
 */
export function canonicalJson(value: JsonValue): string {
  return serialise(value, new Set());
}

function serialise(value: JsonValue, seen: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number cannot be serialised: ${String(value)}`);
      }
      // -0 and 0 must not produce different hashes for the same quantity.
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`unsupported value of type ${typeof value}`);
  }

  const object: object = value;
  if (seen.has(object)) throw new CanonicalJsonError('circular reference cannot be serialised');
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialise(item, seen)).join(',')}]`;
    }

    const entries = Object.entries(value as JsonObject)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${serialise(item, seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/** Parses stored payload text back into a value. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}

import { describe, expect, it } from 'vitest';
import { MINIMUM_SECRET_LENGTH, REDACTED, Redactor, SECRET_PATTERN_NAMES } from './redact';

describe('registered secrets', () => {
  it('masks every occurrence, anywhere in the text', () => {
    const redactor = new Redactor();
    redactor.register('super-secret-key-value');

    const line = redactor.redact(
      'auth failed for super-secret-key-value; retrying with super-secret-key-value',
    );
    expect(line).toBe(`auth failed for ${REDACTED}; retrying with ${REDACTED}`);
    expect(line).not.toContain('super-secret-key-value');
  });

  it('masks a secret containing characters a regex would misread', () => {
    const redactor = new Redactor();
    const secret = 'a+b.c*d(e)f[g]$h^i|j?';
    redactor.register(secret);
    expect(redactor.redact(`key=${secret} end`)).toBe(`key=${REDACTED} end`);
  });

  it('ignores values too short to mask without wrecking the log', () => {
    const redactor = new Redactor();
    redactor.register('abc');
    expect(redactor.size).toBe(0);
    expect(redactor.redact('abc is a common substring')).toBe('abc is a common substring');
    expect('abc'.length).toBeLessThan(MINIMUM_SECRET_LENGTH);
  });

  it('ignores anything that is not a string', () => {
    const redactor = new Redactor();
    redactor.register(null);
    redactor.register(undefined);
    expect(redactor.size).toBe(0);
  });

  it('forgets a secret once it is gone, and can be cleared', () => {
    const redactor = new Redactor();
    redactor.register('rotated-out-key-1234');
    expect(redactor.leaks('holding rotated-out-key-1234')).toBe(true);

    redactor.forget('rotated-out-key-1234');
    expect(redactor.leaks('holding rotated-out-key-1234')).toBe(false);

    redactor.registerAll(['first-secret-value', 'second-secret-value']);
    expect(redactor.size).toBe(2);
    redactor.clear();
    expect(redactor.size).toBe(0);
  });

  it('never reveals which values it holds', () => {
    const redactor = new Redactor();
    redactor.register('a-secret-nobody-should-see');
    expect(Object.keys(redactor)).toEqual([]);
    expect(JSON.stringify(redactor)).not.toContain('a-secret');
  });
});

describe('credential shapes nobody registered', () => {
  const redactor = new Redactor();
  const cases: [string, string][] = [
    ['anthropic', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['openai', 'sk-proj-9f8e7d6c5b4a3f2e1d0c9b8a7'],
    ['google', 'AIzaSyD-1234567890abcdefghijklmnopqrstu'],
    ['google-oauth', 'ya29.a0AfH6SMBx1234567890abcdefghijklmnop'],
    ['github', 'ghp_1234567890abcdefghijklmnopqrstuvwx'],
    ['slack', 'xoxb-123456789012-abcdefghijklmno'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE'],
  ];

  it.each(cases)('masks a %s key it has never been told about', (_name, key) => {
    const line = redactor.redact(`request failed with key ${key} (401)`);
    expect(line).not.toContain(key);
    expect(line).toContain(REDACTED);
    // The surrounding context survives, so the log still says something.
    expect(line).toContain('(401)');
  });

  it('masks a bearer token but keeps the scheme visible', () => {
    const line = redactor.redact('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(line).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('masks a secret-shaped JSON field, whatever it holds', () => {
    const body = JSON.stringify({
      model: 'claude-opus-5',
      api_key: 'not-a-recognised-shape-at-all',
      refresh_token: 'abc123',
      temperature: 0.7,
    });
    const line = redactor.redact(body);

    expect(line).not.toContain('not-a-recognised-shape-at-all');
    expect(line).not.toContain('abc123');
    expect(line).toContain(`"api_key":"${REDACTED}"`);
    // Non-secret fields are untouched, or the log would be useless.
    expect(line).toContain('"model":"claude-opus-5"');
    expect(line).toContain('"temperature":0.7');
  });

  it('masks a secret in a query string', () => {
    expect(redactor.redact('GET https://api.example.com/v1/models?key=abcdef123456&limit=10')).toBe(
      `GET https://api.example.com/v1/models?key=${REDACTED}&limit=10`,
    );
  });

  it('masks an environment assignment', () => {
    const line = redactor.redact('env: ANTHROPIC_API_KEY=whatever-this-is HOME=/home/sheep');
    expect(line).toContain(`ANTHROPIC_API_KEY=${REDACTED}`);
    expect(line).toContain('HOME=/home/sheep');
  });

  it('leaves ordinary text alone', () => {
    const line = 'sessions=3 messages=48 chain verified to seq 512 · better-sqlite3 wal';
    expect(redactor.redact(line)).toBe(line);
  });

  it('documents every pattern it applies', () => {
    expect(SECRET_PATTERN_NAMES).toContain('bearer');
    expect(SECRET_PATTERN_NAMES).toContain('json-field');
    expect(new Set(SECRET_PATTERN_NAMES).size).toBe(SECRET_PATTERN_NAMES.length);
  });
});

describe('redactUnknown', () => {
  const redactor = new Redactor();
  redactor.register('the-actual-secret-value');

  it('scrubs an error message and its stack', () => {
    const error = new Error('rejected key the-actual-secret-value');
    const text = redactor.redactUnknown(error);
    expect(text).not.toContain('the-actual-secret-value');
    expect(text).toContain('Error: rejected key');
  });

  it('scrubs a nested object rather than printing [object Object]', () => {
    const text = redactor.redactUnknown({
      request: { headers: { authorization: 'the-actual-secret-value' } },
    });
    expect(text).not.toContain('the-actual-secret-value');
    expect(text).not.toContain('[object Object]');
  });

  it('survives values that cannot be serialised', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    expect(() => redactor.redactUnknown(circular)).not.toThrow();
    expect(redactor.redactUnknown(undefined)).toBe('undefined');
    expect(redactor.redactUnknown(42)).toBe('42');
  });
});

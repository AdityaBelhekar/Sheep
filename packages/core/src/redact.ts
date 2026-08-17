/**
 * Secret redaction for anything that might be written down.
 *
 * Two layers, because either alone would be a false comfort. Registered values
 * catch the secrets this process actually holds, exactly. Patterns catch the
 * shapes of credentials nobody registered — a key pasted into a prompt, one
 * echoed back inside a provider's error message, one in a URL — which is where
 * leaks come from in practice, since the whole point of a leak is that nobody
 * expected that value to be logged.
 *
 * Redaction is not optional and has no "verbose" switch. A log that can be
 * configured to include secrets is a log that will.
 */

export const REDACTED = '[redacted]';

/**
 * Registered values shorter than this are ignored.
 *
 * Masking a three-character string would replace it everywhere it happens to
 * appear and make the log unreadable while protecting nothing that short can
 * usefully protect.
 */
export const MINIMUM_SECRET_LENGTH = 8;

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  /** Replacement, which may keep a leading group so context survives. */
  readonly replacement: string;
}

/**
 * Credential shapes worth catching without being told about them.
 *
 * Each keeps enough context to leave the log legible — `"api_key": "[redacted]"`
 * still says which field was suppressed — while the value itself is gone.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Anthropic and OpenAI style keys.
  { name: 'sk', pattern: /\bsk-[A-Za-z0-9_-]{12,}/g, replacement: REDACTED },
  // Google API keys and OAuth access tokens.
  { name: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
  { name: 'google-oauth', pattern: /\bya29\.[A-Za-z0-9._-]{20,}/g, replacement: REDACTED },
  { name: 'github', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: REDACTED },
  { name: 'slack', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED },
  { name: 'aws', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: REDACTED },
  // A bearer token, however it is introduced.
  {
    name: 'bearer',
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: `$1 ${REDACTED}`,
  },
  // A secret-shaped JSON field, whatever it holds.
  {
    name: 'json-field',
    pattern:
      /("(?:api[_-]?key|apikey|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    replacement: `$1"${REDACTED}"`,
  },
  // A secret in a query string, where it must never have been in the first place.
  {
    name: 'query-param',
    pattern:
      /([?&](?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|password|secret)=)[^&\s"']+/gi,
    replacement: `$1${REDACTED}`,
  },
  // `SOMETHING_KEY=value` in an environment dump or a shell echo.
  {
    name: 'env-assignment',
    pattern: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)\S+/g,
    replacement: `$1${REDACTED}`,
  },
];

/**
 * Holds the secrets this process knows about and scrubs text before it leaves.
 *
 * Everything the main process writes goes through one of these. Registering a
 * secret the moment it is read out of the keychain — rather than at the point
 * something is logged — is what makes accidental disclosure hard: the leak does
 * not have to be anticipated to be caught.
 */
export class Redactor {
  readonly #secrets = new Set<string>();

  /** Ignored, deliberately, if too short to mask without wrecking the log. */
  register(secret: string | null | undefined): void {
    if (typeof secret !== 'string') return;
    if (secret.length < MINIMUM_SECRET_LENGTH) return;
    this.#secrets.add(secret);
  }

  registerAll(secrets: Iterable<string | null | undefined>): void {
    for (const secret of secrets) this.register(secret);
  }

  /** Stops masking a value, e.g. once a credential has been deleted. */
  forget(secret: string): void {
    this.#secrets.delete(secret);
  }

  clear(): void {
    this.#secrets.clear();
  }

  /** How many values are being masked. Never which ones. */
  get size(): number {
    return this.#secrets.size;
  }

  /** True when the text still contains a value this redactor knows. */
  leaks(text: string): boolean {
    for (const secret of this.#secrets) {
      if (text.includes(secret)) return true;
    }
    return false;
  }

  redact(text: string): string {
    // Known values first: an exact match is the strongest signal available, and
    // running it before the patterns means a registered secret is gone even if
    // it happens to sit inside something a pattern would have partly kept.
    let output = text;
    for (const secret of this.#secrets) {
      output = output.split(secret).join(REDACTED);
    }

    for (const { pattern, replacement } of SECRET_PATTERNS) {
      output = output.replace(pattern, replacement);
    }
    return output;
  }

  /**
   * Redacts anything, not just strings.
   *
   * Errors keep their message and stack — both of which are exactly where a
   * provider likes to echo a key back at you — and objects are serialised
   * before scrubbing so a nested secret cannot slide through as `[object
   * Object]`.
   */
  redactUnknown(value: unknown): string {
    return this.redact(stringify(value));
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`.trim();
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Names of the built-in patterns, for tests and documentation. */
export const SECRET_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.map(
  (pattern) => pattern.name,
);

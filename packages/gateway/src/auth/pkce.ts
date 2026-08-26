import { createHash, randomBytes } from 'node:crypto';

/**
 * Proof Key for Code Exchange (RFC 7636).
 *
 * A desktop app cannot keep a client secret — anything shipped in the bundle is
 * public the moment someone unzips it — so the authorization code is bound to a
 * secret generated per sign-in instead. The verifier never leaves this process
 * until the code is redeemed; only its hash goes out in the browser URL, where
 * anything watching can see it and learn nothing.
 */

export interface PkcePair {
  /** The secret. Held in memory only, sent once, at code exchange. */
  readonly verifier: string;
  /** The hash, safe to put in a URL. */
  readonly challenge: string;
  readonly method: 'S256';
}

/** 96 random bytes — 128 base64url characters, the maximum the RFC allows. */
export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(96));
  return { verifier, challenge: challengeFor(verifier), method: 'S256' };
}

export function challengeFor(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

/** An unguessable value tying the redirect back to the request that started it. */
export function createState(): string {
  return base64Url(randomBytes(32));
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

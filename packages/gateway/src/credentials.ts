import { CredentialError } from './errors';

/**
 * How an adapter gets its secret.
 *
 * A function, not a string, is the point: Phase 9 keeps credentials in the OS
 * keychain and hands out a `credential_ref`, so the gateway holds a way to *ask
 * for* the key rather than the key itself. A rotated credential then takes
 * effect on the next call, and no long-lived object in this process has a
 * secret sitting in it waiting to be serialised into a crash dump.
 *
 * A bare string is still accepted, because tests and one-off scripts should not
 * have to build a closure to say `'sk-test'`.
 */
export type SecretProvider = string | (() => string | Promise<string>);

/** Resolves a secret, refusing empty ones rather than sending a blank header. */
export async function resolveSecret(
  adapterId: string,
  secret: SecretProvider | undefined,
  what = 'API key',
): Promise<string> {
  if (secret === undefined) throw new CredentialError(adapterId, `no ${what} was configured`);

  const value = typeof secret === 'string' ? secret : await secret();
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CredentialError(adapterId, `the ${what} resolved to an empty value`);
  }
  return value;
}

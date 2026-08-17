import { z } from 'zod';
import { slugSchema, timestampSchema, titleSchema } from './primitives';

/**
 * Credentials, by reference only.
 *
 * Sheep never stores a secret in its database. What it stores is a
 * `credential_ref`: an opaque handle that names an entry in the operating
 * system's own credential store. The database can be copied, exported, backed
 * up or attached to a bug report without carrying anybody's API key, because
 * the key was never in it — there is no column it could occupy.
 *
 * The indirection also survives rotation. Replacing a key changes what the OS
 * holds under the same handle; no row in the database changes, and every
 * message already attributed to that connection stays attributed.
 */

/** Prefix so a Sheep entry is recognisable in Windows Credential Manager. */
export const CREDENTIAL_REF_PREFIX = 'sheep.credential.';

/** The service name Sheep registers its credentials under. */
export const CREDENTIAL_SERVICE = 'Sheep';

export const credentialRefSchema = z
  .string()
  .regex(
    /^sheep\.credential\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'expected a sheep credential reference',
  );
export type CredentialRef = z.infer<typeof credentialRefSchema>;

export const CREDENTIAL_KINDS = [
  'api-key',
  'oauth-refresh-token',
  'bearer-token',
  'basic-password',
] as const;
export const credentialKindSchema = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

/**
 * Where the secret actually ended up.
 *
 * Recorded because it is the difference between a secret held by the OS and one
 * held by a file this app encrypted, and the user is entitled to know which.
 * There is deliberately no `plaintext` member: if neither backend is available,
 * Sheep refuses to store the secret rather than writing it down unprotected.
 */
export const VAULT_BACKENDS = ['os-keychain', 'encrypted-file', 'memory'] as const;
export const vaultBackendSchema = z.enum(VAULT_BACKENDS);
export type VaultBackend = z.infer<typeof vaultBackendSchema>;

/**
 * Everything Sheep knows about a credential — which is everything except the
 * credential.
 */
export const credentialRecordSchema = z.strictObject({
  credentialRef: credentialRefSchema,
  /** What the user calls it: "Anthropic (personal)". */
  label: titleSchema,
  vendorId: slugSchema,
  kind: credentialKindSchema,
  backend: vaultBackendSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** When a request last proved the secret still works. */
  lastVerifiedAt: timestampSchema.nullable(),
});
export type CredentialRecord = z.infer<typeof credentialRecordSchema>;

export function isCredentialRef(value: string): value is CredentialRef {
  return credentialRefSchema.safeParse(value).success;
}

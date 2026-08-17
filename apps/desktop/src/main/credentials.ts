import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { CREDENTIAL_SERVICE, type CredentialKind } from '@sheep/core';
import { newCredentialRef } from '@sheep/store';
import { logError, logInfo, redactor } from './log';
import { recordSmokeCheck } from './smoke';
import { getStore } from './store';
import {
  selectVault,
  type CredentialVault,
  type EncryptionApi,
  type KeychainApi,
  type VaultSelection,
} from './vault';

const require = createRequire(import.meta.url);

/** Where encrypted-file secrets go if the OS credential store is unusable. */
export const CREDENTIALS_DIRNAME = 'credentials';

let selection: VaultSelection | undefined;

/**
 * Loads keytar through `createRequire`, so a missing or unloadable native build
 * is a catchable runtime condition rather than a crash at import — the same
 * pattern the SQLite driver uses, and for the same reason.
 */
function loadKeychain(): KeychainApi | undefined {
  try {
    const keytar = require('keytar') as KeychainApi;
    return keytar;
  } catch (error) {
    logInfo('the OS credential store could not be loaded -', error);
    return undefined;
  }
}

function loadEncryption(): EncryptionApi | undefined {
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage : undefined;
  } catch {
    return undefined;
  }
}

export function openVault(): VaultSelection {
  if (selection) return selection;

  selection = selectVault({
    keychain: loadKeychain(),
    encryption: loadEncryption(),
    directory: join(app.getPath('userData'), CREDENTIALS_DIRNAME),
    service: CREDENTIAL_SERVICE,
  });

  logInfo(`credentials: ${selection.vault.description}`);
  return selection;
}

export function getVault(): CredentialVault {
  return openVault().vault;
}

export interface SaveCredentialInput {
  readonly label: string;
  readonly vendorId: string;
  readonly kind: CredentialKind;
  readonly secret: string;
}

/**
 * Stores a secret and records that it exists.
 *
 * The order matters: the secret goes to the vault first, and only a successful
 * write earns a row. The reverse would leave the database claiming a credential
 * that cannot be read, which is worse than an orphaned vault entry.
 */
export async function saveCredential(input: SaveCredentialInput): Promise<string> {
  const vault = getVault();
  const backend = vault.backend;
  if (backend === 'none') {
    throw new Error('no secure credential store is available on this machine');
  }

  const store = getStore();
  const credentialRef = newCredentialRef();

  // Registered before the write, so the value is masked even if writing it fails
  // and something logs the failure.
  redactor.register(input.secret);
  await vault.set(credentialRef, input.secret);

  store.credentials.register({
    label: input.label,
    vendorId: input.vendorId,
    kind: input.kind,
    backend,
    credentialRef,
  });
  return credentialRef;
}

/** Reads a secret back, registering it for redaction on the way through. */
export async function readCredential(credentialRef: string): Promise<string | undefined> {
  const secret = await getVault().get(credentialRef);
  redactor.register(secret);
  return secret;
}

/** Removes both halves: the secret, then the record of it. */
export async function deleteCredential(credentialRef: string): Promise<boolean> {
  const secret = await getVault()
    .get(credentialRef)
    .catch(() => undefined);

  const removedSecret = await getVault().delete(credentialRef);
  const removedRecord = getStore().credentials.remove(credentialRef);
  if (secret !== undefined) redactor.forget(secret);
  return removedSecret || removedRecord;
}

/**
 * Proves, at launch, the three properties Phase 9 is supposed to deliver: a
 * secret round-trips through the OS credential store, the database file contains
 * no trace of it, and the logger will not print it.
 *
 * Smoke runs only — it writes and then removes a real credential, which is not
 * something to do behind a user's back on an ordinary launch.
 */
export async function runCredentialSelfTest(): Promise<void> {
  const store = getStore();
  const vault = getVault();
  const secret = `sk-sheep-selftest-${randomBytes(24).toString('hex')}`;
  let credentialRef: string | undefined;

  try {
    credentialRef = await saveCredential({
      label: 'Smoke test',
      vendorId: 'sheep-selftest',
      kind: 'api-key',
      secret,
    });

    const readBack = await readCredential(credentialRef);
    recordSmokeCheck(
      'credential-vault',
      readBack === secret,
      `${vault.backend} · ${readBack === secret ? 'round-trip ok' : 'round-trip FAILED'}`,
    );

    // The strong form of "the DB contains only a reference": read the raw file.
    const record = store.credentials.get(credentialRef);
    const files = [store.path, `${store.path}-wal`, `${store.path}-shm`];
    const found = files.filter((path) => fileContains(path, secret));
    recordSmokeCheck(
      'credential-isolation',
      found.length === 0 && record?.credentialRef === credentialRef,
      found.length === 0
        ? `db holds ${String(store.credentials.count())} ref(s), no secret bytes`
        : `SECRET FOUND IN ${found.join(', ')}`,
    );

    const line = `provider rejected the key ${secret}`;
    const redacted = redactor.redact(line);
    recordSmokeCheck(
      'log-redaction',
      !redacted.includes(secret) && redacted.includes('[redacted]'),
      redacted,
    );
  } catch (error) {
    logError('credential self-test failed -', error);
    for (const name of ['credential-vault', 'credential-isolation', 'log-redaction']) {
      recordSmokeCheck(name, false, error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (credentialRef) await deleteCredential(credentialRef).catch(() => false);
    redactor.forget(secret);
  }
}

function fileContains(path: string, needle: string): boolean {
  try {
    return readFileSync(path).includes(Buffer.from(needle, 'utf8'));
  } catch {
    // A WAL or shm file that is not there cannot be hiding anything.
    return false;
  }
}

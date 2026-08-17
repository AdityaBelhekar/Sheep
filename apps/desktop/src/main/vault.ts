import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIAL_SERVICE, isCredentialRef, type VaultBackend } from '@sheep/core';

/**
 * Secret storage, kept deliberately free of any Electron import so the choice
 * of backend and the behaviour of each can be tested in plain Node. The wiring
 * that hands it Electron's `safeStorage` lives in `credentials.ts`.
 */

export class VaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VaultError';
  }
}

export class VaultUnavailableError extends VaultError {
  constructor(readonly reason: string) {
    super(`No secure credential store is available: ${reason}`);
    this.name = 'VaultUnavailableError';
  }
}

export interface CredentialVault {
  readonly backend: VaultBackend | 'none';
  /** Human-readable note about where secrets go, for the UI and the logs. */
  readonly description: string;
  set(credentialRef: string, secret: string): Promise<void>;
  get(credentialRef: string): Promise<string | undefined>;
  delete(credentialRef: string): Promise<boolean>;
}

/** The slice of keytar's surface Sheep uses. */
export interface KeychainApi {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/** The slice of Electron's `safeStorage` Sheep uses. */
export interface EncryptionApi {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

function assertRef(credentialRef: string): string {
  if (!isCredentialRef(credentialRef)) {
    throw new VaultError(`not a credential reference: ${credentialRef}`);
  }
  return credentialRef;
}

/**
 * The operating system's own credential store — Windows Credential Manager,
 * macOS Keychain, or Secret Service on Linux.
 *
 * The preferred backend, because the secret then lives somewhere Sheep does
 * not: no file Sheep writes, no directory Sheep owns, and no key material Sheep
 * has to manage.
 */
export function createKeychainVault(
  keychain: KeychainApi,
  service: string = CREDENTIAL_SERVICE,
): CredentialVault {
  return {
    backend: 'os-keychain',
    description: `${service} entries in the OS credential store`,

    async set(credentialRef, secret) {
      try {
        await keychain.setPassword(service, assertRef(credentialRef), secret);
      } catch (error) {
        // Never include the secret, and never the underlying message verbatim:
        // some platform errors echo the value they were handed.
        throw new VaultError(`could not write ${credentialRef} to the OS credential store`, {
          cause: error,
        });
      }
    },

    async get(credentialRef) {
      const secret = await keychain.getPassword(service, assertRef(credentialRef));
      return secret ?? undefined;
    },

    async delete(credentialRef) {
      return keychain.deletePassword(service, assertRef(credentialRef));
    },
  };
}

/**
 * Fallback for machines with no usable OS credential store.
 *
 * Encrypted with the platform's own facility — DPAPI on Windows, the Keychain
 * on macOS — so the ciphertext is bound to this user account rather than
 * protected by a key sitting next to it. Weaker than the keychain, because the
 * file is ours and therefore ours to lose, but categorically different from
 * plaintext, which is the option that does not exist.
 */
export function createEncryptedFileVault(
  encryption: EncryptionApi,
  directory: string,
): CredentialVault {
  if (!encryption.isEncryptionAvailable()) {
    throw new VaultError('platform encryption is not available');
  }

  const pathFor = (credentialRef: string): string =>
    join(directory, `${assertRef(credentialRef)}.bin`);

  return {
    backend: 'encrypted-file',
    description: `platform-encrypted files in ${directory}`,

    set(credentialRef, secret) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(pathFor(credentialRef), encryption.encryptString(secret));
      return Promise.resolve();
    },

    get(credentialRef) {
      const path = pathFor(credentialRef);
      if (!existsSync(path)) return Promise.resolve(undefined);
      try {
        return Promise.resolve(encryption.decryptString(readFileSync(path)));
      } catch (error) {
        // Written under a different OS user, or a different machine.
        return Promise.reject(
          new VaultError(`could not decrypt the stored secret for ${credentialRef}`, {
            cause: error,
          }),
        );
      }
    },

    delete(credentialRef) {
      const path = pathFor(credentialRef);
      if (!existsSync(path)) return Promise.resolve(false);
      rmSync(path, { force: true });
      return Promise.resolve(true);
    },
  };
}

/** In-process only, for tests. Nothing here survives the process. */
export function createMemoryVault(): CredentialVault {
  const secrets = new Map<string, string>();
  return {
    backend: 'memory',
    description: 'in-memory only; nothing is persisted',

    set(credentialRef, secret) {
      secrets.set(assertRef(credentialRef), secret);
      return Promise.resolve();
    },
    get(credentialRef) {
      return Promise.resolve(secrets.get(assertRef(credentialRef)));
    },
    delete(credentialRef) {
      return Promise.resolve(secrets.delete(assertRef(credentialRef)));
    },
  };
}

/**
 * A vault that refuses to store anything.
 *
 * Returned when no secure backend exists, so the app still opens and can say
 * why credentials cannot be saved. Writing the secret to disk unprotected would
 * be the alternative, and it is not on the table.
 */
export function createUnavailableVault(reason: string): CredentialVault {
  return {
    backend: 'none',
    description: `unavailable: ${reason}`,
    set() {
      return Promise.reject(new VaultUnavailableError(reason));
    },
    get() {
      return Promise.reject(new VaultUnavailableError(reason));
    },
    delete() {
      return Promise.reject(new VaultUnavailableError(reason));
    },
  };
}

export interface VaultSelection {
  readonly vault: CredentialVault;
  /** Why the chosen backend was chosen, and what was rejected on the way. */
  readonly notes: readonly string[];
}

export interface SelectVaultOptions {
  /** keytar, when it loaded. */
  readonly keychain?: KeychainApi | undefined;
  /** Electron's `safeStorage`, when the app is running. */
  readonly encryption?: EncryptionApi | undefined;
  /** Where encrypted files go, if it comes to that. */
  readonly directory: string;
  readonly service?: string;
}

/**
 * Picks the strongest available backend: OS keychain, then platform-encrypted
 * files, then nothing at all.
 */
export function selectVault(options: SelectVaultOptions): VaultSelection {
  const notes: string[] = [];

  if (options.keychain) {
    return {
      vault: createKeychainVault(options.keychain, options.service),
      notes: ['using the OS credential store'],
    };
  }
  notes.push('the OS credential store could not be loaded');

  if (options.encryption) {
    try {
      const vault = createEncryptedFileVault(options.encryption, options.directory);
      notes.push('falling back to platform-encrypted files');
      return { vault, notes };
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    notes.push('platform encryption was not offered');
  }

  return { vault: createUnavailableVault(notes.join('; ')), notes };
}

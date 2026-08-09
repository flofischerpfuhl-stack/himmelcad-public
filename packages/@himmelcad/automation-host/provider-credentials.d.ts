export type ProviderCredentialState =
  | 'missing'
  | 'ready'
  | 'sessionOnly'
  | 'secureStorageUnavailable'
  | 'temporarilyUnavailable'
  | 'corrupt'
  | 'unsupportedSchema';

export interface ProviderCredentialStatus {
  readonly schemaVersion: 1;
  readonly provider: 'codex';
  readonly origin: string;
  readonly state: ProviderCredentialState;
  readonly persistence: 'none' | 'secure' | 'session';
  readonly securePersistenceAvailable: boolean;
  readonly hasPersistedEntry: boolean;
  readonly revision: number;
}

export type ProviderCredentialErrorCode =
  | 'invalidRequest'
  | 'secureStorageUnavailable'
  | 'temporarilyUnavailable'
  | 'corrupt'
  | 'unsupportedSchema'
  | 'persistenceFailed';

export class ProviderCredentialError extends Error {
  readonly code: ProviderCredentialErrorCode;
}

export interface SafeStorageAdapter {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ readonly shouldReEncrypt: boolean; readonly result: string }>;
  getSelectedStorageBackend?():
    | 'basic_text'
    | 'gnome_libsecret'
    | 'kwallet'
    | 'kwallet5'
    | 'kwallet6'
    | 'unknown';
}

export interface ProviderCredentialStoreOptions {
  readonly path: string;
  readonly origin: string;
  readonly platform?: NodeJS.Platform;
  readonly safeStorage: SafeStorageAdapter;
  readonly filesystem?: Partial<
    Pick<
      typeof import('node:fs/promises'),
      'chmod' | 'lstat' | 'mkdir' | 'open' | 'readFile' | 'rename' | 'unlink'
    >
  >;
  readonly randomUUID?: () => string;
}

export class ProviderCredentialStore {
  constructor(options: ProviderCredentialStoreOptions);

  status(provider?: 'codex'): Promise<ProviderCredentialStatus>;
  replace(request: {
    readonly provider: 'codex';
    readonly credential: string;
    readonly persistence: 'secure' | 'session';
  }): Promise<ProviderCredentialStatus>;
  clearSession(provider?: 'codex'): Promise<ProviderCredentialStatus>;
  delete(provider?: 'codex'): Promise<ProviderCredentialStatus>;
  getAuthorization(request: {
    readonly provider: 'codex';
    readonly origin: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }): Promise<Buffer | null>;
  authorizationAvailable(request: {
    readonly provider: 'codex';
    readonly origin: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }): Promise<boolean>;
  close(): void;
}

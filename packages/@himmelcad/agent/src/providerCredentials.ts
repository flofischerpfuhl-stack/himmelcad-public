export type ProviderCredentialId = 'codex';

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
  readonly provider: ProviderCredentialId;
  readonly origin: string;
  readonly state: ProviderCredentialState;
  readonly persistence: 'none' | 'secure' | 'session';
  readonly securePersistenceAvailable: boolean;
  readonly hasPersistedEntry: boolean;
  readonly revision: number;
}

export type ProviderCredentialPublicErrorCode =
  | 'invalidRequest'
  | 'secureStorageUnavailable'
  | 'temporarilyUnavailable'
  | 'corrupt'
  | 'unsupportedSchema'
  | 'persistenceFailed';

export type ProviderCredentialResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ProviderCredentialPublicErrorCode } };

export interface ProviderCredentialRendererTransport {
  status(
    provider: ProviderCredentialId,
  ): Promise<ProviderCredentialResponse<ProviderCredentialStatus>>;
  replace(request: {
    readonly provider: ProviderCredentialId;
    readonly credential: string;
    readonly persistence: 'secure' | 'session';
  }): Promise<ProviderCredentialResponse<ProviderCredentialStatus>>;
  clearSession(
    provider: ProviderCredentialId,
  ): Promise<ProviderCredentialResponse<ProviderCredentialStatus>>;
  delete(
    provider: ProviderCredentialId,
  ): Promise<ProviderCredentialResponse<ProviderCredentialStatus>>;
}

export interface ProviderCredentialPresentation {
  readonly tone: 'neutral' | 'success' | 'warning' | 'danger';
  readonly title: string;
  readonly detail: string;
  readonly canUseProvider: boolean;
  readonly canReplace: boolean;
  readonly canDelete: boolean;
}

export function providerNetworkMode(
  credentialUsable: boolean,
  providerOnlyCapability: boolean,
): 'disabled' | 'providerOnly' {
  return credentialUsable && providerOnlyCapability ? 'providerOnly' : 'disabled';
}

export function providerCredentialPresentation(
  status: ProviderCredentialStatus,
): ProviderCredentialPresentation {
  switch (status.state) {
    case 'missing':
      return {
        tone: 'neutral',
        title: 'Provider access is not configured',
        detail: 'Add an OpenAI API key before starting a Codex turn.',
        canUseProvider: false,
        canReplace: true,
        canDelete: false,
      };
    case 'ready':
      return {
        tone: 'success',
        title: 'Provider access is configured',
        detail: 'The API key is protected by operating-system credential storage.',
        canUseProvider: true,
        canReplace: true,
        canDelete: true,
      };
    case 'sessionOnly':
      return {
        tone: 'warning',
        title: 'Provider access is available for this session',
        detail: status.hasPersistedEntry
          ? 'A temporary API key overrides the retained stored credential until this app closes.'
          : 'The API key will be forgotten when this app closes.',
        canUseProvider: true,
        canReplace: true,
        canDelete: true,
      };
    case 'secureStorageUnavailable':
      return {
        tone: 'warning',
        title: 'Secure credential storage is unavailable',
        detail: status.hasPersistedEntry
          ? 'The stored key is retained but cannot be used. Unlock the OS keyring or use a temporary key.'
          : 'Use a temporary key for this app session or enable an OS keyring.',
        canUseProvider: false,
        canReplace: true,
        canDelete: status.hasPersistedEntry,
      };
    case 'temporarilyUnavailable':
      return {
        tone: 'warning',
        title: 'Credential storage is locked',
        detail: 'Unlock the operating-system keyring, then retry.',
        canUseProvider: false,
        canReplace: false,
        canDelete: true,
      };
    case 'corrupt':
      return {
        tone: 'danger',
        title: 'Stored credential cannot be decrypted',
        detail: 'Remove the unreadable credential before adding a new key.',
        canUseProvider: false,
        canReplace: false,
        canDelete: true,
      };
    case 'unsupportedSchema':
      return {
        tone: 'danger',
        title: 'Stored credential is from an unsupported version',
        detail: 'Update HimmelCAD or remove the stored credential before adding a new key.',
        canUseProvider: false,
        canReplace: false,
        canDelete: true,
      };
    default:
      return assertNever(status.state);
  }
}

export function providerCredentialErrorMessage(code: ProviderCredentialPublicErrorCode): string {
  switch (code) {
    case 'invalidRequest':
      return 'The API key is invalid.';
    case 'secureStorageUnavailable':
      return 'Secure credential storage is unavailable.';
    case 'temporarilyUnavailable':
      return 'Credential storage is temporarily unavailable. Unlock it and retry.';
    case 'corrupt':
      return 'The stored credential cannot be decrypted.';
    case 'unsupportedSchema':
      return 'The stored credential uses an unsupported version.';
    case 'persistenceFailed':
      return 'The credential could not be saved.';
    default:
      return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled provider credential state: ${String(value)}`);
}

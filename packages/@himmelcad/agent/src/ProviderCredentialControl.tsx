import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react';

import {
  providerCredentialErrorMessage,
  providerCredentialPresentation,
  type ProviderCredentialId,
  type ProviderCredentialPublicErrorCode,
  type ProviderCredentialRendererTransport,
  type ProviderCredentialStatus,
} from './providerCredentials.js';

import styles from './ProviderCredentialControl.module.css';

const MAX_CREDENTIAL_CHARACTERS = 8 * 1024;

export function ProviderCredentialControl({
  transport,
  provider = 'codex',
  onUsabilityChange,
  onCredentialMutation,
  onCredentialChange,
}: {
  readonly transport: ProviderCredentialRendererTransport;
  readonly provider?: ProviderCredentialId;
  readonly onUsabilityChange?: (usable: boolean) => void;
  readonly onCredentialMutation?: () => void;
  readonly onCredentialChange?: (status: ProviderCredentialStatus) => void;
}): JSX.Element {
  const titleId = useId();
  const detailId = useId();
  const [status, setStatus] = useState<ProviderCredentialStatus | null>(null);
  const [credential, setCredential] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [errorCode, setErrorCode] = useState<ProviderCredentialPublicErrorCode | null>(null);
  const usabilityCallbackRef = useRef(onUsabilityChange);
  usabilityCallbackRef.current = onUsabilityChange;

  const applyStatus = (next: ProviderCredentialStatus): void => {
    setStatus(next);
    usabilityCallbackRef.current?.(providerCredentialPresentation(next).canUseProvider);
  };

  const refresh = (): void => {
    setBusy(true);
    setErrorCode(null);
    void transport
      .status(provider)
      .then(
        (response) => {
          if (response.ok) applyStatus(response.value);
          else setErrorCode(response.error.code);
        },
        () => setErrorCode('persistenceFailed'),
      )
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    let active = true;
    setStatus(null);
    setErrorCode(null);
    setBusy(true);
    usabilityCallbackRef.current?.(false);
    void transport
      .status(provider)
      .then(
        (response) => {
          if (!active) return;
          if (response.ok) {
            setStatus(response.value);
            usabilityCallbackRef.current?.(
              providerCredentialPresentation(response.value).canUseProvider,
            );
          } else {
            setErrorCode(response.error.code);
          }
        },
        () => {
          if (active) setErrorCode('persistenceFailed');
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [provider, transport]);

  const presentation = status ? providerCredentialPresentation(status) : null;
  const persistentSaveAvailable = status?.securePersistenceAvailable === true;

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || credential.length === 0) return;
    const form = new FormData(event.currentTarget);
    const requestedPersistence = form.get('persistence');
    const persistence =
      persistentSaveAvailable && requestedPersistence === 'secure' ? 'secure' : 'session';
    onCredentialMutation?.();
    setBusy(true);
    setErrorCode(null);
    void transport
      .replace({ provider, credential, persistence })
      .then(
        (response) => {
          if (response.ok) {
            applyStatus(response.value);
            onCredentialChange?.(response.value);
            setCredential('');
            setEditing(false);
          } else {
            setErrorCode(response.error.code);
          }
        },
        () => setErrorCode('persistenceFailed'),
      )
      .finally(() => setBusy(false));
  };

  const clearSession = (): void => {
    if (busy) return;
    onCredentialMutation?.();
    setBusy(true);
    setErrorCode(null);
    void transport
      .clearSession(provider)
      .then(
        (response) => {
          if (response.ok) {
            applyStatus(response.value);
            onCredentialChange?.(response.value);
          } else setErrorCode(response.error.code);
        },
        () => setErrorCode('persistenceFailed'),
      )
      .finally(() => setBusy(false));
  };

  const remove = (): void => {
    if (busy) return;
    onCredentialMutation?.();
    setBusy(true);
    setErrorCode(null);
    void transport
      .delete(provider)
      .then(
        (response) => {
          if (response.ok) {
            applyStatus(response.value);
            onCredentialChange?.(response.value);
            setCredential('');
            setEditing(false);
            setConfirmDelete(false);
          } else {
            setErrorCode(response.error.code);
          }
        },
        () => setErrorCode('persistenceFailed'),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section
      className={styles.root}
      aria-labelledby={titleId}
      data-tone={presentation?.tone ?? 'neutral'}
    >
      <div className={styles.summary}>
        <span className={styles.indicator} aria-hidden="true" />
        <div>
          <h3 id={titleId}>{presentation?.title ?? 'Checking provider access…'}</h3>
          <p id={detailId}>
            {presentation?.detail ?? 'Checking operating-system credential storage.'}
          </p>
        </div>
      </div>

      {errorCode ? (
        <p className={styles.error} role="alert">
          {providerCredentialErrorMessage(errorCode)}
        </p>
      ) : null}

      {editing && presentation?.canReplace ? (
        <form className={styles.form} onSubmit={save}>
          <label htmlFor={`${titleId}-credential`}>OpenAI API key</label>
          <input
            id={`${titleId}-credential`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_CREDENTIAL_CHARACTERS}
            value={credential}
            aria-describedby={detailId}
            onChange={(event) =>
              setCredential(event.currentTarget.value.slice(0, MAX_CREDENTIAL_CHARACTERS))
            }
          />
          <label className={styles.persistenceChoice}>
            <input
              type="radio"
              name="persistence"
              value="secure"
              defaultChecked={persistentSaveAvailable}
              disabled={!persistentSaveAvailable}
            />
            Save with OS credential storage
          </label>
          <label className={styles.persistenceChoice}>
            <input
              type="radio"
              name="persistence"
              value="session"
              defaultChecked={!persistentSaveAvailable}
            />
            Use until this app closes
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setCredential('');
                setEditing(false);
                setErrorCode(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" disabled={busy || credential.length === 0}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          {presentation?.canReplace ? (
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              {status?.state === 'missing' ? 'Configure' : 'Replace'}
            </button>
          ) : null}
          {status?.state === 'sessionOnly' && status.hasPersistedEntry ? (
            <button type="button" disabled={busy} onClick={clearSession}>
              Stop temporary override
            </button>
          ) : null}
          {presentation?.canDelete ? (
            confirmDelete ? (
              <>
                <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Cancel removal
                </button>
                <button className={styles.danger} type="button" disabled={busy} onClick={remove}>
                  {busy ? 'Removing…' : 'Remove now'}
                </button>
              </>
            ) : (
              <button
                className={styles.danger}
                type="button"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                Remove
              </button>
            )
          ) : null}
          {status?.state === 'temporarilyUnavailable' ? (
            <button type="button" disabled={busy} onClick={refresh}>
              Retry
            </button>
          ) : null}
        </div>
      )}
      <span className={styles.liveStatus} role="status" aria-live="polite">
        {busy ? 'Provider credential operation in progress.' : ''}
      </span>
    </section>
  );
}

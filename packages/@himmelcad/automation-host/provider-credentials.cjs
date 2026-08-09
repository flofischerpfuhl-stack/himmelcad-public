'use strict';

const { randomUUID } = require('node:crypto');
const nodeFilesystem = require('node:fs/promises');
const { dirname, isAbsolute } = require('node:path');

const DOCUMENT_SCHEMA_VERSION = 1;
const ENVELOPE_SCHEMA_VERSION = 1;
const ENTRY_FORMAT = 'electron-safe-storage-async-v1';
const PROVIDER = 'codex';
const AUTHORIZATION_SCHEME = 'Bearer';
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 8 * 1024;
const TEMPORARILY_UNAVAILABLE_MESSAGE = 'safestorage.decryptstringasync is temporarily unavailable';
const SECURE_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const PUBLIC_ERROR_MESSAGES = Object.freeze({
  invalidRequest: 'Provider credential request is invalid.',
  secureStorageUnavailable: 'Secure operating-system credential storage is unavailable.',
  temporarilyUnavailable: 'Secure operating-system credential storage is temporarily unavailable.',
  corrupt: 'The stored provider credential cannot be decrypted or validated.',
  unsupportedSchema: 'The stored provider credential uses an unsupported schema.',
  persistenceFailed: 'The provider credential store could not be persisted.',
});

class ProviderCredentialError extends Error {
  constructor(code) {
    super(PUBLIC_ERROR_MESSAGES[code] ?? PUBLIC_ERROR_MESSAGES.persistenceFailed);
    this.name = 'ProviderCredentialError';
    this.code = code;
  }
}

/**
 * Main-process-only provider credential storage. Renderer-facing callers must
 * use a separate status/mutation facade and never receive getAuthorization.
 */
class ProviderCredentialStore {
  #path;
  #origin;
  #platform;
  #safeStorage;
  #filesystem;
  #randomUUID;
  #writes = Promise.resolve();
  #sessionCredential = null;
  #closed = false;

  constructor(options) {
    if (!isRecord(options) || typeof options.path !== 'string' || !isAbsolute(options.path)) {
      throw new ProviderCredentialError('invalidRequest');
    }
    if (!isRecord(options.safeStorage)) {
      throw new ProviderCredentialError('invalidRequest');
    }
    for (const method of [
      'isAsyncEncryptionAvailable',
      'encryptStringAsync',
      'decryptStringAsync',
    ]) {
      if (typeof options.safeStorage[method] !== 'function') {
        throw new ProviderCredentialError('invalidRequest');
      }
    }
    this.#path = options.path;
    this.#origin = parseProviderOrigin(options.origin);
    this.#platform = options.platform ?? process.platform;
    this.#safeStorage = options.safeStorage;
    this.#filesystem = { ...nodeFilesystem, ...(options.filesystem ?? {}) };
    this.#randomUUID = options.randomUUID ?? randomUUID;
    if (typeof this.#randomUUID !== 'function') {
      throw new ProviderCredentialError('invalidRequest');
    }
  }

  async status(provider = PROVIDER) {
    assertProvider(provider);
    this.#assertOpen();
    await this.#writes;
    return await this.#statusUnsafe();
  }

  async replace(request) {
    if (!isRecord(request)) throw new ProviderCredentialError('invalidRequest');
    assertProvider(request.provider);
    const credential = parseCredential(request.credential);
    if (request.persistence !== 'secure' && request.persistence !== 'session') {
      throw new ProviderCredentialError('invalidRequest');
    }
    this.#assertOpen();
    return await this.#enqueue(async () => {
      this.#assertOpen();
      if (request.persistence === 'session') {
        this.#replaceSessionCredential(Buffer.from(credential, 'ascii'));
        return await this.#statusUnsafe();
      }

      if (!(await this.#securePersistenceAvailable())) {
        throw new ProviderCredentialError('secureStorageUnavailable');
      }
      const loaded = await this.#loadDocument();
      if (loaded.kind === 'corrupt') throw new ProviderCredentialError('corrupt');
      if (loaded.kind === 'unsupportedSchema') {
        throw new ProviderCredentialError('unsupportedSchema');
      }
      const document = loaded.document;
      const existing = document.entries[PROVIDER];
      if (existing) {
        const inspected = await this.#decryptEntry(existing);
        if (inspected.kind === 'temporarilyUnavailable') {
          throw new ProviderCredentialError('temporarilyUnavailable');
        }
        if (inspected.kind !== 'ok') throw new ProviderCredentialError('corrupt');
      }
      const plaintext = JSON.stringify({
        schemaVersion: ENVELOPE_SCHEMA_VERSION,
        provider: PROVIDER,
        origin: this.#origin,
        authorizationScheme: AUTHORIZATION_SCHEME,
        credential,
      });
      let ciphertext;
      try {
        ciphertext = await this.#safeStorage.encryptStringAsync(plaintext);
      } catch {
        throw new ProviderCredentialError('temporarilyUnavailable');
      }
      this.#assertOpen();
      const entry = encodeEntry(ciphertext);
      const next = {
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        revision: document.revision + 1,
        entries: { [PROVIDER]: entry },
      };
      await this.#writeDocument(next);
      this.#clearSessionCredential();
      return publicStatus({
        state: 'ready',
        persistence: 'secure',
        securePersistenceAvailable: true,
        hasPersistedEntry: true,
        revision: next.revision,
        origin: this.#origin,
      });
    });
  }

  async clearSession(provider = PROVIDER) {
    assertProvider(provider);
    this.#assertOpen();
    return await this.#enqueue(async () => {
      this.#assertOpen();
      this.#clearSessionCredential();
      return await this.#statusUnsafe();
    });
  }

  async delete(provider = PROVIDER) {
    assertProvider(provider);
    this.#assertOpen();
    return await this.#enqueue(async () => {
      this.#assertOpen();
      this.#clearSessionCredential();
      const loaded = await this.#loadDocument();
      const revision =
        loaded.kind === 'ok' || loaded.kind === 'missing' ? loaded.document.revision + 1 : 1;
      await this.#writeDocument(emptyDocument(revision));
      const securePersistenceAvailable = await this.#securePersistenceAvailable();
      return publicStatus({
        state: securePersistenceAvailable ? 'missing' : 'secureStorageUnavailable',
        persistence: 'none',
        securePersistenceAvailable,
        hasPersistedEntry: false,
        revision,
        origin: this.#origin,
      });
    });
  }

  async getAuthorization(request) {
    if (
      !validAuthorizationRequest(request, this.#origin) ||
      request.signal.aborted ||
      this.#closed
    ) {
      return null;
    }
    try {
      return await this.#enqueue(async () => {
        if (request.signal.aborted || this.#closed) return null;
        if (this.#sessionCredential) {
          return authorizationBuffer(this.#sessionCredential);
        }
        if (!(await this.#securePersistenceAvailable()) || request.signal.aborted || this.#closed)
          return null;
        const loaded = await this.#loadDocument();
        if (loaded.kind !== 'ok') return null;
        const entry = loaded.document.entries[PROVIDER];
        if (!entry) return null;
        const decrypted = await this.#decryptEntry(entry);
        if (decrypted.kind !== 'ok' || request.signal.aborted || this.#closed) return null;
        if (decrypted.shouldReEncrypt) {
          let ciphertext;
          try {
            ciphertext = await this.#safeStorage.encryptStringAsync(decrypted.plaintext);
          } catch {
            return null;
          }
          const next = {
            schemaVersion: DOCUMENT_SCHEMA_VERSION,
            revision: loaded.document.revision + 1,
            entries: { [PROVIDER]: encodeEntry(ciphertext) },
          };
          await this.#writeDocument(next);
        }
        if (request.signal.aborted || this.#closed) return null;
        const token = Buffer.from(decrypted.envelope.credential, 'ascii');
        try {
          return authorizationBuffer(token);
        } finally {
          token.fill(0);
        }
      });
    } catch {
      return null;
    }
  }

  async authorizationAvailable(request) {
    if (
      !validAuthorizationRequest(request, this.#origin) ||
      request.signal.aborted ||
      this.#closed
    ) {
      return false;
    }
    return await failClosedOnAbort(request.signal, async () => {
      try {
        await this.#writes;
        if (request.signal.aborted || this.#closed) return false;
        if (this.#sessionCredential) return true;
        if (!(await this.#securePersistenceAvailable()) || request.signal.aborted || this.#closed) {
          return false;
        }
        const loaded = await this.#loadDocument();
        return (
          loaded.kind === 'ok' &&
          loaded.document.entries[PROVIDER] !== undefined &&
          !request.signal.aborted &&
          !this.#closed
        );
      } catch {
        return false;
      }
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearSessionCredential();
  }

  async #statusUnsafe() {
    const securePersistenceAvailable = await this.#securePersistenceAvailable();
    const loaded = await this.#loadDocument();
    const persisted = loaded.kind === 'ok' && loaded.document.entries[PROVIDER] !== undefined;
    const revision =
      loaded.kind === 'ok' || loaded.kind === 'missing' ? loaded.document.revision : 0;

    if (this.#sessionCredential) {
      return publicStatus({
        state: 'sessionOnly',
        persistence: 'session',
        securePersistenceAvailable,
        hasPersistedEntry:
          persisted || loaded.kind === 'corrupt' || loaded.kind === 'unsupportedSchema',
        revision,
        origin: this.#origin,
      });
    }
    if (loaded.kind === 'corrupt') {
      return publicStatus({
        state: 'corrupt',
        persistence: 'none',
        securePersistenceAvailable,
        hasPersistedEntry: true,
        revision: 0,
        origin: this.#origin,
      });
    }
    if (loaded.kind === 'unsupportedSchema') {
      return publicStatus({
        state: 'unsupportedSchema',
        persistence: 'none',
        securePersistenceAvailable,
        hasPersistedEntry: true,
        revision: 0,
        origin: this.#origin,
      });
    }
    if (!persisted) {
      return publicStatus({
        state: securePersistenceAvailable ? 'missing' : 'secureStorageUnavailable',
        persistence: 'none',
        securePersistenceAvailable,
        hasPersistedEntry: false,
        revision,
        origin: this.#origin,
      });
    }
    if (!securePersistenceAvailable) {
      return publicStatus({
        state: 'secureStorageUnavailable',
        persistence: 'none',
        securePersistenceAvailable: false,
        hasPersistedEntry: true,
        revision,
        origin: this.#origin,
      });
    }
    const decrypted = await this.#decryptEntry(loaded.document.entries[PROVIDER]);
    return publicStatus({
      state:
        decrypted.kind === 'ok'
          ? 'ready'
          : decrypted.kind === 'temporarilyUnavailable'
            ? 'temporarilyUnavailable'
            : 'corrupt',
      persistence: decrypted.kind === 'ok' ? 'secure' : 'none',
      securePersistenceAvailable: true,
      hasPersistedEntry: true,
      revision,
      origin: this.#origin,
    });
  }

  async #securePersistenceAvailable() {
    if (this.#platform === 'linux') {
      if (typeof this.#safeStorage.getSelectedStorageBackend !== 'function') return false;
      let backend;
      try {
        backend = this.#safeStorage.getSelectedStorageBackend();
      } catch {
        return false;
      }
      if (!SECURE_LINUX_BACKENDS.has(backend)) return false;
    }
    try {
      return (await this.#safeStorage.isAsyncEncryptionAvailable()) === true;
    } catch {
      return false;
    }
  }

  async #decryptEntry(entry) {
    let decoded;
    try {
      decoded = decodeEntry(entry);
    } catch {
      return { kind: 'corrupt' };
    }
    let result;
    try {
      result = await this.#safeStorage.decryptStringAsync(decoded);
    } catch (error) {
      return isTemporarilyUnavailable(error)
        ? { kind: 'temporarilyUnavailable' }
        : { kind: 'corrupt' };
    }
    if (
      !isRecord(result) ||
      typeof result.result !== 'string' ||
      typeof result.shouldReEncrypt !== 'boolean'
    ) {
      return { kind: 'corrupt' };
    }
    let envelope;
    try {
      envelope = parseEnvelope(JSON.parse(result.result), this.#origin);
    } catch {
      return { kind: 'corrupt' };
    }
    return {
      kind: 'ok',
      envelope,
      plaintext: result.result,
      shouldReEncrypt: result.shouldReEncrypt,
    };
  }

  async #loadDocument() {
    let metadata;
    try {
      metadata = await this.#filesystem.lstat(this.#path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { kind: 'missing', document: emptyDocument(0) };
      throw new ProviderCredentialError('persistenceFailed');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DOCUMENT_BYTES) {
      return { kind: 'corrupt' };
    }
    let bytes;
    try {
      bytes = await this.#filesystem.readFile(this.#path);
    } catch {
      throw new ProviderCredentialError('persistenceFailed');
    }
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (bytes.length > MAX_DOCUMENT_BYTES) return { kind: 'corrupt' };
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { kind: 'corrupt' };
    }
    return parseDocument(value);
  }

  async #writeDocument(document) {
    const directory = dirname(this.#path);
    const nonce = this.#randomUUID();
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(nonce)) {
      throw new ProviderCredentialError('persistenceFailed');
    }
    const temporaryPath = `${this.#path}.${process.pid}.${nonce}.tmp`;
    let handle = null;
    try {
      await this.#filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryMetadata = await this.#filesystem.lstat(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new ProviderCredentialError('persistenceFailed');
      }
      if (this.#platform !== 'win32' && typeof this.#filesystem.chmod === 'function') {
        await this.#filesystem.chmod(directory, 0o700);
      }
      const encoded = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      if (encoded.length > MAX_DOCUMENT_BYTES)
        throw new ProviderCredentialError('persistenceFailed');
      handle = await this.#filesystem.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.#filesystem.rename(temporaryPath, this.#path);
      await syncDirectory(this.#filesystem, directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await this.#filesystem.unlink(temporaryPath).catch(() => undefined);
      if (error instanceof ProviderCredentialError) throw error;
      throw new ProviderCredentialError('persistenceFailed');
    }
  }

  #enqueue(operation) {
    const pending = this.#writes.then(operation);
    this.#writes = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  #replaceSessionCredential(next) {
    this.#clearSessionCredential();
    this.#sessionCredential = next;
  }

  #clearSessionCredential() {
    this.#sessionCredential?.fill(0);
    this.#sessionCredential = null;
  }

  #assertOpen() {
    if (this.#closed) throw new ProviderCredentialError('invalidRequest');
  }
}

function emptyDocument(revision) {
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, revision, entries: {} };
}

function parseDocument(value) {
  if (!isRecord(value)) return { kind: 'corrupt' };
  if (value.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    return { kind: 'unsupportedSchema' };
  }
  if (!hasExactKeys(value, ['entries', 'revision', 'schemaVersion'])) return { kind: 'corrupt' };
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !isRecord(value.entries)) {
    return { kind: 'corrupt' };
  }
  const entryKeys = Object.keys(value.entries);
  if (entryKeys.some((key) => key !== PROVIDER) || entryKeys.length > 1) {
    return { kind: 'corrupt' };
  }
  const entries = {};
  if (value.entries[PROVIDER] !== undefined) {
    const entry = value.entries[PROVIDER];
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['ciphertextBase64', 'format']) ||
      entry.format !== ENTRY_FORMAT ||
      typeof entry.ciphertextBase64 !== 'string' ||
      !isCanonicalBase64(entry.ciphertextBase64)
    ) {
      return { kind: 'corrupt' };
    }
    const ciphertextBytes = Buffer.from(entry.ciphertextBase64, 'base64').length;
    if (ciphertextBytes === 0 || ciphertextBytes > MAX_CIPHERTEXT_BYTES) {
      return { kind: 'corrupt' };
    }
    entries[PROVIDER] = {
      format: ENTRY_FORMAT,
      ciphertextBase64: entry.ciphertextBase64,
    };
  }
  return {
    kind: 'ok',
    document: {
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      revision: value.revision,
      entries,
    },
  };
}

function parseEnvelope(value, expectedOrigin) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'authorizationScheme',
      'credential',
      'origin',
      'provider',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== ENVELOPE_SCHEMA_VERSION ||
    value.provider !== PROVIDER ||
    value.origin !== expectedOrigin ||
    value.authorizationScheme !== AUTHORIZATION_SCHEME
  ) {
    throw new ProviderCredentialError('corrupt');
  }
  return { ...value, credential: parseCredential(value.credential) };
}

function encodeEntry(ciphertext) {
  if (!Buffer.isBuffer(ciphertext)) ciphertext = Buffer.from(ciphertext);
  if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new ProviderCredentialError('persistenceFailed');
  }
  return { format: ENTRY_FORMAT, ciphertextBase64: ciphertext.toString('base64') };
}

function decodeEntry(entry) {
  if (
    !isRecord(entry) ||
    entry.format !== ENTRY_FORMAT ||
    typeof entry.ciphertextBase64 !== 'string' ||
    !isCanonicalBase64(entry.ciphertextBase64)
  ) {
    throw new ProviderCredentialError('corrupt');
  }
  const bytes = Buffer.from(entry.ciphertextBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_CIPHERTEXT_BYTES) {
    throw new ProviderCredentialError('corrupt');
  }
  return bytes;
}

function parseProviderOrigin(value) {
  if (typeof value !== 'string') throw new ProviderCredentialError('invalidRequest');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderCredentialError('invalidRequest');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new ProviderCredentialError('invalidRequest');
  }
  return parsed.origin;
}

function parseCredential(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES ||
    !/^[\x21-\x7E]+$/u.test(value)
  ) {
    throw new ProviderCredentialError('invalidRequest');
  }
  return value;
}

function assertProvider(value) {
  if (value !== PROVIDER) throw new ProviderCredentialError('invalidRequest');
}

function validAuthorizationRequest(request, origin) {
  return (
    isRecord(request) &&
    request.provider === PROVIDER &&
    request.origin === origin &&
    typeof request.sessionId === 'string' &&
    request.sessionId.length > 0 &&
    request.sessionId.length <= 512 &&
    isAbortSignal(request.signal)
  );
}

function failClosedOnAbort(signal, operation) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolvePromise(value === true);
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      finish(false);
      return;
    }
    void Promise.resolve()
      .then(operation)
      .then(finish, () => finish(false));
  });
}

function publicStatus(input) {
  return Object.freeze({
    schemaVersion: 1,
    provider: PROVIDER,
    origin: input.origin,
    state: input.state,
    persistence: input.persistence,
    securePersistenceAvailable: input.securePersistenceAvailable,
    hasPersistedEntry: input.hasPersistedEntry,
    revision: input.revision,
  });
}

function authorizationBuffer(token) {
  const prefix = Buffer.from(`${AUTHORIZATION_SCHEME} `, 'ascii');
  const output = Buffer.allocUnsafe(prefix.length + token.length);
  prefix.copy(output, 0);
  token.copy(output, prefix.length);
  prefix.fill(0);
  return output;
}

function isAbortSignal(value) {
  return isRecord(value) && typeof value.aborted === 'boolean';
}

function isTemporarilyUnavailable(error) {
  return (
    error instanceof Error && error.message.toLowerCase().includes(TEMPORARILY_UNAVAILABLE_MESSAGE)
  );
}

function isCanonicalBase64(value) {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function syncDirectory(filesystem, directory) {
  let handle = null;
  try {
    handle = await filesystem.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

module.exports = {
  ProviderCredentialError,
  ProviderCredentialStore,
};

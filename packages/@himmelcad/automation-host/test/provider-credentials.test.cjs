'use strict';

const assert = require('node:assert/strict');
const {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { ProviderCredentialError, ProviderCredentialStore } = require('../provider-credentials.cjs');

const ORIGIN = 'https://api.openai.com';
const SECRET = 'sk-test-provider-sentinel-123';

test('secure storage persists only ciphertext and returns authorization only to the host', async (context) => {
  const fixture = await createFixture(context);
  const status = await fixture.store.replace({
    provider: 'codex',
    credential: SECRET,
    persistence: 'secure',
  });
  assert.deepEqual(status, {
    schemaVersion: 1,
    provider: 'codex',
    origin: ORIGIN,
    state: 'ready',
    persistence: 'secure',
    securePersistenceAvailable: true,
    hasPersistedEntry: true,
    revision: 1,
  });

  const persisted = await readFile(fixture.path, 'utf8');
  assert.equal(persisted.includes(SECRET), false);
  assert.equal(persisted.includes('Bearer'), false);
  assert.deepEqual(Object.keys(JSON.parse(persisted).entries.codex).sort(), [
    'ciphertextBase64',
    'format',
  ]);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(fixture.path)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(fixture.directory, 'credentials'))).mode & 0o777, 0o700);
  }

  const authorization = await fixture.store.getAuthorization(authRequest());
  assert.equal(authorization?.toString('ascii'), `Bearer ${SECRET}`);
  authorization?.fill(0);
  assert.equal(
    await fixture.store.getAuthorization(authRequest({ origin: 'https://example.com' })),
    null,
  );
  assert.equal(await fixture.store.getAuthorization(authRequest({ provider: 'claude' })), null);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await fixture.store.getAuthorization(authRequest({ signal: aborted.signal })), null);

  const publicJson = JSON.stringify(await fixture.store.status());
  assert.equal(publicJson.includes(SECRET), false);
  assert.equal(publicJson.includes('ciphertext'), false);
});

test('authorization readiness uses only validated store metadata and never decrypts', async (context) => {
  const fixture = await createFixture(context);
  assert.equal(await fixture.store.authorizationAvailable(authRequest()), false);
  await fixture.store.replace({ provider: 'codex', credential: SECRET, persistence: 'secure' });
  const decryptCalls = fixture.safeStorage.decryptCalls;
  assert.equal(await fixture.store.authorizationAvailable(authRequest()), true);
  assert.equal(fixture.safeStorage.decryptCalls, decryptCalls);
  assert.equal(
    await fixture.store.authorizationAvailable(authRequest({ origin: 'https://example.com' })),
    false,
  );
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    await fixture.store.authorizationAvailable(authRequest({ signal: aborted.signal })),
    false,
  );
});

test('authorization readiness observes cancellation while secure storage is pending', async (context) => {
  const fixture = await createFixture(context);
  const store = fixture.newStore({
    safeStorage: {
      getSelectedStorageBackend: () => 'gnome_libsecret',
      isAsyncEncryptionAvailable: () => new Promise(() => {}),
      encryptStringAsync: async () => Buffer.from('unused'),
      decryptStringAsync: async () => ({ shouldReEncrypt: false, result: 'unused' }),
    },
  });
  const controller = new AbortController();
  const readiness = store.authorizationAvailable(authRequest({ signal: controller.signal }));
  controller.abort();
  assert.equal(await readiness, false);
});

test('Linux basic_text refuses persistence and allows an explicit session-only credential', async (context) => {
  const fixture = await createFixture(context, { backend: 'basic_text' });
  await assert.rejects(
    fixture.store.replace({ provider: 'codex', credential: SECRET, persistence: 'secure' }),
    (error) =>
      error instanceof ProviderCredentialError && error.code === 'secureStorageUnavailable',
  );
  await assert.rejects(readFile(fixture.path), { code: 'ENOENT' });

  const status = await fixture.store.replace({
    provider: 'codex',
    credential: SECRET,
    persistence: 'session',
  });
  assert.equal(status.state, 'sessionOnly');
  assert.equal(status.persistence, 'session');
  assert.equal(status.securePersistenceAvailable, false);
  const authorization = await fixture.store.getAuthorization(authRequest());
  assert.equal(authorization?.toString('ascii'), `Bearer ${SECRET}`);
  authorization?.fill(0);

  fixture.store.close();
  assert.equal(await fixture.store.getAuthorization(authRequest()), null);
  await assert.rejects(fixture.store.status(), { code: 'invalidRequest' });
});

test('an insecure Linux fallback preserves existing ciphertext and supports a temporary override', async (context) => {
  const fixture = await createFixture(context);
  await fixture.store.replace({ provider: 'codex', credential: SECRET, persistence: 'secure' });
  const before = await readFile(fixture.path);
  fixture.safeStorage.backend = 'basic_text';
  assert.equal((await fixture.store.status()).state, 'secureStorageUnavailable');

  await fixture.store.replace({
    provider: 'codex',
    credential: 'sk-session-override',
    persistence: 'session',
  });
  assert.deepEqual(await readFile(fixture.path), before);
  const sessionAuthorization = await fixture.store.getAuthorization(authRequest());
  assert.equal(sessionAuthorization?.toString('ascii'), 'Bearer sk-session-override');
  sessionAuthorization?.fill(0);

  const cleared = await fixture.store.clearSession();
  assert.equal(cleared.state, 'secureStorageUnavailable');
  assert.equal(cleared.hasPersistedEntry, true);
  assert.equal(await fixture.store.getAuthorization(authRequest()), null);
  fixture.safeStorage.backend = 'gnome_libsecret';
  assert.equal((await fixture.store.status()).state, 'ready');
});

test('temporary keyring failures and corrupt ciphertext fail closed without overwriting the store', async (context) => {
  const fixture = await createFixture(context);
  await fixture.store.replace({ provider: 'codex', credential: SECRET, persistence: 'secure' });
  const before = await readFile(fixture.path);

  fixture.safeStorage.temporarilyUnavailable = true;
  assert.equal((await fixture.store.status()).state, 'temporarilyUnavailable');
  assert.equal(await fixture.store.getAuthorization(authRequest()), null);
  assert.deepEqual(await readFile(fixture.path), before);

  fixture.safeStorage.temporarilyUnavailable = false;
  const document = JSON.parse(before.toString('utf8'));
  document.entries.codex.ciphertextBase64 =
    Buffer.from('not-a-valid-fake-cipher').toString('base64');
  await writeFile(fixture.path, JSON.stringify(document));
  assert.equal((await fixture.store.status()).state, 'corrupt');
  assert.equal(await fixture.store.getAuthorization(authRequest()), null);
  await assert.rejects(
    fixture.store.replace({ provider: 'codex', credential: 'sk-new', persistence: 'secure' }),
    { code: 'corrupt' },
  );

  const deleted = await fixture.store.delete();
  assert.equal(deleted.state, 'missing');
  assert.deepEqual(JSON.parse(await readFile(fixture.path, 'utf8')).entries, {});
});

test('unknown schemas are retained until explicit deletion', async (context) => {
  const fixture = await createFixture(context);
  await fixture.filesystem.mkdir(join(fixture.directory, 'credentials'), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(fixture.path, JSON.stringify({ schemaVersion: 99, secret: SECRET }));
  const before = await readFile(fixture.path);
  const status = await fixture.store.status();
  assert.equal(status.state, 'unsupportedSchema');
  assert.equal(status.hasPersistedEntry, true);
  assert.deepEqual(await readFile(fixture.path), before);
  await assert.rejects(
    fixture.store.replace({ provider: 'codex', credential: 'sk-new', persistence: 'secure' }),
    { code: 'unsupportedSchema' },
  );
  await fixture.store.delete();
  assert.equal((await fixture.store.status()).state, 'missing');
});

test('key rotation atomically replaces ciphertext before authorization is returned', async (context) => {
  const fixture = await createFixture(context);
  await fixture.store.replace({ provider: 'codex', credential: SECRET, persistence: 'secure' });
  const before = JSON.parse(await readFile(fixture.path, 'utf8'));
  fixture.safeStorage.shouldReEncrypt = true;

  const authorization = await fixture.store.getAuthorization(authRequest());
  assert.equal(authorization?.toString('ascii'), `Bearer ${SECRET}`);
  authorization?.fill(0);
  const after = JSON.parse(await readFile(fixture.path, 'utf8'));
  assert.equal(after.revision, before.revision + 1);
  assert.notEqual(after.entries.codex.ciphertextBase64, before.entries.codex.ciphertextBase64);
});

test('failed atomic replacement leaves the previous credential and no temporary file', async (context) => {
  const fixture = await createFixture(context);
  await fixture.store.replace({ provider: 'codex', credential: SECRET, persistence: 'secure' });
  const before = await readFile(fixture.path);
  let failRename = true;
  const store = fixture.newStore({
    filesystem: {
      rename: async (source, destination) => {
        if (failRename) {
          failRename = false;
          const error = new Error('sensitive path must not escape');
          error.code = 'EIO';
          throw error;
        }
        await rename(source, destination);
      },
    },
  });
  await assert.rejects(
    store.replace({ provider: 'codex', credential: 'sk-replacement', persistence: 'secure' }),
    (error) =>
      error instanceof ProviderCredentialError &&
      error.code === 'persistenceFailed' &&
      !error.message.includes('sensitive path'),
  );
  assert.deepEqual(await readFile(fixture.path), before);
  assert.deepEqual(await readdir(join(fixture.directory, 'credentials')), [
    'provider-credentials.v1.json',
  ]);
});

test('concurrent replacements serialize and the last validated value wins', async (context) => {
  const fixture = await createFixture(context);
  const first = fixture.store.replace({
    provider: 'codex',
    credential: 'sk-first',
    persistence: 'secure',
  });
  const second = fixture.store.replace({
    provider: 'codex',
    credential: 'sk-second',
    persistence: 'secure',
  });
  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.equal(firstStatus.revision, 1);
  assert.equal(secondStatus.revision, 2);
  const authorization = await fixture.store.getAuthorization(authRequest());
  assert.equal(authorization?.toString('ascii'), 'Bearer sk-second');
  authorization?.fill(0);
});

test('strict request and credential validation never reflects supplied secrets', async (context) => {
  const fixture = await createFixture(context);
  for (const credential of [
    '',
    ' leading',
    'trailing ',
    'line\nbreak',
    'ümlaut',
    'x'.repeat(8193),
  ]) {
    await assert.rejects(
      fixture.store.replace({ provider: 'codex', credential, persistence: 'session' }),
      (error) =>
        error instanceof ProviderCredentialError &&
        error.code === 'invalidRequest' &&
        (credential.length === 0 || !error.message.includes(credential.slice(0, 32))),
    );
  }
  await assert.rejects(
    fixture.store.replace({ provider: 'claude', credential: SECRET, persistence: 'session' }),
    { code: 'invalidRequest' },
  );
  assert.throws(() => fixture.newStore({ origin: 'http://api.openai.com' }), {
    code: 'invalidRequest',
  });
});

test('credential files and directories cannot be replaced by symbolic links', async (context) => {
  const fixture = await createFixture(context);
  await fixture.filesystem.mkdir(join(fixture.directory, 'elsewhere'), { recursive: true });
  await fixture.filesystem.mkdir(join(fixture.directory, 'credentials'), { recursive: true });
  await symlink(join(fixture.directory, 'elsewhere', 'credential.json'), fixture.path);
  await writeFile(join(fixture.directory, 'elsewhere', 'credential.json'), '{}');
  assert.equal((await fixture.store.status()).state, 'corrupt');
  await assert.rejects(
    fixture.store.replace({ provider: 'codex', credential: SECRET, persistence: 'secure' }),
    { code: 'corrupt' },
  );
});

async function createFixture(context, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hcad-provider-credentials-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials', 'provider-credentials.v1.json');
  const safeStorage = new FakeSafeStorage(options.backend ?? 'gnome_libsecret');
  const filesystem = require('node:fs/promises');
  let uuid = 0;
  const baseOptions = {
    path,
    origin: ORIGIN,
    platform: 'linux',
    safeStorage,
    filesystem,
    randomUUID: () => `test-${uuid++}`,
  };
  const newStore = (overrides = {}) =>
    new ProviderCredentialStore({
      ...baseOptions,
      ...overrides,
      filesystem: { ...filesystem, ...(overrides.filesystem ?? {}) },
    });
  return {
    directory,
    path,
    safeStorage,
    filesystem,
    newStore,
    store: newStore(),
  };
}

function authRequest(overrides = {}) {
  return {
    provider: 'codex',
    origin: ORIGIN,
    sessionId: 'session-1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

class FakeSafeStorage {
  constructor(backend) {
    this.backend = backend;
    this.available = true;
    this.shouldReEncrypt = false;
    this.temporarilyUnavailable = false;
    this.sequence = 0;
    this.decryptCalls = 0;
  }

  getSelectedStorageBackend() {
    return this.backend;
  }

  async isAsyncEncryptionAvailable() {
    return this.available;
  }

  async encryptStringAsync(plaintext) {
    this.sequence += 1;
    const source = Buffer.from(plaintext, 'utf8');
    const encrypted = Buffer.allocUnsafe(source.length);
    for (let index = 0; index < source.length; index += 1) {
      encrypted[index] = source[index] ^ 0xa5;
    }
    return Buffer.concat([Buffer.from(`fake:${this.sequence}:`, 'ascii'), encrypted]);
  }

  async decryptStringAsync(ciphertext) {
    this.decryptCalls += 1;
    if (this.temporarilyUnavailable) {
      throw new Error(
        'safeStorage.decryptStringAsync is temporarily unavailable. Please try again.',
      );
    }
    const first = ciphertext.indexOf(58);
    const second = ciphertext.indexOf(58, first + 1);
    if (first !== 4 || second < 0 || ciphertext.subarray(0, first).toString('ascii') !== 'fake') {
      throw new Error('fake decrypt failed');
    }
    const encrypted = ciphertext.subarray(second + 1);
    const plaintext = Buffer.allocUnsafe(encrypted.length);
    for (let index = 0; index < encrypted.length; index += 1) {
      plaintext[index] = encrypted[index] ^ 0xa5;
    }
    return {
      shouldReEncrypt: this.shouldReEncrypt,
      result: plaintext.toString('utf8'),
    };
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  providerCredentialErrorMessage,
  providerNetworkMode,
  providerCredentialPresentation,
  type ProviderCredentialPublicErrorCode,
  type ProviderCredentialState,
  type ProviderCredentialStatus,
} from './providerCredentials.js';

test('provider-only network requires both a usable credential and discovered capability', () => {
  assert.equal(providerNetworkMode(false, false), 'disabled');
  assert.equal(providerNetworkMode(true, false), 'disabled');
  assert.equal(providerNetworkMode(false, true), 'disabled');
  assert.equal(providerNetworkMode(true, true), 'providerOnly');
});

test('credential presentation covers every public state without exposing credential material', () => {
  const states: readonly ProviderCredentialState[] = [
    'missing',
    'ready',
    'sessionOnly',
    'secureStorageUnavailable',
    'temporarilyUnavailable',
    'corrupt',
    'unsupportedSchema',
  ];
  const sentinel = 'sk-secret-must-never-render';
  for (const state of states) {
    const presentation = providerCredentialPresentation(status(state));
    assert.equal(JSON.stringify(presentation).includes(sentinel), false);
    assert.ok(presentation.title.length > 0);
    assert.ok(presentation.detail.length > 0);
  }
  assert.equal(providerCredentialPresentation(status('ready')).canUseProvider, true);
  assert.equal(providerCredentialPresentation(status('sessionOnly')).canUseProvider, true);
  assert.equal(providerCredentialPresentation(status('missing')).canUseProvider, false);
  assert.equal(providerCredentialPresentation(status('corrupt')).canReplace, false);
});

test('session-only copy distinguishes an override from a temporary-only credential', () => {
  const temporary = providerCredentialPresentation(status('sessionOnly'));
  const override = providerCredentialPresentation(
    status('sessionOnly', { hasPersistedEntry: true }),
  );
  assert.match(temporary.detail, /forgotten/u);
  assert.match(override.detail, /overrides/u);
});

test('public error copy is bounded and never reflects provider input', () => {
  const codes: readonly ProviderCredentialPublicErrorCode[] = [
    'invalidRequest',
    'secureStorageUnavailable',
    'temporarilyUnavailable',
    'corrupt',
    'unsupportedSchema',
    'persistenceFailed',
  ];
  for (const code of codes) {
    const message = providerCredentialErrorMessage(code);
    assert.ok(message.length > 0 && message.length < 160);
    assert.equal(message.includes('sk-secret'), false);
  }
});

function status(
  state: ProviderCredentialState,
  overrides: Partial<ProviderCredentialStatus> = {},
): ProviderCredentialStatus {
  return {
    schemaVersion: 1,
    provider: 'codex',
    origin: 'https://api.openai.com',
    state,
    persistence: state === 'ready' ? 'secure' : state === 'sessionOnly' ? 'session' : 'none',
    securePersistenceAvailable: state !== 'secureStorageUnavailable',
    hasPersistedEntry: ['ready', 'corrupt', 'unsupportedSchema'].includes(state),
    revision: 1,
    ...overrides,
  };
}

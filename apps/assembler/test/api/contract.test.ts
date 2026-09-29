/**
 * The `hcasm.agent-api@1` contract itself: the checked-in JSON Schema is
 * current, only implemented schema keywords are used, the validator accepts
 * and rejects what the contract says, every method has a handler, and the
 * feature-kind schemas agree with the project-format validator.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ApiError, API_ERROR_CODES, JSON_RPC_ERROR } from '../../renderer/src/api/errors.js';
import { validateStored } from '../../renderer/src/api/featureKinds.js';
import {
  AGENT_API_SCHEMA,
  DEFS,
  FEATURE_KIND_SCHEMAS,
  METHODS,
} from '../../renderer/src/api/schema.js';
import { AgentSession, HEADLESS_CAPABILITIES } from '../../renderer/src/api/session.js';
import { unsupportedKeywords, validateSchema } from '../../renderer/src/api/validate.js';
import { createDemoDocument, type Feature } from '../../renderer/src/model/document.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { InProcessKernelAdapter } from '../../renderer/src/kernel/adapter.js';

// Compiled to `.build/tests/apps/assembler/test/api/`; the schema lives in `apps/assembler/api/`.
const SCHEMA_FILE = new URL('../../../../../../api/agent-api-v1.schema.json', import.meta.url);
const root = { $defs: DEFS };

void test('the checked-in schema file equals api.describe (regenerate: assembler-headless --print-schema)', () => {
  const onDisk: unknown = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(AGENT_API_SCHEMA)));
});

void test('the contract only uses validator-implemented JSON Schema keywords', () => {
  assert.deepEqual(unsupportedKeywords({ $defs: AGENT_API_SCHEMA.$defs }), []);
  for (const [name, spec] of Object.entries(METHODS)) {
    assert.deepEqual(unsupportedKeywords(spec.params), [], name);
  }
  for (const [kind, spec] of Object.entries(FEATURE_KIND_SCHEMAS)) {
    assert.deepEqual(unsupportedKeywords(spec.params), [], kind);
  }
});

void test('every error code maps to a JSON-RPC number', () => {
  for (const code of API_ERROR_CODES) assert.equal(typeof JSON_RPC_ERROR[code], 'number', code);
});

void test('feature params schemas accept stored features and reject malformed ones', () => {
  // Every feature of the demo part, as stored, is valid input for its kind.
  for (const feature of createDemoDocument()) {
    const { id: _id, name: _name, kind, suppressed: _s, ...params } = feature;
    assert.deepEqual(validateSchema(params, FEATURE_KIND_SCHEMAS[kind]!.params, root), [], kind);
  }
  const extrude = FEATURE_KIND_SCHEMAS.extrude!.params;
  assert.deepEqual(
    validateSchema({ profile: { kind: 'sketch', featureId: 'a' }, distance: 3 }, extrude, root),
    [],
  );
  assert.match(
    validateSchema({ profile: { kind: 'sketch' }, distance: 3 }, extrude, root)[0]!,
    /featureId/,
  );
  assert.match(
    validateSchema(
      { profile: { kind: 'sketch', featureId: 'a' }, distance: 'x' },
      extrude,
      root,
    )[0]!,
    /distance: expected number/,
  );
  assert.match(
    validateSchema(
      { profile: { kind: 'sketch', featureId: 'a' }, distance: 1, typo: 1 },
      extrude,
      root,
    )[0]!,
    /unknown property/,
  );
  const fillet = FEATURE_KIND_SCHEMAS.fillet!.params;
  assert.deepEqual(
    validateSchema({ edges: [{ bodyId: 'b', select: '|Z' }], radius: 1 }, fillet, root),
    [],
  );
  assert.ok(validateSchema({ edges: [], radius: 1 }, fillet, root).length > 0);
  assert.ok(
    validateSchema({ edges: [{ bodyId: 'b', key: 'k' }], radius: 0 }, fillet, root).length > 0,
  );
});

void test('every registered feature kind is a persisted kind (format validator agrees)', () => {
  for (const feature of createDemoDocument()) {
    assert.ok(FEATURE_KIND_SCHEMAS[feature.kind], feature.kind);
    assert.deepEqual(validateStored(feature), feature);
  }
  assert.throws(
    () =>
      validateStored({ id: 'x', name: 'x', suppressed: false, kind: 'warp' } as unknown as Feature),
    (error: unknown) => error instanceof ApiError && error.code === 'invalidParams',
  );
});

void test('every method has a handler and validates its params', async () => {
  const kernel = new InProcessKernelAdapter(() => new Promise(() => undefined)); // never loads
  const session = new AgentSession({
    store: useAssemblerStore,
    kernel,
    host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
  });
  for (const method of Object.keys(METHODS)) {
    // `{ bogus: 1 }` violates every method's params (all are closed objects).
    await assert.rejects(session.handle(method, { bogus: 1 }), (error: unknown) => {
      assert.ok(error instanceof ApiError, method);
      assert.equal(error.code, 'invalidParams', `${method}: ${error.message}`);
      return true;
    });
  }
  const hello = (await session.handle('api.hello', {})) as { methods: string[] };
  assert.deepEqual(hello.methods, Object.keys(METHODS));
  session.dispose();
  kernel.dispose();
});

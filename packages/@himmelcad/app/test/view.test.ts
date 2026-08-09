import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractValidationError,
  parseScreenshotResult,
  parseViewState,
  serializeViewState,
  validateScreenshotRequest,
  type ScreenshotRequestV1,
  type ViewStateV1,
} from '../src/index.js';

const viewState: ViewStateV1 = {
  schema: 'himmelcad.view-state',
  version: 1,
  camera: {
    position: { x: 4_000_000.125, y: 500_000.25, z: 620.5 },
    target: { x: 4_000_010.125, y: 500_020.25, z: 510.5 },
    up: { x: 0, y: 0, z: 1 },
    projection: {
      kind: 'perspective',
      verticalFieldOfViewRadians: 0.7853981633974483,
      near: 0.1,
      far: 2_000_000,
    },
  },
  navigationMode: '3d',
  hiddenEntityIds: ['hidden-mesh'],
  selectedEntityIds: ['selected-point-cloud'],
  scopedClips: [
    {
      id: 'viewing-box',
      enabled: true,
      scope: { kind: 'entities', entityIds: ['selected-point-cloud'] },
      primitive: {
        kind: 'box',
        center: { x: 4_000_000, y: 500_000, z: 500 },
        halfExtents: { x: 10, y: 20, z: 30 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        keep: 'inside',
      },
    },
  ],
  presentation: {
    background: 'theme',
    renderStyle: 'source',
    showGrid: true,
    showAxes: false,
    showSelectionOutline: true,
  },
};

void test('ViewState@1 has an exact JSON roundtrip including world coordinates and scoped clips', () => {
  const serialized = serializeViewState(viewState);
  const parsed = parseViewState(serialized);

  assert.deepEqual(parsed, viewState);
  assert.equal(serializeViewState(parsed), serialized);
});

void test('ViewState rejects unknown schema versions', () => {
  assert.throws(
    () => parseViewState({ ...viewState, version: 2 }),
    (error: unknown) =>
      error instanceof ContractValidationError && error.path === 'viewState.version',
  );
});

void test('screenshot contracts reject unsafe requests and malformed results', () => {
  const valid: ScreenshotRequestV1 = {
    schema: 'himmelcad.screenshot-request',
    version: 1,
    requestId: 'screenshot-1',
    format: 'png',
    width: 1920,
    height: 1080,
    pixelRatio: 1,
    background: 'transparent',
    includeUi: false,
  };
  assert.doesNotThrow(() => validateScreenshotRequest(valid));
  assert.throws(
    () => validateScreenshotRequest({ ...valid, format: 'jpeg' }),
    (error: unknown) =>
      error instanceof ContractValidationError && error.path === 'request.background',
  );
  assert.throws(
    () => validateScreenshotRequest({ ...valid, width: 16_384, height: 16_384, pixelRatio: 4 }),
    (error: unknown) => error instanceof ContractValidationError && error.path === 'request',
  );

  assert.deepEqual(
    parseScreenshotResult({
      schema: 'himmelcad.screenshot-result',
      version: 1,
      requestId: 'screenshot-1',
      mimeType: 'image/png',
      width: 1920,
      height: 1080,
      encoding: 'base64',
      data: 'iVBORw==',
    }),
    {
      schema: 'himmelcad.screenshot-result',
      version: 1,
      requestId: 'screenshot-1',
      mimeType: 'image/png',
      width: 1920,
      height: 1080,
      encoding: 'base64',
      data: 'iVBORw==',
    },
  );
  assert.throws(
    () =>
      parseScreenshotResult({
        schema: 'himmelcad.screenshot-result',
        version: 1,
        requestId: 'screenshot-1',
        mimeType: 'image/png',
        width: 1,
        height: 1,
        encoding: 'base64',
        data: 'data:image/png;base64,iVBORw==',
      }),
    (error: unknown) => error instanceof ContractValidationError && error.path === 'result.data',
  );

  assert.deepEqual(
    parseScreenshotResult({
      schema: 'himmelcad.screenshot-result',
      version: 1,
      requestId: 'screenshot-2',
      mimeType: 'image/png',
      width: 4096,
      height: 4096,
      encoding: 'bulkLease',
      lease: {
        leaseId: 'lease-1',
        accessToken: 'opaque-token',
        contentHash: 'a'.repeat(64),
        mediaType: 'image/png',
        elementType: 'bytes',
        shape: [300_000],
        endianness: 'notApplicable',
        byteLength: 300_000,
        expiresAt: '2099-01-01T00:00:00Z',
        maxReadableRange: 262_144,
        remainingReadBudget: 600_000,
        readOnly: true,
      },
    }),
    {
      schema: 'himmelcad.screenshot-result',
      version: 1,
      requestId: 'screenshot-2',
      mimeType: 'image/png',
      width: 4096,
      height: 4096,
      encoding: 'bulkLease',
      lease: {
        leaseId: 'lease-1',
        accessToken: 'opaque-token',
        contentHash: 'a'.repeat(64),
        mediaType: 'image/png',
        elementType: 'bytes',
        shape: [300_000],
        endianness: 'notApplicable',
        byteLength: 300_000,
        expiresAt: '2099-01-01T00:00:00Z',
        maxReadableRange: 262_144,
        remainingReadBudget: 600_000,
        readOnly: true,
      },
    },
  );
  assert.throws(
    () =>
      parseScreenshotResult({
        schema: 'himmelcad.screenshot-result',
        version: 1,
        requestId: 'screenshot-3',
        mimeType: 'image/png',
        width: 1,
        height: 1,
        encoding: 'bulkLease',
        data: 'iVBORw==',
        lease: {},
      }),
    (error: unknown) => error instanceof ContractValidationError && error.path === 'result.data',
  );
});

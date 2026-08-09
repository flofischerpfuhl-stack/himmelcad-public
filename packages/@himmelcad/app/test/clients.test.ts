import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_PROTOCOL_SCHEMA_ID,
  APP_PROTOCOL_VERSION,
  CanonicalProjectClient,
  ContractValidationError,
  DocumentClient,
  IoClient,
  ProtocolNegotiationError,
  RevisionConflictError,
  ResidencyClient,
  RegistrationClient,
  negotiateAppProtocol,
  type AppFacadeMethods,
  type AppProtocolResponse,
  type CanonicalCommandTransaction,
  type CanonicalEntity,
  type CanonicalJournalEntry,
  type NegotiatedSession,
  type RpcRequestOptions,
  type RpcTransport,
} from '../src/index.js';

class FakeTransport implements RpcTransport<AppFacadeMethods> {
  constructor(
    private readonly respond: (method: keyof AppFacadeMethods, request: unknown) => unknown,
  ) {}

  request<Key extends keyof AppFacadeMethods>(
    method: Key,
    request: AppFacadeMethods[Key]['request'],
    _options?: RpcRequestOptions,
  ): Promise<AppFacadeMethods[Key]['response']> {
    return Promise.resolve(this.respond(method, request) as AppFacadeMethods[Key]['response']);
  }
}

const readSession: NegotiatedSession = {
  protocolVersion: APP_PROTOCOL_VERSION,
  serverName: 'test-core',
  serverVersion: '1.0.0',
  sessionId: 'session-1',
  capabilities: ['document.read', 'document.write', 'journal.read'],
};

void test('DocumentClient sends the canonical envelope and preserves namespaced extensions', async () => {
  const extensions = {
    'vendor.survey.request@7': { nested: [1, { futureField: true }] },
  } as const;
  const transport = new FakeTransport((method, request) => {
    assert.equal(method, 'app.protocol');
    assert.deepEqual(request, {
      schemaId: APP_PROTOCOL_SCHEMA_ID,
      requestId: 'request-42',
      request: { method: 'readDocumentSnapshot' },
      extensions,
    });
    return protocolResult(
      'request-42',
      {
        kind: 'documentSnapshot',
        payload: {
          generation: 0,
          entities: [],
          tombstones: [],
          journalHeadSequence: 0,
        },
      },
      extensions,
    );
  });
  const client = new DocumentClient(transport, readSession);

  const response = await client.exchange(
    { method: 'readDocumentSnapshot' },
    { requestId: 'request-42', extensions },
  );

  assert.deepEqual(response.extensions, extensions);
  assert.equal(response.response.kind, 'documentSnapshot');
});

void test('canonical project lifecycle uses the exact sidecar methods', async () => {
  const calls: { readonly method: string; readonly request: unknown }[] = [];
  const transport = new FakeTransport((method, request) => {
    calls.push({ method, request });
    if (method === 'canonical.project.open') {
      return {
        generation: 7,
        entities: [],
        tombstones: [],
        journalHeadSequence: 7,
      };
    }
    if (method === 'canonical.project.close') return { closed: true };
    assert.fail(`unexpected method ${method}`);
  });
  const projects = new CanonicalProjectClient(transport);

  const snapshot = await projects.open('/project/example.hcad');
  const closed = await projects.close();

  assert.equal(snapshot.generation, 7);
  assert.equal(closed, true);
  assert.deepEqual(calls, [
    { method: 'canonical.project.open', request: { projectRoot: '/project/example.hcad' } },
    { method: 'canonical.project.close', request: {} },
  ]);
});

void test('residency bootstrap uses the negotiated path-free canonical descriptor', async () => {
  const transport = new FakeTransport((method, request) => {
    assert.equal(method, 'canonical.residency.bootstrap');
    assert.deepEqual(request, {});
    return { schemaVersion: 1, generation: 8, entries: [] };
  });
  const result = await new ResidencyClient(transport, {
    ...readSession,
    capabilities: [...readSession.capabilities, 'residency.read'],
  }).bootstrap();
  assert.equal(result.generation, 8);
});

void test('generic I/O freezes provider versions, carries loss plans and controls operations', async () => {
  const calls: { readonly method: string; readonly request: unknown }[] = [];
  const transport = new FakeTransport((method, request) => {
    calls.push({ method, request });
    if (method === 'io.probe') {
      return {
        providerId: 'hcad.io.dxf-rs@1',
        providerVersion: '0.0.0',
        formatId: 'dxf@r12-r2018-ascii',
        confidence: 100,
      };
    }
    if (method === 'io.export.plan') {
      return {
        schemaVersion: 1,
        ...(request as object),
        plan: {
          formatId: 'dxf@r12-r2018-ascii',
          outputs: [{ relativePath: 'drawing.dxf', mediaType: 'image/vnd.dxf' }],
          semanticLosses: ['hcad.loss.dxf.example@1'],
        },
      };
    }
    if (method === 'io.export.execute') {
      return {
        schemaVersion: 1,
        operationId: 'export-1',
        outputs: [{ relativePath: 'drawing.dxf', mediaType: 'image/vnd.dxf' }],
      };
    }
    if (method === 'io.operation.cancel') {
      return { schemaVersion: 1, operationId: 'export-1', cancellationRequested: true };
    }
    assert.fail(`unexpected method ${method}`);
  });
  const client = new IoClient(transport, {
    ...readSession,
    capabilities: [
      ...readSession.capabilities,
      'io.probe',
      'io.import.execute',
      'io.export',
      'io.operation',
    ],
  });
  const selection = await client.probe({ sourcePath: '/host/in.dxf' });
  const accepted = await client.planExport({
    commandId: 'import-1',
    providerId: selection.providerId,
    providerVersion: selection.providerVersion,
    targetPath: '/host/drawing.dxf',
    formatId: selection.formatId,
    options: { acceptedLossCodes: ['hcad.loss.dxf.example@1'] },
  });
  assert.deepEqual(accepted.plan.semanticLosses, ['hcad.loss.dxf.example@1']);
  await client.executeExport('export-1', accepted);
  assert.equal(await client.cancelOperation('export-1'), true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['io.probe', 'io.export.plan', 'io.export.execute', 'io.operation.cancel'],
  );
  assert.deepEqual(calls[2]?.request, { operationId: 'export-1', acceptedPlan: accepted });
});

void test('registration client stages version-frozen I/O without persisting point picks', async () => {
  const calls: { readonly method: string; readonly request: unknown }[] = [];
  const transport = new FakeTransport((method, request) => {
    calls.push({ method, request });
    if (method === 'registration.import.stage') {
      const input = request as AppFacadeMethods['registration.import.stage']['request'];
      return {
        schemaVersion: 1,
        sessionId: input.sessionId,
        commandId: input.commandId,
        recipe: input.recipe,
        phase: 'awaitingFreshInteraction',
        sourceEntityCount: 1,
        sourcePreview: {},
      };
    }
    if (method === 'registration.preview.pointPairs') {
      return {
        schemaVersion: 1,
        sessionId: 'registration-1',
        commandId: 'command-1',
        recipe,
        phase: 'readyToCommit',
        sourceEntityCount: 1,
        sourcePreview: {},
        preview: {
          transform: identitySimilarity,
          residuals: {
            count: 3,
            rmsHorizontalMeters: 0,
            rmsVerticalMeters: 0,
            rmsSpatialMeters: 0,
            maxSpatialMeters: 0,
          },
          iterations: 1,
          matchedSamples: 3,
          overlapRatio: 1,
          converged: true,
          accepted: true,
          warnings: [],
        },
      };
    }
    if (method === 'registration.samples.source') {
      return {
        schemaVersion: 1,
        sessionId: 'registration-1',
        datasetId: 'potree-source',
        samplingMethod: 'potree-additive-root-even-v1',
        sourceTransform: null,
        resourceHashes: ['a'.repeat(64)],
        points: pairs.map((pair) => pair.source),
      };
    }
    assert.fail(`unexpected method ${method}`);
  });
  const client = new RegistrationClient(transport, {
    ...readSession,
    capabilities: [...readSession.capabilities, 'registration.import'],
  });
  await client.stage({
    sessionId: 'registration-1',
    commandId: 'command-1',
    sourcePath: '/host/model.ifc',
    selection: {
      providerId: 'hcad.io.ifc-spf@1',
      providerVersion: '0.0.0',
      formatId: 'ifc@4',
      confidence: 99,
    },
    options: {},
    recipe,
  });
  const pairs = [0, 1, 2].map((value) => ({
    pairId: `pair-${value}`,
    source: { x: value, y: 0, z: 0 },
    target: { x: value + 1, y: 2, z: 3 },
  }));
  const preview = await client.previewPointPairs('registration-1', pairs);
  const samples = await client.sourceSamples('registration-1', 3);
  assert.equal(preview.phase, 'readyToCommit');
  assert.equal(samples.points.length, 3);
  assert.equal('pairs' in (calls[0]?.request as object), false);
  assert.deepEqual((calls[1]?.request as { readonly pairs: unknown }).pairs, pairs);
  assert.deepEqual(calls[2]?.request, { sessionId: 'registration-1', maximumSamples: 3 });
});

const identitySimilarity = {
  tx: 0,
  ty: 0,
  tz: 0,
  rxRadians: 0,
  ryRadians: 0,
  rzRadians: 0,
  scale: 1,
} as const;

const recipe = {
  schemaVersion: 1,
  recipeId: 'point-pair-template',
  label: 'Point pairs',
  method: {
    kind: 'pointPairs',
    model: 'similarity3D',
    robust: {
      maximumIterations: 20,
      huberDeltaMeters: 0.05,
      convergenceEpsilon: 1e-10,
    },
    offerIcpRefinement: true,
  },
} as const;

void test('journal catch-up uses bounded canonical sequence pages and rejects gaps', async () => {
  const seenRequests: unknown[] = [];
  const transport = new FakeTransport((method, request) => {
    assert.equal(method, 'app.protocol');
    const envelope = request as {
      readonly requestId: string;
      readonly request: { readonly method: string; readonly params: unknown };
    };
    seenRequests.push(envelope.request);
    const params = envelope.request.params as { readonly afterSequence: number };
    if (params.afterSequence === 0) {
      return protocolResult(envelope.requestId, {
        kind: 'journalPage',
        payload: {
          afterSequence: 0,
          entries: [journalEntry(1)],
          journalHeadSequence: 2,
          hasMore: true,
        },
      });
    }
    return protocolResult(envelope.requestId, {
      kind: 'journalPage',
      payload: {
        afterSequence: 1,
        entries: [journalEntry(2)],
        journalHeadSequence: 2,
        hasMore: false,
      },
    });
  });
  const client = new DocumentClient(transport, readSession, {
    createRequestId: requestIds(),
  });

  const entries = await client.listAllJournalEntries({ pageSize: 1 });

  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    [1, 2],
  );
  assert.deepEqual(seenRequests, [
    { method: 'readJournal', params: { afterSequence: 0, limit: 1 } },
    { method: 'readJournal', params: { afterSequence: 1, limit: 1 } },
  ]);

  const gapTransport = new FakeTransport((_method, request) => {
    const requestId = (request as { readonly requestId: string }).requestId;
    return protocolResult(requestId, {
      kind: 'journalPage',
      payload: {
        afterSequence: 0,
        entries: [journalEntry(2)],
        journalHeadSequence: 2,
        hasMore: false,
      },
    });
  });
  await assert.rejects(
    new DocumentClient(gapTransport, readSession, {
      createRequestId: requestIds(),
    }).listAllJournalEntries(),
    (error: unknown) =>
      error instanceof ContractValidationError && error.path === 'response.entries',
  );
});

void test('canonical transactions retain exact CAS references and surface a typed conflict', async () => {
  const transaction: CanonicalCommandTransaction = {
    commandId: 'command-1',
    mutations: [
      {
        operation: 'update',
        expected: { id: 'entity-a', revision: 3, versionHash: 'hash-3' },
        edits: [{ kind: 'setName', name: 'Changed' }],
      },
    ],
  };
  const transport = new FakeTransport((method, request) => {
    assert.equal(method, 'app.protocol');
    const envelope = request as {
      readonly requestId: string;
      readonly request: unknown;
    };
    assert.deepEqual(envelope.request, {
      method: 'executeCanonicalTransaction',
      params: transaction,
    });
    return protocolResult(envelope.requestId, {
      kind: 'error',
      payload: {
        code: 'canonical.version_conflict',
        message: 'entity changed',
        details: {
          entityId: 'entity-a',
          expectedRevision: 3,
          actualRevision: 4,
          expectedVersionHash: 'hash-3',
          actualVersionHash: 'hash-4',
        },
      },
    });
  });

  await assert.rejects(
    new DocumentClient(transport, readSession, {
      createRequestId: () => 'request-cas',
    }).executeCanonicalTransaction(transaction),
    (error: unknown) =>
      error instanceof RevisionConflictError &&
      error.conflict.entityId === 'entity-a' &&
      error.conflict.actualRevision === 4 &&
      error.conflict.expectedVersionHash === 'hash-3',
  );
});

void test('property edits compile through the canonical protocol without a client mutation model', async () => {
  const expected = { id: 'entity-a', revision: 3, versionHash: 'hash-3' };
  const compiled: CanonicalCommandTransaction = {
    commandId: 'rename-selection',
    mutations: [
      {
        operation: 'update',
        expected,
        edits: [{ kind: 'setName', name: 'Shared name' }],
      },
    ],
  };
  const transport = new FakeTransport((_method, request) => {
    const envelope = request as {
      readonly requestId: string;
      readonly request: unknown;
    };
    assert.deepEqual(envelope.request, {
      method: 'compilePropertyEdit',
      params: {
        schemaId: 'hcad.property-edit-request@1',
        commandId: 'rename-selection',
        entities: [expected],
        assignments: [
          {
            propertyId: { namespace: 'hcad.entity@1', name: 'name' },
            value: { kind: 'text', value: 'Shared name' },
          },
        ],
      },
    });
    return protocolResult(envelope.requestId, {
      kind: 'compiledTransaction',
      payload: compiled,
    });
  });

  const result = await new DocumentClient(transport, readSession, {
    createRequestId: () => 'request-property',
  }).compilePropertyEdit({
    schemaId: 'hcad.property-edit-request@1',
    commandId: 'rename-selection',
    entities: [expected],
    assignments: [
      {
        propertyId: { namespace: 'hcad.entity@1', name: 'name' },
        value: { kind: 'text', value: 'Shared name' },
      },
    ],
  });

  assert.deepEqual(result, compiled);
});

void test('protocol negotiation rejects unsupported versions and missing capabilities', async () => {
  const unsupported = new FakeTransport(() => ({
    selectedVersion: 2,
    serverName: 'future-core',
    serverVersion: '2.0.0',
    sessionId: 'future-session',
    capabilities: ['document.read'],
  }));
  await assert.rejects(
    negotiateAppProtocol(unsupported, {
      clientName: 'test-client',
      supportedVersions: [1],
      requiredCapabilities: ['document.read'],
      optionalCapabilities: [],
    }),
    (error: unknown) =>
      error instanceof ProtocolNegotiationError && error.reason === 'unsupported-version',
  );

  const missing = new FakeTransport(() => ({
    selectedVersion: 1,
    serverName: 'core',
    serverVersion: '1.0.0',
    sessionId: 'session',
    capabilities: ['document.read'],
  }));
  await assert.rejects(
    negotiateAppProtocol(missing, {
      clientName: 'test-client',
      supportedVersions: [1],
      requiredCapabilities: ['document.read', 'document.write'],
      optionalCapabilities: [],
    }),
    (error: unknown) =>
      error instanceof ProtocolNegotiationError && error.reason === 'missing-capability',
  );
});

function protocolResult(
  requestId: string,
  response: AppProtocolResponse,
  extensions?: Readonly<Record<string, unknown>>,
) {
  return {
    schemaId: APP_PROTOCOL_SCHEMA_ID,
    requestId,
    response,
    ...(extensions === undefined ? {} : { extensions }),
  };
}

function requestIds(): () => string {
  let value = 0;
  return () => `request-${String((value += 1))}`;
}

function journalEntry(sequence: number): CanonicalJournalEntry {
  return {
    sequence,
    commandId: `command-${String(sequence)}`,
    kind: 'command',
    relatedCommandId: null,
    effects: [],
  };
}

export function canonicalEntity(id: string, revision: number): CanonicalEntity {
  return {
    id,
    revision,
    typeId: 'hcad.group@1',
    name: id,
    owner: null,
    layerIds: [],
    placement: null,
    representations: [],
    componentsRef: 'a'.repeat(64),
    attributesRef: 'b'.repeat(64),
    relationsRef: 'c'.repeat(64),
    styleRef: null,
    schemaVersion: 1,
    versionHash: `${id}-${String(revision)}`,
  };
}

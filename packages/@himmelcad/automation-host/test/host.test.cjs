'use strict';

const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { resolve } = require('node:path');
const test = require('node:test');

const {
  AutomationRpcRouter,
  DesktopAgentHarnessHostTransport,
  ManagedPythonHost,
} = require('../index.cjs');
const {
  _bootstrapAutomationWorkspaceForTest: bootstrapAutomationWorkspace,
  _captureScreenshotForTest: captureScreenshot,
  _isOwningMainFrameForTest: isOwningMainFrame,
  _providerCredentialResponseForTest: providerCredentialResponse,
  registerElectronAutomationHost,
} = require('../electron.cjs');

test('provider credential IPC accepts only the owning main frame', () => {
  const rendererUrl = 'file:///trusted/index.html';
  const mainFrame = { routingId: 1, url: rendererUrl };
  const owningContents = { id: 42, mainFrame };
  const window = { webContents: owningContents };
  assert.equal(
    isOwningMainFrame({ sender: owningContents, senderFrame: mainFrame }, window, rendererUrl),
    true,
  );
  assert.equal(
    isOwningMainFrame(
      { sender: owningContents, senderFrame: { routingId: 2, url: rendererUrl } },
      window,
      rendererUrl,
    ),
    false,
  );
  assert.equal(
    isOwningMainFrame(
      { sender: { id: 99, mainFrame }, senderFrame: mainFrame },
      window,
      rendererUrl,
    ),
    false,
  );
  assert.equal(
    isOwningMainFrame(
      { sender: owningContents, senderFrame: { ...mainFrame, url: 'https://example.com/' } },
      window,
      rendererUrl,
    ),
    false,
  );
});

test('provider credential IPC errors are bounded and never reflect secrets', async () => {
  const secret = 'sk-must-never-cross-ipc';
  const response = await providerCredentialResponse(async () => {
    throw Object.assign(new Error(`raw failure ${secret}`), { code: `invalid-${secret}` });
  });
  assert.deepEqual(response, {
    ok: false,
    error: { code: 'persistenceFailed' },
  });
  assert.equal(JSON.stringify(response).includes(secret), false);
});

for (const approvedPath of [undefined, '']) {
  test(`agent request IPC returns not configured when approved PATH is ${approvedPath === undefined ? 'missing' : 'empty'}`, async (context) => {
    const root = await mkdtemp(resolve(tmpdir(), 'hcad-agent-ipc-test-'));
    context.after(async () => rm(root, { recursive: true, force: true }));
    const handlers = new Map();
    const ipcMain = {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => {},
      removeHandler: (channel) => handlers.delete(channel),
    };
    const rendererUrl = 'file:///trusted/index.html';
    const mainFrame = { routingId: 1, url: rendererUrl };
    const webContents = {
      id: 7,
      mainFrame,
      send: () => {},
      isDestroyed: () => false,
      once: () => {},
    };
    const window = { webContents, isDestroyed: () => false };
    const host = registerElectronAutomationHost({
      ipcMain,
      getWindow: () => window,
      sidecarCall: async () => ({}),
      issueConfirmationGrant: () => 'grant',
      runtimeRoot: resolve(root, 'runtime'),
      workspaceRoot: resolve(root, 'workspace'),
      workspaceCapabilityId: 'workspace',
      rendererUrl,
      approvedPath,
    });
    await host.ready;
    const request = handlers.get('automation:agent:request');
    assert.deepEqual(
      await request(
        { sender: webContents, senderFrame: mainFrame },
        {
          kind: 'discover',
          provider: 'codex',
          executableNames: ['codex'],
          versionArgs: ['--version'],
          timeoutMs: 2_000,
          maxOutputBytes: 64 * 1024,
        },
      ),
      { kind: 'notConfigured', detail: 'No agent runtime is configured.' },
    );
    await host.dispose();
  });
}

test('provider credential IPC rejects child frames and exposes only narrow mutations', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'hcad-provider-ipc-test-'));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: (channel) => handlers.delete(channel),
  };
  const rendererUrl = 'file:///trusted/index.html';
  const mainFrame = { routingId: 1, url: rendererUrl };
  let destroyedListener = null;
  const webContents = {
    id: 7,
    mainFrame,
    send: () => {},
    isDestroyed: () => false,
    once: (name, listener) => {
      if (name === 'destroyed') destroyedListener = listener;
    },
  };
  const window = { webContents, isDestroyed: () => false };
  const calls = [];
  let sessionInvalidations = 0;
  const status = {
    schemaVersion: 1,
    provider: 'codex',
    origin: 'https://api.openai.com',
    state: 'sessionOnly',
    persistence: 'session',
    securePersistenceAvailable: false,
    hasPersistedEntry: false,
    revision: 0,
  };
  const store = {
    status: async () => status,
    replace: async (request) => {
      calls.push(request);
      return status;
    },
    clearSession: async () => status,
    delete: async () => status,
    close: () => {},
  };
  const host = registerElectronAutomationHost({
    ipcMain,
    getWindow: () => window,
    sidecarCall: async () => ({}),
    issueConfirmationGrant: () => 'grant',
    runtimeRoot: resolve(root, 'runtime'),
    workspaceRoot: resolve(root, 'workspace'),
    workspaceCapabilityId: 'workspace',
    rendererUrl,
    providerCredentialStore: store,
  });
  host.harness.invalidateSessions = async () => {
    sessionInvalidations += 1;
  };
  await host.ready;
  const statusHandler = handlers.get('automation:provider-credentials:status');
  const replaceHandler = handlers.get('automation:provider-credentials:replace');
  const agentRequestHandler = handlers.get('automation:agent:request');
  const ownerEvent = { sender: webContents, senderFrame: mainFrame };
  await assert.rejects(
    statusHandler(
      { sender: webContents, senderFrame: { routingId: 2, url: rendererUrl } },
      'codex',
    ),
    /owning renderer/u,
  );
  assert.deepEqual(await statusHandler(ownerEvent, 'codex'), { ok: true, value: status });
  assert.equal(sessionInvalidations, 0);
  const secret = 'sk-ipc-sentinel';
  assert.deepEqual(
    await replaceHandler(ownerEvent, {
      provider: 'codex',
      credential: secret,
      persistence: 'session',
      unexpected: true,
    }),
    { ok: false, error: { code: 'invalidRequest' } },
  );
  assert.equal(calls.length, 0);
  assert.equal(sessionInvalidations, 0);
  const validResponse = await replaceHandler(ownerEvent, {
    provider: 'codex',
    credential: secret,
    persistence: 'session',
  });
  assert.equal(calls.length, 1);
  assert.equal(sessionInvalidations, 1);
  assert.equal(JSON.stringify(validResponse).includes(secret), false);

  let releaseAgentRequest;
  host.harness.request = async () =>
    await new Promise((resolvePromise) => {
      releaseAgentRequest = () => resolvePromise({ kind: 'closed' });
    });
  const pendingAgentRequest = agentRequestHandler(ownerEvent, { kind: 'test' });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const pendingMutation = replaceHandler(ownerEvent, {
    provider: 'codex',
    credential: secret,
    persistence: 'session',
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(sessionInvalidations, 1);
  releaseAgentRequest();
  await Promise.all([pendingAgentRequest, pendingMutation]);
  assert.equal(sessionInvalidations, 2);

  destroyedListener();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(sessionInvalidations, 3);
  await host.dispose();
  assert.equal(handlers.has('automation:provider-credentials:status'), false);
});

test('router rejects unvalidated and unapproved destructive commits', async () => {
  const calls = [];
  const transaction = {
    commandId: 'delete-entity',
    mutations: [
      {
        operation: 'delete',
        expected: { id: 'entity', revision: 1, versionHash: '11'.repeat(32) },
      },
    ],
  };
  const router = new AutomationRpcRouter({
    sidecarCall: async (method, params) => {
      calls.push({ method, params });
      if (method === 'app.negotiate') {
        return negotiationResult([
          'document.read',
          'document.write',
          'automation.commands.validate',
        ]);
      }
      if (method === 'automation.commands.validate') {
        return {
          commandId: 'delete-entity',
          valid: true,
          requiresConfirmation: true,
          losses: [],
          conflicts: [],
          planHash: '22'.repeat(32),
        };
      }
      return {
        schemaId: 'hcad.app-protocol@1',
        requestId: params.requestId,
        response: { kind: 'transactionAccepted', payload: {} },
      };
    },
  });
  const session = await negotiate(router);
  const commit = (extensions) => ({
    id: 2,
    method: 'app.protocol',
    params: {
      schemaId: 'hcad.app-protocol@1',
      requestId: 'request',
      request: { method: 'executeCanonicalTransaction', params: transaction },
      ...(extensions ? { extensions } : {}),
    },
  });
  const unvalidated = await router.handle(commit());
  assert.equal(unvalidated.error.code, 'confirmationRequired');
  await router.handle({
    id: 1,
    method: 'automation.commands.validate',
    params: { transaction, acceptedLossCodes: [] },
  });
  const unapproved = await router.handle(commit());
  assert.equal(unapproved.error.code, 'confirmationRequired');
  const grant = 'v1:opaque-product-grant';
  router.registerConfirmationGrant({
    grant,
    hostSessionId: session.sessionId,
    commandId: transaction.commandId,
    planHash: '22'.repeat(32),
    expiresAt: Date.now() + 30_000,
  });
  const approved = await router.handle(commit({ 'hcad.automation.confirmation@1': { grant } }));
  assert.equal(approved.result.response.kind, 'transactionAccepted');
  const replay = await router.handle(commit({ 'hcad.automation.confirmation@1': { grant } }));
  assert.equal(replay.error.code, 'confirmationRequired');
  assert.equal(calls.filter((call) => call.method === 'app.protocol').length, 1);
});

test('view methods fail closed until a renderer host is registered', async () => {
  const router = new AutomationRpcRouter({
    sidecarCall: async () => negotiationResult([]),
  });
  await negotiate(router);
  const response = await router.handle({ id: 1, method: 'view.state.get', params: {} });
  assert.equal(response.error.code, 'missingCapability');
});

test('S-04 automation parity routes every canonical selection row through the renderer owner', async () => {
  const calls = [];
  const router = new AutomationRpcRouter({
    sidecarCall: async (method) => {
      if (method === 'app.negotiate') return negotiationResult([]);
      assert.fail(`selection reached sidecar: ${method}`);
    },
    viewCall: async (method, params) => {
      calls.push({ method, params });
      return { schemaId: 'hcad.selection-command-result@1', payload: { method } };
    },
  });
  await negotiate(router);
  const rows = [
    'select.get',
    'select.set',
    'select.toggle',
    'select.clear',
    'select.undo',
    'select.redo',
    'select.candidates',
  ];
  for (const [index, method] of rows.entries()) {
    const params = { schemaId: 'hcad.selection-command@1', payload: {} };
    const response = await router.handle({ id: index + 1, method, params });
    assert.equal(response.result.payload.method, method);
  }
  assert.deepEqual(calls.map((call) => call.method), rows);
});

test('negotiation and grants are bound to one live RPC connection', async () => {
  const router = new AutomationRpcRouter({
    sidecarCall: async () => negotiationResult(['automation.entities.page']),
  });
  const first = router.openConnection();
  const second = router.openConnection();
  const negotiation = await router.handle(
    {
      id: 1,
      method: 'app.negotiate',
      params: {
        clientName: 'first',
        supportedVersions: [1],
        requiredCapabilities: [],
        optionalCapabilities: [],
      },
    },
    first,
  );
  assert.equal(negotiation.result.selectedVersion, 1);
  const crossConnection = await router.handle(
    {
      id: 2,
      method: 'automation.entities.page',
      params: { limit: 1, byteLimit: 1024 },
    },
    second,
  );
  assert.equal(crossConnection.error.code, 'protocolMismatch');
  router.closeConnection(first);
  const closed = await router.handle(
    { id: 3, method: 'automation.entities.page', params: { limit: 1, byteLimit: 1024 } },
    first,
  );
  assert.equal(closed.error.code, 'protocolMismatch');
});

test('a confirmation grant cannot cross connections with an identical plan', async () => {
  const transaction = { commandId: 'same-command', mutations: [] };
  const planHash = '33'.repeat(32);
  const router = new AutomationRpcRouter({
    sidecarCall: async (method, params) => {
      if (method === 'app.negotiate') {
        return negotiationResult(['automation.commands.validate', 'document.write']);
      }
      if (method === 'automation.commands.validate') {
        return {
          commandId: transaction.commandId,
          valid: true,
          requiresConfirmation: true,
          losses: [],
          conflicts: [],
          planHash,
        };
      }
      return {
        schemaId: 'hcad.app-protocol@1',
        requestId: params.requestId,
        response: { kind: 'transactionAccepted', payload: {} },
      };
    },
  });
  const first = router.openConnection();
  const second = router.openConnection();
  const negotiateConnection = async (connectionId, clientName) =>
    (
      await router.handle(
        {
          id: 1,
          method: 'app.negotiate',
          params: {
            clientName,
            supportedVersions: [1],
            requiredCapabilities: [],
            optionalCapabilities: [],
          },
        },
        connectionId,
      )
    ).result;
  const firstSession = await negotiateConnection(first, 'first');
  await negotiateConnection(second, 'second');
  const validate = {
    id: 2,
    method: 'automation.commands.validate',
    params: { transaction, acceptedLossCodes: [] },
  };
  await router.handle(validate, first);
  await router.handle(validate, second);
  const grant = 'v1:connection-bound-grant';
  router.registerConfirmationGrant({
    grant,
    hostSessionId: firstSession.sessionId,
    commandId: transaction.commandId,
    planHash,
    expiresAt: Date.now() + 30_000,
  });
  const commit = {
    id: 3,
    method: 'app.protocol',
    params: {
      schemaId: 'hcad.app-protocol@1',
      requestId: 'same-request',
      request: { method: 'executeCanonicalTransaction', params: transaction },
      extensions: { 'hcad.automation.confirmation@1': { grant } },
    },
  };
  const crossConnection = await router.handle(commit, second);
  assert.equal(crossConnection.error.code, 'confirmationRequired');
  const owningConnection = await router.handle(commit, first);
  assert.equal(owningConnection.result.response.kind, 'transactionAccepted');
});

test('product confirmation injects a host-only grant into the exact commit', async () => {
  const transaction = { commandId: 'approved-command', mutations: [] };
  const planHash = '44'.repeat(32);
  let confirmation;
  let forwarded;
  const router = new AutomationRpcRouter({
    confirmationCall: async (request) => {
      confirmation = request;
      return 'v1:host-only-product-grant';
    },
    sidecarCall: async (method, params) => {
      if (method === 'app.negotiate') {
        return negotiationResult(['automation.commands.validate', 'document.write']);
      }
      if (method === 'automation.commands.validate') {
        return {
          commandId: transaction.commandId,
          valid: true,
          requiresConfirmation: true,
          losses: [{ code: 'delete', message: 'Deletes an entity.' }],
          conflicts: [],
          planHash,
        };
      }
      forwarded = params;
      return {
        schemaId: 'hcad.app-protocol@1',
        requestId: params.requestId,
        response: { kind: 'transactionAccepted', payload: {} },
      };
    },
  });
  const session = await negotiate(router);
  await router.handle({
    id: 2,
    method: 'automation.commands.validate',
    params: { transaction, acceptedLossCodes: [] },
  });
  const committed = await router.handle({
    id: 3,
    method: 'app.protocol',
    params: {
      schemaId: 'hcad.app-protocol@1',
      requestId: 'approved-request',
      request: { method: 'executeCanonicalTransaction', params: transaction },
    },
  });
  assert.equal(committed.result.response.kind, 'transactionAccepted');
  assert.equal(confirmation.hostSessionId, session.sessionId);
  assert.equal(confirmation.commandId, transaction.commandId);
  assert.equal(confirmation.losses[0].code, 'delete');
  assert.equal(
    forwarded.extensions['hcad.automation.confirmation@1'].grant,
    'v1:host-only-product-grant',
  );
});

test('Electron UI screenshot captures the validated renderer viewport rectangle', async () => {
  let captureArgument;
  let resizeArgument;
  const encoded = Buffer.from('png');
  const image = {
    getSize: () => ({ width: 640, height: 480 }),
    resize: (options) => {
      resizeArgument = options;
      return { toPNG: () => encoded, toJPEG: () => encoded };
    },
  };
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 40, y: 50, width: 1200, height: 800 }),
    webContents: {
      capturePage: async (rectangle) => {
        captureArgument = rectangle;
        return image;
      },
    },
  };
  const request = screenshotRequest({ includeUi: true, width: 400, height: 300, pixelRatio: 2 });
  const result = await captureScreenshot(
    () => window,
    async () => ({ captureRect: { x: 120, y: 80, width: 900, height: 600 } }),
    request,
  );
  assert.deepEqual(captureArgument, { x: 120, y: 80, width: 900, height: 600 });
  assert.deepEqual(resizeArgument, { width: 800, height: 600, quality: 'best' });
  assert.equal(result.data, encoded.toString('base64'));
});

test('Electron screenshot validation rejects malformed rectangles, background and quality', async () => {
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    webContents: { capturePage: async () => assert.fail('capturePage must not be reached') },
  };
  await assert.rejects(
    captureScreenshot(
      () => window,
      async () => ({ captureRect: { x: 0.5, y: 0, width: 100, height: 100 } }),
      screenshotRequest({ includeUi: true }),
    ),
    /invalid viewport capture rectangle/u,
  );
  await assert.rejects(
    captureScreenshot(
      () => window,
      async () => ({ captureRect: { x: 750, y: 0, width: 100, height: 100 } }),
      screenshotRequest({ includeUi: true }),
    ),
    /exceeds the content bounds/u,
  );
  await assert.rejects(
    captureScreenshot(
      () => window,
      async () => assert.fail('renderer must not be reached'),
      screenshotRequest({ background: 'opaque' }),
    ),
    /Screenshot request is invalid/u,
  );
  await assert.rejects(
    captureScreenshot(
      () => window,
      async () => assert.fail('renderer must not be reached'),
      screenshotRequest({ quality: 0.8 }),
    ),
    /Screenshot quality is invalid/u,
  );
});

test('automation workspace bootstrap rejects a symlink root', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'hcad-workspace-root-test-'));
  try {
    const victim = resolve(parent, 'victim');
    await mkdir(victim);
    const linkedRoot = resolve(parent, 'automation-workspace');
    await symlink(victim, linkedRoot, 'dir');
    await assert.rejects(bootstrapAutomationWorkspace(linkedRoot), /not a symlink/u);
    assert.equal(existsSync(resolve(victim, 'SDK.md')), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('automation workspace bootstrap atomically replaces a file symlink', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'hcad-workspace-file-test-'));
  try {
    const root = resolve(parent, 'automation-workspace');
    await mkdir(root);
    const victim = resolve(parent, 'victim.txt');
    await writeFile(victim, 'do not overwrite');
    await symlink(victim, resolve(root, 'SDK.md'));
    const canonicalRoot = await bootstrapAutomationWorkspace(root);
    assert.equal(canonicalRoot, root);
    assert.equal(await readFile(victim, 'utf8'), 'do not overwrite');
    assert.match(await readFile(resolve(root, 'SDK.md'), 'utf8'), /HimmelCAD automation SDK/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('managed Python uses FD3 while bwrap blocks network and read-only writes', async (context) => {
  const runtimeRoot = resolve(__dirname, '../../../../.build/automation-runtime/linux-x64');
  if (!existsSync('/usr/bin/bwrap') || !existsSync(resolve(runtimeRoot, 'python/bin/python3'))) {
    context.skip('staged Linux automation runtime or bwrap is unavailable');
    return;
  }
  const workspace = await mkdtemp(resolve(tmpdir(), 'hcad-automation-host-test-'));
  try {
    await mkdir(resolve(workspace, 'nested'));
    await writeFile(
      resolve(workspace, 'nested/probe.py'),
      [
        'import socket',
        'from himmelcad_host import client',
        'network_blocked = False',
        'try:',
        '    socket.create_connection(("1.1.1.1", 443), timeout=0.1)',
        'except OSError:',
        '    network_blocked = True',
        'write_blocked = False',
        'try:',
        '    open("/workspace/forbidden", "w").close()',
        'except OSError:',
        '    write_blocked = True',
        'session = client().negotiate()',
        'print(network_blocked, write_blocked, session.selected_version)',
      ].join('\n'),
    );
    const router = new AutomationRpcRouter({
      sidecarCall: async (method) => {
        assert.equal(method, 'app.negotiate');
        return negotiationResult([]);
      },
    });
    const host = new ManagedPythonHost({ runtimeRoot, router, timeoutMs: 15_000 });
    host.registerWorkspaceCapability('test-workspace', workspace);
    const result = await host.run({
      workspaceCapabilityId: 'test-workspace',
      scriptRelativePath: 'nested/probe.py',
      filesystem: 'readOnly',
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /True True 1/u);
    assert.equal(existsSync(resolve(workspace, 'forbidden')), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('managed Python generated clients exercise the full private FD3 route', async (context) => {
  const runtimeRoot = resolve(__dirname, '../../../../.build/automation-runtime/linux-x64');
  if (!existsSync('/usr/bin/bwrap') || !existsSync(resolve(runtimeRoot, 'python/bin/python3'))) {
    context.skip('staged Linux automation runtime or bwrap is unavailable');
    return;
  }
  const workspace = await mkdtemp(resolve(tmpdir(), 'hcad-automation-sdk-route-test-'));
  const screenshotBytes = Buffer.alloc(300_123, 0x5a);
  const validatedTransactions = new Map();
  const calls = [];
  let currentView = fixtureViewState();
  try {
    await writeFile(
      resolve(workspace, 'sdk_route_probe.py'),
      [
        'import asyncio',
        'import hashlib',
        'import json',
        'from dataclasses import replace',
        'from himmelcad import BulkLease, CanonicalCommandTransaction, CanonicalEntityEdit, CanonicalEntityMutation, EntityVersionRef',
        'from himmelcad_host import async_client, client',
        '',
        'required = ("automation.entities.page", "automation.commands.validate", "automation.bulk.read", "automation.bulk.release", "document.write", "view.read", "view.write", "view.screenshot")',
        'sync = client()',
        'session = sync.negotiate("fd3-sync-probe", required_capabilities=required)',
        'page = sync.entities_page(limit=2, byte_limit=4096)',
        'view = sync.get_view()',
        'applied = sync.set_view(replace(view, navigation_mode="2.5d", selected_entity_ids=("entity-probe",)))',
        'shot = sync.screenshot({"schema": "himmelcad.screenshot-request", "version": 1, "requestId": "fd3-large-shot", "format": "png", "width": 640, "height": 480, "pixelRatio": 1, "background": "view", "includeUi": False})',
        'assert isinstance(shot, BulkLease)',
        'parts = []',
        'with shot:',
        '    for offset in range(0, shot.descriptor.byte_length, 65536):',
        '        parts.append(shot.read(offset, min(65536, shot.descriptor.byte_length - offset)))',
        'image = b"".join(parts)',
        'assert hashlib.sha256(image).hexdigest() == shot.descriptor.content_hash',
        'transaction = CanonicalCommandTransaction(command_id="python-probe-update", mutations=(CanonicalEntityMutation(operation="update", expected=EntityVersionRef(id="entity-probe", revision=7, version_hash="11" * 32), edits=(CanonicalEntityEdit(kind="setName", name="Updated by managed Python"),)),))',
        'plan = sync.validate(transaction)',
        'accepted = sync.commit(transaction)',
        'sync.transport.close()',
        '',
        'async def async_probe():',
        '    asynchronous = async_client()',
        '    async_session = await asynchronous.negotiate("fd3-async-probe", required_capabilities=("automation.entities.page", "view.read"))',
        '    async_page = await asynchronous.entities_page(limit=1, byte_limit=4096)',
        '    async_view = await asynchronous.get_view()',
        '    await asynchronous.transport.close()',
        '    return async_session, async_page, async_view',
        '',
        'async_session, async_page, async_view = asyncio.run(async_probe())',
        'print(json.dumps({"marker": "managed-sdk-route-ok", "syncVersion": session.selected_version, "entity": page.items[0].id, "viewMode": applied.navigation_mode, "leaseBytes": len(image), "leaseReleased": shot.released, "planValid": plan.valid, "acceptedCommand": accepted["commandId"], "asyncVersion": async_session.selected_version, "asyncEntity": async_page.items[0].id, "asyncViewMode": async_view.navigation_mode}, sort_keys=True))',
      ].join('\n'),
    );
    const router = new AutomationRpcRouter({
      sidecarCall: async (method, params) => {
        calls.push({ method, params });
        if (method === 'app.negotiate') {
          return negotiationResult([
            'automation.entities.page',
            'automation.commands.validate',
            'document.write',
          ]);
        }
        if (method === 'automation.entities.page') {
          return {
            generation: 9,
            items: [
              {
                id: 'entity-probe',
                revision: 7,
                versionHash: '11'.repeat(32),
                typeId: 'hcad.test@1',
                name: 'Probe',
                layerIds: [],
              },
            ],
            returnedBytes: 192,
          };
        }
        if (method === 'automation.commands.validate') {
          validatedTransactions.set(params.transaction.commandId, params.transaction);
          return {
            commandId: params.transaction.commandId,
            valid: true,
            requiresConfirmation: false,
            losses: [],
            conflicts: [],
            planHash: '22'.repeat(32),
          };
        }
        if (method === 'app.protocol') {
          assert.equal(params.request.method, 'executeCanonicalTransaction');
          assert.deepEqual(
            params.request.params,
            validatedTransactions.get(params.request.params.commandId),
          );
          return {
            schemaId: 'hcad.app-protocol@1',
            requestId: params.requestId,
            response: {
              kind: 'transactionAccepted',
              payload: { commandId: params.request.params.commandId, sequence: 41 },
            },
          };
        }
        assert.fail(`unexpected sidecar call: ${method}`);
      },
      viewCall: async (method, params) => {
        calls.push({ method, params });
        if (method === 'view.state.get') return currentView;
        if (method === 'view.state.set') {
          currentView = params;
          return currentView;
        }
        if (method === 'view.screenshot') {
          return {
            schema: 'himmelcad.screenshot-result',
            version: 1,
            requestId: params.requestId,
            mimeType: 'image/png',
            width: 640,
            height: 480,
            encoding: 'base64',
            data: screenshotBytes.toString('base64'),
          };
        }
        assert.fail(`unexpected view call: ${method}`);
      },
    });
    const host = new ManagedPythonHost({ runtimeRoot, router, timeoutMs: 30_000 });
    host.registerWorkspaceCapability('sdk-route-workspace', workspace);
    const result = await host.run({
      workspaceCapabilityId: 'sdk-route-workspace',
      scriptRelativePath: 'sdk_route_probe.py',
      filesystem: 'readOnly',
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output, {
      acceptedCommand: 'python-probe-update',
      asyncEntity: 'entity-probe',
      asyncVersion: 1,
      asyncViewMode: '2.5d',
      entity: 'entity-probe',
      leaseBytes: screenshotBytes.length,
      leaseReleased: true,
      marker: 'managed-sdk-route-ok',
      planValid: true,
      syncVersion: 1,
      viewMode: '2.5d',
    });
    assert.equal(
      calls.filter((call) => call.method === 'automation.bulk.read').length,
      0,
      'host-owned screenshot leases must not reach the sidecar',
    );
    assert.equal(calls.filter((call) => call.method === 'view.state.set').length, 1);
    assert.equal(calls.filter((call) => call.method === 'app.protocol').length, 1);
    assert.deepEqual(
      calls.find((call) => call.method === 'app.negotiate').params.requiredCapabilities,
      ['automation.entities.page', 'automation.commands.validate', 'document.write'],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function fixtureViewState() {
  return {
    schema: 'himmelcad.view-state',
    version: 1,
    camera: {
      position: { x: 1, y: 2, z: 3 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      projection: {
        kind: 'perspective',
        verticalFieldOfViewRadians: 1,
        near: 0.1,
        far: 1_000,
      },
    },
    navigationMode: '3d',
    hiddenEntityIds: [],
    selectedEntityIds: [],
    scopedClips: [],
    presentation: {
      background: 'theme',
      renderStyle: 'source',
      showGrid: true,
      showAxes: true,
      showSelectionOutline: true,
    },
  };
}

function screenshotRequest(overrides = {}) {
  return {
    schema: 'himmelcad.screenshot-request',
    version: 1,
    requestId: 'screenshot-test-1',
    format: 'png',
    width: 320,
    height: 200,
    pixelRatio: 1,
    background: 'view',
    includeUi: false,
    ...overrides,
  };
}

test('managed Python output overflow is rejected after the process group is reaped', async (context) => {
  const runtimeRoot = resolve(__dirname, '../../../../.build/automation-runtime/linux-x64');
  if (!existsSync('/usr/bin/bwrap') || !existsSync(resolve(runtimeRoot, 'python/bin/python3'))) {
    context.skip('staged Linux automation runtime or bwrap is unavailable');
    return;
  }
  const workspace = await mkdtemp(resolve(tmpdir(), 'hcad-automation-overflow-test-'));
  try {
    await writeFile(
      resolve(workspace, 'overflow.py'),
      'import os\nwhile True:\n    os.write(1, b"x" * 4096)\n',
    );
    const router = new AutomationRpcRouter({
      sidecarCall: async () => negotiationResult([]),
    });
    const host = new ManagedPythonHost({
      runtimeRoot,
      router,
      timeoutMs: 15_000,
      maxOutputBytes: 1024,
    });
    host.registerWorkspaceCapability('overflow-workspace', workspace);
    await assert.rejects(
      host.run({
        workspaceCapabilityId: 'overflow-workspace',
        scriptRelativePath: 'overflow.py',
      }),
      /combined output limit/u,
    );
    assert.equal(host.child, null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function negotiate(router) {
  const response = await router.handle({
    id: 0,
    method: 'app.negotiate',
    params: {
      clientName: 'test',
      supportedVersions: [1],
      requiredCapabilities: [],
      optionalCapabilities: [],
    },
  });
  assert.equal(response.result.selectedVersion, 1);
  return response.result;
}

test('X3 generated registry routes three command surfaces through the renderer host', async () => {
  const calls = [];
  const router = new AutomationRpcRouter({
    sidecarCall: async (method) =>
      method === 'app.negotiate' ? negotiationResult([]) : { unexpected: method },
    viewCall: async (method, params) => {
      calls.push({ method, params });
      return { schemaId: 'hcad.command-result@1', payload: { ok: true } };
    },
  });
  await negotiate(router);
  for (const [index, method] of ['view.frame', 'view.preset.top', 'select.clear'].entries()) {
    const response = await router.handle({
      id: 100 + index,
      method,
      params: { schemaId: 'hcad.command@1', payload: {} },
    });
    assert.equal(response.result.payload.ok, true);
  }
  assert.deepEqual(calls.map((call) => call.method), [
    'view.frame',
    'view.preset.top',
    'select.clear',
  ]);
});

function negotiationResult(capabilities) {
  return {
    selectedVersion: 1,
    serverName: 'test',
    serverVersion: '0.0.0-test',
    sessionId: 'sidecar-test-session',
    capabilities,
  };
}

test('harness discovery probes a candidate without network or executable-root writes', async (context) => {
  if (!existsSync('/usr/bin/bwrap')) {
    context.skip('bwrap is unavailable');
    return;
  }
  const root = await mkdtemp(resolve(tmpdir(), 'hcad-harness-probe-test-'));
  try {
    const bin = resolve(root, 'bin');
    await mkdir(bin);
    const executable = resolve(bin, 'codex');
    await writeFile(
      executable,
      [
        '#!/usr/bin/python3',
        'import socket',
        'write_blocked = False',
        'try:',
        '    open("/harness/probe-write", "w").close()',
        'except OSError:',
        '    write_blocked = True',
        'network_blocked = False',
        'try:',
        '    socket.create_connection(("1.1.1.1", 443), timeout=0.1)',
        'except OSError:',
        '    network_blocked = True',
        'print(f"fake-codex network={network_blocked} write={write_blocked}")',
      ].join('\n'),
    );
    await chmod(executable, 0o700);
    const transport = new DesktopAgentHarnessHostTransport({ approvedPath: bin });
    const response = await transport.request({
      kind: 'discover',
      provider: 'codex',
      executableNames: ['codex'],
      versionArgs: ['--version'],
      timeoutMs: 2_000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(response.kind, 'discovered');
    assert.match(response.identity.version, /network=True write=True/u);
    assert.equal(existsSync(resolve(root, 'probe-write')), false);
    await transport.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('harness discovery rejects a PATH symlink escaping its executable root', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'hcad-harness-symlink-test-'));
  const outside = await mkdtemp(resolve(tmpdir(), 'hcad-harness-symlink-victim-'));
  try {
    const bin = resolve(root, 'bin');
    await mkdir(bin);
    const victim = resolve(outside, 'codex');
    await writeFile(victim, '#!/usr/bin/python3\nprint("must not execute")\n');
    await chmod(victim, 0o700);
    await symlink(victim, resolve(bin, 'codex'));
    const transport = new DesktopAgentHarnessHostTransport({ approvedPath: bin });
    await assert.rejects(
      transport.request({
        kind: 'discover',
        provider: 'codex',
        executableNames: ['codex'],
        versionArgs: ['--version'],
        timeoutMs: 2_000,
        maxOutputBytes: 64 * 1024,
      }),
      /escaped its approved executable root/u,
    );
    await transport.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

for (const fixture of [
  { provider: 'claude', mode: 'claudeJson', version: '2.1.211' },
  { provider: 'opencode', mode: 'openCodeJson', version: '1.15.11' },
]) {
  test(`${fixture.provider} JSON harness streams through the private SDK sandbox`, async (context) => {
    const harness = await createJsonHarnessFixture(context, fixture);
    if (!harness) return;
    const { transport, identity, workspace } = harness;
    assert.deepEqual(identity.capabilities, [fixture.mode]);
    const opened = await transport.request({
      kind: 'openSession',
      identity,
      mode: fixture.mode,
      scope: harnessScope(`${fixture.provider}-workspace`),
      systemPrompt: `Use the private SDK from ${fixture.provider}.`,
      experimentalApi: false,
    });
    assert.equal(opened.kind, 'sessionOpened');
    const events = [];
    transport.subscribe(opened.hostSessionId, (event) => events.push(event));
    await transport.request({
      kind: 'sendTurn',
      sessionId: opened.hostSessionId,
      turnId: `${fixture.provider}-stream`,
      prompt: '--dangerously-skip-permissions inspect entities',
    });
    await waitForHarnessEvent(
      events,
      (event) => event.type === 'turn.completed' && event.turn_id === `${fixture.provider}-stream`,
    );
    const contract = events.find((event) => event.type === 'hcad.test.contract');
    assert.equal(contract.prompt, '--dangerously-skip-permissions inspect entities');
    assert.equal(contract.systemPrompt, `Use the private SDK from ${fixture.provider}.`);
    assert.equal(contract.networkBlocked, true);
    assert.equal(contract.writeBlocked, true);
    assert.equal(contract.sdk, '1 harness-agent-entity');
    assert.equal(existsSync(resolve(workspace, 'forbidden-write')), false);
    if (fixture.provider === 'claude') {
      assert.equal(
        events.some(
          (event) => event.type === 'assistant' && event.message?.text === 'streamed response',
        ),
        true,
      );
      assert.deepEqual(contract.arguments, [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--input-format',
        'text',
        '--permission-mode',
        'dontAsk',
        '--tools',
        'Bash,Read,Glob,Grep',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--no-session-persistence',
        '--append-system-prompt-file',
        '/automation-bridge/system-prompt.md',
        'Execute the user task supplied on standard input.',
      ]);
      assert.equal(contract.nonessentialTrafficDisabled, '1');
    } else {
      assert.equal(
        events.some((event) => event.type === 'text' && event.part?.text === 'streamed response'),
        true,
      );
      assert.deepEqual(contract.arguments, [
        '--pure',
        'run',
        '--format',
        'json',
        '--dir',
        '/workspace',
        '--agent',
        'himmelcad',
      ]);
      assert.deepEqual(contract.openCodePermission, {
        '*': 'deny',
        bash: 'allow',
        doom_loop: 'deny',
        edit: 'deny',
        external_directory: 'deny',
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        question: 'deny',
        read: 'allow',
        task: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
      });
      assert.equal(contract.openCodePrompt, '{file:/automation-bridge/system-prompt.md}');
    }
    assert.equal(
      events.some((event) => event.type === 'hcad.test.unterminated'),
      true,
    );
    await transport.close();
  });

  test(`${fixture.provider} harness rejects malformed JSON and reports non-zero exits`, async (context) => {
    const harness = await createJsonHarnessFixture(context, fixture);
    if (!harness) return;
    const opened = await openJsonHarnessSession(harness, fixture);
    const events = [];
    harness.transport.subscribe(opened.hostSessionId, (event) => events.push(event));
    await harness.transport.request({
      kind: 'sendTurn',
      sessionId: opened.hostSessionId,
      turnId: `${fixture.provider}-bad-json`,
      prompt: 'fail-json',
    });
    await waitForHarnessEvent(
      events,
      (event) => event.type === 'turn.failed' && event.turn_id === `${fixture.provider}-bad-json`,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === 'error' && event.message === `Invalid ${fixture.provider} JSON event.`,
      ),
      true,
    );
    await harness.transport.request({
      kind: 'sendTurn',
      sessionId: opened.hostSessionId,
      turnId: `${fixture.provider}-exit`,
      prompt: 'fail-exit',
    });
    await waitForHarnessEvent(
      events,
      (event) => event.type === 'turn.failed' && event.turn_id === `${fixture.provider}-exit`,
    );
    const failed = events.find(
      (event) => event.type === 'turn.failed' && event.turn_id === `${fixture.provider}-exit`,
    );
    assert.equal(failed.exit_code, 17);
    assert.match(failed.message, /fixture failure/u);
    await harness.transport.close();
  });

  test(`${fixture.provider} harness cancellation reaps the turn and keeps the session reusable`, async (context) => {
    const harness = await createJsonHarnessFixture(context, fixture);
    if (!harness) return;
    const opened = await openJsonHarnessSession(harness, fixture);
    const events = [];
    harness.transport.subscribe(opened.hostSessionId, (event) => events.push(event));
    await harness.transport.request({
      kind: 'sendTurn',
      sessionId: opened.hostSessionId,
      turnId: `${fixture.provider}-cancel`,
      prompt: 'sleep',
    });
    await waitForHarnessEvent(events, (event) => event.type === 'hcad.test.sleeping');
    await harness.transport.request({
      kind: 'interrupt',
      sessionId: opened.hostSessionId,
      turnId: `${fixture.provider}-cancel`,
    });
    await waitForHarnessEvent(
      events,
      (event) => event.type === 'turn.failed' && event.turn_id === `${fixture.provider}-cancel`,
    );
    await harness.transport.request({
      kind: 'sendTurn',
      sessionId: opened.hostSessionId,
      turnId: `${fixture.provider}-after-cancel`,
      prompt: 'inspect entities',
    });
    await waitForHarnessEvent(
      events,
      (event) =>
        event.type === 'turn.completed' && event.turn_id === `${fixture.provider}-after-cancel`,
    );
    await harness.transport.close();
  });

  test(`${fixture.provider} provider-only sessions fail closed without an audited manifest`, async (context) => {
    const harness = await createJsonHarnessFixture(context, fixture);
    if (!harness) return;
    await assert.rejects(
      harness.transport.request({
        kind: 'openSession',
        identity: harness.identity,
        mode: fixture.mode,
        scope: { ...harnessScope(`${fixture.provider}-workspace`), network: 'providerOnly' },
        systemPrompt: 'Use the private SDK.',
        experimentalApi: false,
      }),
      /Provider-only network egress is unavailable and fails closed/u,
    );
    await harness.transport.close();
  });
}

test('provider-only harness relays only the manifest route and preserves the scoped SDK socket', async (context) => {
  const runtimeRoot = resolve(__dirname, '../../../../.build/automation-runtime/linux-x64');
  if (!existsSync('/usr/bin/bwrap') || !existsSync(resolve(runtimeRoot, 'python/bin/python3'))) {
    context.skip('staged Linux automation runtime or bwrap is unavailable');
    return;
  }
  const root = await mkdtemp(resolve(tmpdir(), 'hcad-provider-only-test-'));
  const workspace = resolve(root, 'workspace');
  const bin = resolve(root, 'bin');
  const authorizationBuffers = [];
  const upstreamRequests = [];
  try {
    await mkdir(workspace);
    await mkdir(bin);
    const executable = resolve(bin, 'codex');
    await writeFile(
      executable,
      [
        '#!/usr/bin/python3',
        'import json',
        'import subprocess',
        'import sys',
        'import urllib.request',
        'if "--version" in sys.argv:',
        '    print("fake-codex 1.0")',
        '    raise SystemExit(0)',
        'prompt = sys.stdin.read()',
        'path = "/v1/forbidden" if prompt.startswith("wrong") else "/v1/responses"',
        'body = json.dumps({"model": "fake", "input": prompt}).encode()',
        'headers = {"Content-Type": "application/json", "Accept": "application/json"}',
        'if prompt.startswith("smuggle"):',
        '    headers["Authorization"] = "Bearer child-secret"',
        'request = urllib.request.Request("http://127.0.0.1:43171" + path, data=body, headers=headers, method="POST")',
        'try:',
        '    with urllib.request.urlopen(request, timeout=2) as response:',
        '        provider_status = response.status',
        'except Exception as error:',
        '    print(json.dumps({"type": "provider.error", "message": str(error)}))',
        '    raise SystemExit(23)',
        'probe = subprocess.run(["/runtime/python/bin/python3", "-I", "-B", "-c", "from himmelcad_host import client; c=client(); s=c.negotiate(required_capabilities=(\'automation.entities.page\',)); p=c.entities_page(limit=1, byte_limit=4096); print(s.selected_version, p.items[0].id)"], close_fds=True, check=True, capture_output=True, text=True)',
        'print(json.dumps({"type": "fake.completed", "providerStatus": provider_status, "sdk": probe.stdout.strip()}))',
      ].join('\n'),
    );
    await chmod(executable, 0o700);
    const router = new AutomationRpcRouter({
      sidecarCall: async (method) => {
        if (method === 'app.negotiate') {
          return negotiationResult(['automation.entities.page']);
        }
        if (method === 'automation.entities.page') {
          return {
            generation: 1,
            items: [
              {
                id: 'provider-agent-entity',
                revision: 1,
                versionHash: '33'.repeat(32),
                typeId: 'hcad.test@1',
                name: 'Provider agent entity',
                layerIds: [],
              },
            ],
            returnedBytes: 128,
          };
        }
        assert.fail(`unexpected provider-only sidecar call: ${method}`);
      },
    });
    const transport = new DesktopAgentHarnessHostTransport({
      approvedPath: bin,
      runtimeRoot,
      router,
      providerEgressManifest: providerManifest(),
      getAuthorization: async () => {
        const value = Buffer.from('Bearer host-only-test-secret');
        authorizationBuffers.push(value);
        return value;
      },
      authorizationAvailable: async () => true,
      _providerForwardRequestForTest: async (request) => {
        upstreamRequests.push(request);
        assert.equal(request.authorization, 'Bearer host-only-test-secret');
        request.response.writeHead(200, { 'content-type': 'application/json' });
        request.response.end(JSON.stringify({ id: 'fake-response', status: 'completed' }));
      },
    });
    transport.registerWorkspaceCapability('provider-workspace', workspace);
    const discovery = await transport.request({
      kind: 'discover',
      provider: 'codex',
      executableNames: ['codex'],
      versionArgs: ['--version'],
      timeoutMs: 2_000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(discovery.kind, 'discovered');
    assert.equal(discovery.identity.capabilities.includes('providerOnly'), true);
    const opened = await transport.request({
      kind: 'openSession',
      identity: discovery.identity,
      mode: 'codexExecJson',
      scope: {
        workspaceCapabilityId: 'provider-workspace',
        filesystem: 'readOnly',
        network: 'providerOnly',
        destructiveCommands: 'productApprovalRequired',
      },
      systemPrompt: 'Use the private SDK.',
      experimentalApi: false,
    });
    assert.equal(opened.kind, 'sessionOpened');
    const events = [];
    const unsubscribe = transport.subscribe(opened.hostSessionId, (event) => events.push(event));
    await transport.request({
      kind: 'sendTurn',
      sessionId: opened.hostSessionId,
      turnId: 'wrong-provider-route',
      prompt: 'wrong route',
    });
    await waitForHarnessEvent(
      events,
      (event) => event.type === 'turn.failed' && event.turn_id === 'wrong-provider-route',
    );
    assert.equal(upstreamRequests.length, 0);
    await transport.request({
      kind: 'sendTurn',
      sessionId: opened.hostSessionId,
      turnId: 'provider-header-smuggle',
      prompt: 'smuggle authorization',
    });
    await waitForHarnessEvent(
      events,
      (event) => event.type === 'turn.failed' && event.turn_id === 'provider-header-smuggle',
    );
    assert.equal(upstreamRequests.length, 0);
    await transport.request({
      kind: 'sendTurn',
      sessionId: opened.hostSessionId,
      turnId: 'provider-route-ok',
      prompt: 'inspect one entity',
    });
    await waitForHarnessEvent(
      events,
      (event) => event.type === 'turn.completed' && event.turn_id === 'provider-route-ok',
    );
    const completion = events.find((event) => event.type === 'fake.completed');
    assert.deepEqual(completion, {
      type: 'fake.completed',
      providerStatus: 200,
      sdk: '1 provider-agent-entity',
    });
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].manifest.origin, 'https://provider.example');
    assert.equal(
      authorizationBuffers.every((buffer) => buffer.every((byte) => byte === 0)),
      true,
    );
    unsubscribe();
    await transport.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider-only configuration and readiness fail closed', async (context) => {
  assert.throws(
    () => new DesktopAgentHarnessHostTransport({ providerEgressManifest: providerManifest() }),
    /requires both/u,
  );
  assert.throws(
    () =>
      new DesktopAgentHarnessHostTransport({
        providerEgressManifest: { ...providerManifest(), origin: 'http://provider.example' },
        getAuthorization: async () => 'Bearer secret',
      }),
    /HTTPS origin/u,
  );
  if (!existsSync('/usr/bin/bwrap')) {
    context.skip('bwrap is unavailable');
    return;
  }
  const root = await mkdtemp(resolve(tmpdir(), 'hcad-provider-readiness-test-'));
  try {
    const bin = resolve(root, 'bin');
    await mkdir(bin);
    const executable = resolve(bin, 'codex');
    await writeFile(executable, '#!/usr/bin/python3\nprint("fake-codex 1.0")\n');
    await chmod(executable, 0o700);
    const transport = new DesktopAgentHarnessHostTransport({
      approvedPath: bin,
      providerEgressManifest: providerManifest(),
      getAuthorization: async () => null,
    });
    const discovery = await transport.request({
      kind: 'discover',
      provider: 'codex',
      executableNames: ['codex'],
      versionArgs: ['--version'],
      timeoutMs: 2_000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(discovery.kind, 'discovered');
    assert.equal(discovery.identity.capabilities.includes('providerOnly'), false);
    await transport.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider-only broker rejects private and metadata origins before a turn starts', async (context) => {
  const runtimeRoot = resolve(__dirname, '../../../../.build/automation-runtime/linux-x64');
  if (!existsSync('/usr/bin/bwrap') || !existsSync(resolve(runtimeRoot, 'python/bin/python3'))) {
    context.skip('staged Linux automation runtime or bwrap is unavailable');
    return;
  }
  const root = await mkdtemp(resolve(tmpdir(), 'hcad-provider-private-origin-test-'));
  const workspace = resolve(root, 'workspace');
  const bin = resolve(root, 'bin');
  try {
    await mkdir(workspace);
    await mkdir(bin);
    const executable = resolve(bin, 'codex');
    await writeFile(executable, '#!/usr/bin/python3\nprint("fake-codex 1.0")\n');
    await chmod(executable, 0o700);
    for (const origin of ['https://127.0.0.1', 'https://169.254.169.254']) {
      const router = new AutomationRpcRouter({
        sidecarCall: async () => negotiationResult([]),
      });
      const transport = new DesktopAgentHarnessHostTransport({
        approvedPath: bin,
        runtimeRoot,
        router,
        providerEgressManifest: { ...providerManifest(), origin },
        authorizationAvailable: async () => true,
        getAuthorization: async () => Buffer.from('Bearer private-origin-test'),
      });
      transport.registerWorkspaceCapability('private-origin-workspace', workspace);
      const discovery = await transport.request({
        kind: 'discover',
        provider: 'codex',
        executableNames: ['codex'],
        versionArgs: ['--version'],
        timeoutMs: 2_000,
        maxOutputBytes: 64 * 1024,
      });
      assert.equal(discovery.kind, 'discovered');
      const opened = await transport.request({
        kind: 'openSession',
        identity: discovery.identity,
        mode: 'codexExecJson',
        scope: {
          workspaceCapabilityId: 'private-origin-workspace',
          filesystem: 'readOnly',
          network: 'providerOnly',
          destructiveCommands: 'productApprovalRequired',
        },
        systemPrompt: 'Use the private SDK.',
        experimentalApi: false,
      });
      assert.equal(opened.kind, 'sessionOpened');
      await assert.rejects(
        transport.request({
          kind: 'sendTurn',
          sessionId: opened.hostSessionId,
          turnId: 'private-origin-turn',
          prompt: 'must fail before launch',
        }),
        /denied or unavailable network range/u,
      );
      await transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real Codex provider-only turn invokes the managed SDK through the scoped socket', async (context) => {
  const codex = '/home/oem/.nvm/versions/node/v22.18.0/bin/codex';
  const runtimeRoot = resolve(__dirname, '../../../../.build/automation-runtime/linux-x64');
  if (
    !existsSync(codex) ||
    !existsSync('/usr/bin/bwrap') ||
    !existsSync(resolve(runtimeRoot, 'python/bin/python3'))
  ) {
    context.skip('real Codex, staged Linux runtime, or bwrap is unavailable');
    return;
  }
  const workspace = await mkdtemp(resolve(tmpdir(), 'hcad-real-codex-provider-test-'));
  let toolRoundTrip = false;
  try {
    const router = new AutomationRpcRouter({
      sidecarCall: async (method) => {
        if (method === 'app.negotiate') {
          return negotiationResult(['automation.entities.page']);
        }
        if (method === 'automation.entities.page') {
          return {
            generation: 1,
            items: [
              {
                id: 'real-codex-entity',
                revision: 1,
                versionHash: '44'.repeat(32),
                typeId: 'hcad.test@1',
                name: 'Real Codex entity',
                layerIds: [],
              },
            ],
            returnedBytes: 128,
          };
        }
        assert.fail(`unexpected real Codex sidecar call: ${method}`);
      },
    });
    const transport = new DesktopAgentHarnessHostTransport({
      approvedPath: resolve(codex, '..'),
      runtimeRoot,
      router,
      providerEgressManifest: providerManifest(),
      authorizationAvailable: async () => true,
      getAuthorization: async () => Buffer.from('Bearer real-codex-test-secret'),
      _providerForwardRequestForTest: async (request) => {
        const body = JSON.parse(request.body.toString('utf8'));
        const output = body.input.find((item) => item.type === 'custom_tool_call_output');
        if (output) {
          assert.match(JSON.stringify(output.output), /network_blocked=True 1 real-codex-entity/u);
          toolRoundTrip = true;
          writeFakeResponsesStream(request.response, fakeFinalResponseEvents(body.model));
        } else {
          writeFakeResponsesStream(request.response, fakeSdkToolEvents(body.model));
        }
      },
    });
    transport.registerWorkspaceCapability('real-codex-workspace', workspace);
    const discovery = await transport.request({
      kind: 'discover',
      provider: 'codex',
      executableNames: ['codex'],
      versionArgs: ['--version'],
      timeoutMs: 2_000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(discovery.kind, 'discovered');
    if (discovery.identity.version !== 'codex-cli 0.144.5') {
      await transport.close();
      context.skip(`real Codex probe is pinned to 0.144.5, found ${discovery.identity.version}`);
      return;
    }
    const opened = await transport.request({
      kind: 'openSession',
      identity: discovery.identity,
      mode: 'codexExecJson',
      scope: {
        workspaceCapabilityId: 'real-codex-workspace',
        filesystem: 'readOnly',
        network: 'providerOnly',
        destructiveCommands: 'productApprovalRequired',
      },
      systemPrompt: 'Use /runtime/python/bin/python3 and the HimmelCAD SDK.',
      experimentalApi: false,
    });
    assert.equal(opened.kind, 'sessionOpened');
    const events = [];
    transport.subscribe(opened.hostSessionId, (event) => events.push(event));
    await transport.request({
      kind: 'sendTurn',
      sessionId: opened.hostSessionId,
      turnId: 'real-codex-sdk-turn',
      prompt: 'Negotiate with HimmelCAD and inspect one entity.',
    });
    await waitForHarnessEvent(
      events,
      (event) => event.type === 'item.completed' && event.item?.type === 'agent_message',
    );
    assert.equal(toolRoundTrip, true);
    await transport.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function providerManifest() {
  return {
    provider: 'codex',
    origin: 'https://provider.example',
    requests: [{ method: 'POST', path: '/v1/responses' }],
    redirects: 'deny',
    websockets: 'deny',
  };
}

function harnessScope(workspaceCapabilityId) {
  return {
    workspaceCapabilityId,
    filesystem: 'readOnly',
    network: 'disabled',
    destructiveCommands: 'productApprovalRequired',
  };
}

async function openJsonHarnessSession(harness, fixture) {
  const opened = await harness.transport.request({
    kind: 'openSession',
    identity: harness.identity,
    mode: fixture.mode,
    scope: harnessScope(`${fixture.provider}-workspace`),
    systemPrompt: `Use the private SDK from ${fixture.provider}.`,
    experimentalApi: false,
  });
  assert.equal(opened.kind, 'sessionOpened');
  return opened;
}

async function createJsonHarnessFixture(context, fixture) {
  const runtimeRoot = resolve(__dirname, '../../../../.build/automation-runtime/linux-x64');
  if (!existsSync('/usr/bin/bwrap') || !existsSync(resolve(runtimeRoot, 'python/bin/python3'))) {
    context.skip('staged Linux automation runtime or bwrap is unavailable');
    return null;
  }
  const root = await mkdtemp(resolve(tmpdir(), `hcad-${fixture.provider}-harness-test-`));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, 'workspace');
  const bin = resolve(root, 'bin');
  await mkdir(workspace);
  await mkdir(bin);
  const executable = resolve(bin, fixture.provider);
  await writeFile(
    executable,
    [
      '#!/usr/bin/python3',
      'import json',
      'import os',
      'import socket',
      'import subprocess',
      'import sys',
      'import time',
      `provider = ${JSON.stringify(fixture.provider)}`,
      `version = ${JSON.stringify(fixture.version)}`,
      'if "--version" in sys.argv:',
      '    print(f"{provider} {version}")',
      '    raise SystemExit(0)',
      'arguments = sys.argv[1:]',
      'prompt = sys.stdin.read()',
      'if prompt == "fail-json":',
      '    sys.stdout.write("not-json\\n")',
      '    sys.stdout.flush()',
      '    time.sleep(0.1)',
      '    raise SystemExit(0)',
      'if prompt == "fail-exit":',
      '    print("fixture failure", file=sys.stderr)',
      '    raise SystemExit(17)',
      'if prompt == "sleep":',
      '    print(json.dumps({"type": "hcad.test.sleeping"}), flush=True)',
      '    time.sleep(30)',
      '    raise SystemExit(0)',
      'system_prompt = open("/automation-bridge/system-prompt.md", encoding="utf-8").read()',
      'write_blocked = False',
      'try:',
      '    open("/workspace/forbidden-write", "w").close()',
      'except OSError:',
      '    write_blocked = True',
      'network_blocked = False',
      'try:',
      '    socket.create_connection(("1.1.1.1", 443), timeout=0.1)',
      'except OSError:',
      '    network_blocked = True',
      'probe = subprocess.run(["/runtime/python/bin/python3", "-I", "-B", "-c", "from himmelcad_host import client; c=client(); s=c.negotiate(required_capabilities=(\'automation.entities.page\',)); p=c.entities_page(limit=1, byte_limit=4096); print(s.selected_version, p.items[0].id)"], close_fds=True, check=True, capture_output=True, text=True)',
      'contract = {',
      '    "type": "hcad.test.contract",',
      '    "arguments": arguments,',
      '    "prompt": prompt,',
      '    "systemPrompt": system_prompt,',
      '    "networkBlocked": network_blocked,',
      '    "writeBlocked": write_blocked,',
      '    "sdk": probe.stdout.strip(),',
      '}',
      'if provider == "claude":',
      '    contract["nonessentialTrafficDisabled"] = os.environ.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")',
      'else:',
      '    config = json.loads(os.environ["OPENCODE_CONFIG_CONTENT"])',
      '    contract["openCodePermission"] = config["agent"]["himmelcad"]["permission"]',
      '    contract["openCodePrompt"] = config["agent"]["himmelcad"]["prompt"]',
      'provider_event = {"type": "assistant", "message": {"text": "streamed response"}} if provider == "claude" else {"type": "text", "part": {"text": "streamed response"}}',
      'encoded = json.dumps(provider_event) + "\\n" + json.dumps(contract) + "\\n"',
      'sys.stdout.write(encoded[:7])',
      'sys.stdout.flush()',
      'time.sleep(0.02)',
      'sys.stdout.write(encoded[7:])',
      'sys.stdout.write(json.dumps({"type": "hcad.test.unterminated"}))',
      'sys.stdout.flush()',
    ].join('\n'),
  );
  await chmod(executable, 0o700);
  const router = new AutomationRpcRouter({
    sidecarCall: async (method) => {
      if (method === 'app.negotiate') {
        return negotiationResult(['automation.entities.page']);
      }
      if (method === 'automation.entities.page') {
        return {
          generation: 1,
          items: [
            {
              id: 'harness-agent-entity',
              revision: 1,
              versionHash: '77'.repeat(32),
              typeId: 'hcad.test@1',
              name: 'Harness agent entity',
              layerIds: [],
            },
          ],
          returnedBytes: 128,
        };
      }
      assert.fail(`unexpected JSON harness sidecar call: ${method}`);
    },
  });
  const transport = new DesktopAgentHarnessHostTransport({
    approvedPath: bin,
    runtimeRoot,
    router,
  });
  transport.registerWorkspaceCapability(`${fixture.provider}-workspace`, workspace);
  const discovery = await transport.request({
    kind: 'discover',
    provider: fixture.provider,
    executableNames: [fixture.provider],
    versionArgs: ['--version'],
    timeoutMs: 2_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.equal(discovery.kind, 'discovered');
  assert.match(discovery.identity.version, new RegExp(fixture.version.replaceAll('.', '\\.')));
  return { transport, identity: discovery.identity, workspace };
}

async function waitForHarnessEvent(events, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`timed out waiting for harness event; events=${JSON.stringify(events)}`);
}

function writeFakeResponsesStream(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  );
}

function fakeResponse(id, model, output = [], status = 'in_progress') {
  return {
    id,
    object: 'response',
    created_at: 1,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    prompt_cache_key: null,
    reasoning: { effort: 'low', summary: null },
    safety_identifier: null,
    service_tier: 'default',
    store: false,
    temperature: null,
    text: { format: { type: 'text' }, verbosity: 'low' },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: null,
    truncation: 'disabled',
    usage: null,
    user: null,
  };
}

function fakeUsage() {
  return {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 15,
  };
}

function fakeSdkToolEvents(model) {
  // The escapes belong to the nested JavaScript/Python command fixture.
  /* eslint-disable no-useless-escape */
  const input =
    'const r = await tools.exec_command({cmd:"/runtime/python/bin/python3 -I -B -c \\\"import socket; probe=socket.socket(); probe.settimeout(0.1); network_blocked=probe.connect_ex((\\\'1.1.1.1\\\',443)) != 0; probe.close(); from himmelcad_host import client; c=client(); s=c.negotiate(required_capabilities=(\\\'automation.entities.page\\\',)); p=c.entities_page(limit=1, byte_limit=4096); print(f\\\'network_blocked={network_blocked}\\\', s.selected_version, p.items[0].id)\\\"",workdir:"/workspace",yield_time_ms:30000,max_output_tokens:2000}); text(r.output);';
  /* eslint-enable no-useless-escape */
  const item = {
    id: 'ctc_sdk',
    type: 'custom_tool_call',
    status: 'completed',
    call_id: 'call_sdk',
    name: 'exec',
    input,
  };
  return [
    { type: 'response.created', sequence_number: 0, response: fakeResponse('resp_sdk', model) },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...item, status: 'in_progress', input: '' },
    },
    {
      type: 'response.custom_tool_call_input.delta',
      sequence_number: 2,
      output_index: 0,
      item_id: item.id,
      delta: input,
    },
    {
      type: 'response.custom_tool_call_input.done',
      sequence_number: 3,
      output_index: 0,
      item_id: item.id,
      input,
    },
    { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item },
    {
      type: 'response.completed',
      sequence_number: 5,
      response: { ...fakeResponse('resp_sdk', model, [item], 'completed'), usage: fakeUsage() },
    },
  ];
}

function fakeFinalResponseEvents(model) {
  const content = {
    type: 'output_text',
    text: 'SDK probe complete.',
    annotations: [],
    logprobs: [],
  };
  const item = {
    id: 'msg_sdk',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [content],
  };
  return [
    { type: 'response.created', sequence_number: 0, response: fakeResponse('resp_final', model) },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { ...content, text: '' },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 3,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: content.text,
      logprobs: [],
    },
    {
      type: 'response.output_text.done',
      sequence_number: 4,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: content.text,
      logprobs: [],
    },
    {
      type: 'response.content_part.done',
      sequence_number: 5,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: content,
    },
    { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item },
    {
      type: 'response.completed',
      sequence_number: 7,
      response: { ...fakeResponse('resp_final', model, [item], 'completed'), usage: fakeUsage() },
    },
  ];
}

test('real Codex discovery is identity-hashed without opening a session', async (context) => {
  const codex = '/home/oem/.nvm/versions/node/v22.18.0/bin/codex';
  if (!existsSync(codex)) {
    context.skip('Codex fixture is unavailable');
    return;
  }
  const transport = new DesktopAgentHarnessHostTransport({
    approvedPath: resolve(codex, '..'),
  });
  const response = await transport.request({
    kind: 'discover',
    provider: 'codex',
    executableNames: ['codex'],
    versionArgs: ['--version'],
    timeoutMs: 2_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.equal(response.kind, 'discovered');
  assert.match(response.identity.canonicalExecutableHash, /^[0-9a-f]{64}$/u);
  assert.match(response.identity.executableId, /^[0-9a-f]{48}$/u);
  assert.equal(response.identity.executableId.includes('/'), false);
  assert.deepEqual(response.identity.capabilities, ['codexExecJson']);
  const workspace = await mkdtemp(resolve(tmpdir(), 'hcad-forged-harness-test-'));
  try {
    transport.registerWorkspaceCapability('forged-test-workspace', workspace);
    await assert.rejects(
      transport.request({
        kind: 'openSession',
        identity: { ...response.identity, canonicalExecutableHash: '00'.repeat(32) },
        mode: 'codexExecJson',
        scope: {
          workspaceCapabilityId: 'forged-test-workspace',
          filesystem: 'readOnly',
          network: 'disabled',
          destructiveCommands: 'productApprovalRequired',
        },
        systemPrompt: 'Use the private HimmelCAD SDK.',
        experimentalApi: false,
      }),
      /not frozen/u,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  await transport.close();
});

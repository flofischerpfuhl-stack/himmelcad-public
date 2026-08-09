'use strict';

const { randomBytes } = require('node:crypto');
const { lstat, mkdir, open, realpath, rename, rm } = require('node:fs/promises');
const { basename, dirname, isAbsolute, relative, resolve, sep } = require('node:path');

const {
  AutomationRpcRouter,
  DesktopAgentHarnessHostTransport,
  ManagedPythonHost,
} = require('./index.cjs');

function registerElectronAutomationHost(options) {
  const { ipcMain } = options;
  const rendererUrl = parseRendererUrl(options.rendererUrl);
  const pendingViews = new Map();
  const pendingConfirmations = new Map();
  const agentSubscriptions = new Map();
  const lifecycleBoundRenderers = new Set();
  let securityOperations = Promise.resolve();
  const router = new AutomationRpcRouter({
    sidecarCall: options.sidecarCall,
    confirmationCall: requestProductConfirmation,
    viewCall: async (method, params) =>
      method === 'view.screenshot'
        ? await captureScreenshot(options.getWindow, callRendererView, params)
        : await callRendererView(method, params),
  });
  const harness = new DesktopAgentHarnessHostTransport({
    approvedPath: options.approvedPath,
    runtimeRoot: options.runtimeRoot,
    router,
    providerEgressManifest: options.providerEgressManifest,
    getAuthorization: options.getAuthorization,
    authorizationAvailable: options.authorizationAvailable,
  });
  const python = new ManagedPythonHost({ runtimeRoot: options.runtimeRoot, router });

  const ready = bootstrapAutomationWorkspace(options.workspaceRoot).then(async (workspaceRoot) => {
    harness.registerWorkspaceCapability(options.workspaceCapabilityId, workspaceRoot);
    python.registerWorkspaceCapability(options.workspaceCapabilityId, workspaceRoot);
  });

  function assertOwner(event) {
    const window = options.getWindow();
    if (!window || !isOwningMainFrame(event, window, rendererUrl)) {
      throw new Error('Automation IPC caller is not the owning renderer.');
    }
    if (!lifecycleBoundRenderers.has(event.sender.id)) {
      lifecycleBoundRenderers.add(event.sender.id);
      event.sender.once('destroyed', () => {
        lifecycleBoundRenderers.delete(event.sender.id);
        void serializeSecurityOperation(stopAgentSessions);
      });
    }
    return window;
  }

  function serializeSecurityOperation(operation) {
    const pending = securityOperations.then(operation);
    securityOperations = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function stopAgentSessions() {
    for (const unsubscribe of agentSubscriptions.values()) unsubscribe();
    agentSubscriptions.clear();
    try {
      await harness.invalidateSessions();
      return true;
    } catch {
      return false;
    }
  }

  function callRendererView(method, params) {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) throw new Error('Renderer view host is unavailable.');
    const requestId = randomBytes(24).toString('hex');
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pendingViews.delete(requestId);
        reject(new Error('Renderer view host timed out.'));
      }, 15_000);
      timer.unref();
      pendingViews.set(requestId, {
        resolve: resolvePromise,
        reject,
        timer,
        senderId: window.webContents.id,
      });
      window.webContents.send('automation:view-request', { requestId, method, params });
    });
  }

  function requestProductConfirmation(details) {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) throw new Error('Product confirmation UI is unavailable.');
    const requestId = randomBytes(24).toString('hex');
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pendingConfirmations.delete(requestId);
        reject(new Error('Product confirmation expired.'));
      }, 60_000);
      timer.unref();
      pendingConfirmations.set(requestId, {
        resolve: resolvePromise,
        reject,
        timer,
        senderId: window.webContents.id,
        details,
      });
      window.webContents.send('automation:confirmation-request', {
        requestId,
        commandId: details.commandId,
        losses: details.losses,
        conflicts: details.conflicts,
      });
    });
  }

  ipcMain.on('automation:view-response', (event, message) => {
    if (!message || typeof message.requestId !== 'string') return;
    const pending = pendingViews.get(message.requestId);
    if (!pending || event.sender.id !== pending.senderId) return;
    pendingViews.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.error && typeof message.error.message === 'string') {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  });
  ipcMain.on('automation:confirmation-response', (event, message) => {
    if (
      !message ||
      typeof message.requestId !== 'string' ||
      !['approved', 'denied'].includes(message.decision)
    ) {
      return;
    }
    const pending = pendingConfirmations.get(message.requestId);
    if (!pending || event.sender.id !== pending.senderId) return;
    pendingConfirmations.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.decision === 'denied') {
      pending.reject(new Error('Product confirmation denied.'));
      return;
    }
    try {
      pending.resolve(options.issueConfirmationGrant(pending.details.planHash));
    } catch (error) {
      pending.reject(error);
    }
  });

  ipcMain.handle('automation:agent:request', async (event, request) => {
    assertOwner(event);
    await ready;
    return await serializeSecurityOperation(() => harness.request(request));
  });
  ipcMain.handle('automation:agent:subscribe', (event, sessionId) => {
    const window = assertOwner(event);
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{48}$/u.test(sessionId)) {
      throw new Error('Invalid agent session subscription.');
    }
    const key = `${event.sender.id}:${sessionId}`;
    agentSubscriptions.get(key)?.();
    const unsubscribe = harness.subscribe(sessionId, (payload) => {
      if (!window.isDestroyed()) {
        window.webContents.send('automation:agent:event', { sessionId, payload });
      }
    });
    agentSubscriptions.set(key, unsubscribe);
    event.sender.once('destroyed', () => {
      agentSubscriptions.get(key)?.();
      agentSubscriptions.delete(key);
    });
    return true;
  });
  ipcMain.handle('automation:agent:unsubscribe', (event, sessionId) => {
    assertOwner(event);
    const key = `${event.sender.id}:${String(sessionId)}`;
    const unsubscribe = agentSubscriptions.get(key);
    unsubscribe?.();
    agentSubscriptions.delete(key);
    return Boolean(unsubscribe);
  });

  if (options.providerCredentialStore) {
    ipcMain.handle('automation:provider-credentials:status', async (event, provider) => {
      assertOwner(event);
      if (provider !== 'codex') return providerCredentialFailure('invalidRequest');
      return await providerCredentialResponse(() =>
        options.providerCredentialStore.status(provider),
      );
    });
    ipcMain.handle('automation:provider-credentials:replace', async (event, request) => {
      assertOwner(event);
      if (
        !isRecord(request) ||
        !hasExactKeys(request, ['provider', 'credential', 'persistence']) ||
        request.provider !== 'codex' ||
        typeof request.credential !== 'string' ||
        !['secure', 'session'].includes(request.persistence)
      ) {
        return providerCredentialFailure('invalidRequest');
      }
      return await serializeSecurityOperation(async () => {
        if (!(await stopAgentSessions())) return providerCredentialFailure('persistenceFailed');
        return await providerCredentialResponse(() =>
          options.providerCredentialStore.replace(request),
        );
      });
    });
    ipcMain.handle('automation:provider-credentials:clear-session', async (event, provider) => {
      assertOwner(event);
      if (provider !== 'codex') return providerCredentialFailure('invalidRequest');
      return await serializeSecurityOperation(async () => {
        if (!(await stopAgentSessions())) return providerCredentialFailure('persistenceFailed');
        return await providerCredentialResponse(() =>
          options.providerCredentialStore.clearSession(provider),
        );
      });
    });
    ipcMain.handle('automation:provider-credentials:delete', async (event, provider) => {
      assertOwner(event);
      if (provider !== 'codex') return providerCredentialFailure('invalidRequest');
      return await serializeSecurityOperation(async () => {
        if (!(await stopAgentSessions())) return providerCredentialFailure('persistenceFailed');
        return await providerCredentialResponse(() =>
          options.providerCredentialStore.delete(provider),
        );
      });
    });
  }

  return {
    router,
    harness,
    python,
    ready,
    async invalidateAgentSessions() {
      await serializeSecurityOperation(stopAgentSessions);
    },
    async dispose() {
      options.providerCredentialStore?.close();
      for (const unsubscribe of agentSubscriptions.values()) unsubscribe();
      agentSubscriptions.clear();
      for (const pending of pendingViews.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Automation host closed.'));
      }
      pendingViews.clear();
      for (const pending of pendingConfirmations.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Automation host closed.'));
      }
      pendingConfirmations.clear();
      router.revokeAll();
      try {
        await Promise.all([harness.close(), python.cancel()]);
      } finally {
        if (options.providerCredentialStore) {
          for (const channel of PROVIDER_CREDENTIAL_CHANNELS) ipcMain.removeHandler(channel);
        }
      }
    },
  };
}

const PROVIDER_CREDENTIAL_CHANNELS = Object.freeze([
  'automation:provider-credentials:status',
  'automation:provider-credentials:replace',
  'automation:provider-credentials:clear-session',
  'automation:provider-credentials:delete',
]);

function isOwningMainFrame(event, window, rendererUrl) {
  return Boolean(
    event?.sender &&
    event.sender.id === window.webContents.id &&
    event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererUrl,
  );
}

function parseRendererUrl(value) {
  if (typeof value !== 'string') throw new TypeError('Renderer URL is invalid.');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Renderer URL is invalid.');
  }
  const loopbackDevelopmentUrl =
    parsed.protocol === 'http:' &&
    parsed.hostname === 'localhost' &&
    (parsed.port === '5173' || parsed.port === '5174');
  if (
    parsed.href !== value ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'file:' && !loopbackDevelopmentUrl)
  ) {
    throw new TypeError('Renderer URL is invalid.');
  }
  return parsed.href;
}

async function providerCredentialResponse(operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return providerCredentialFailure(publicProviderCredentialErrorCode(error?.code));
  }
}

function providerCredentialFailure(code) {
  return { ok: false, error: { code } };
}

function publicProviderCredentialErrorCode(value) {
  return [
    'invalidRequest',
    'secureStorageUnavailable',
    'temporarilyUnavailable',
    'corrupt',
    'unsupportedSchema',
    'persistenceFailed',
  ].includes(value)
    ? value
    : 'persistenceFailed';
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function bootstrapAutomationWorkspace(workspaceRoot) {
  if (!isAbsolute(workspaceRoot)) throw new Error('Automation workspace root must be absolute.');
  const requestedRoot = resolve(workspaceRoot);
  const requestedParent = dirname(requestedRoot);
  await mkdir(requestedParent, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(requestedParent);
  const candidateRoot = resolve(canonicalParent, basename(requestedRoot));
  let metadata;
  try {
    metadata = await lstat(candidateRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (metadata?.isSymbolicLink() || (metadata && !metadata.isDirectory())) {
    throw new Error('Automation workspace root must be a real directory, not a symlink.');
  }
  if (!metadata) await mkdir(candidateRoot, { mode: 0o700 });
  const canonicalRoot = await realpath(candidateRoot);
  if (canonicalRoot !== candidateRoot || !isWithinRoot(canonicalRoot, canonicalParent)) {
    throw new Error('Automation workspace root escaped its trusted parent.');
  }
  await writeWorkspaceFile(
    canonicalRoot,
    'SDK.md',
    [
      '# HimmelCAD automation SDK',
      '',
      'Use `/runtime/python/bin/python3` and `from himmelcad_host import client, async_client`.',
      'Call `negotiate()` before reads, view calls or canonical transactions.',
      'Project persistence is never a filesystem API; query and mutate only through the SDK.',
      '',
    ].join('\n'),
  );
  await writeWorkspaceFile(
    canonicalRoot,
    'SKILLS.md',
    [
      '# HimmelCAD skills',
      '',
      '- Inspect entities with bounded paginated SDK queries.',
      '- Validate every canonical transaction before commit.',
      '- Use bulk leases for geometry, images and screenshots.',
      '- Destructive commits require an explicit product confirmation.',
      '',
    ].join('\n'),
  );
  return canonicalRoot;
}

async function writeWorkspaceFile(canonicalRoot, name, contents) {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name) || Buffer.byteLength(contents) > 64 * 1024) {
    throw new Error('Automation workspace bootstrap file is invalid.');
  }
  const target = resolve(canonicalRoot, name);
  if (!isWithinRoot(target, canonicalRoot))
    throw new Error('Automation workspace file escaped root.');
  const temporary = resolve(canonicalRoot, `.${name}.${randomBytes(16).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    const directory = await open(canonicalRoot, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function isWithinRoot(path, root) {
  const difference = relative(root, path);
  return (
    difference !== '' &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

async function captureScreenshot(getWindow, callRendererView, request) {
  validateScreenshotRequest(request);
  const prepared = await callRendererView('view.screenshot.prepare', request);
  if (!request.includeUi) return validatePreparedScreenshot(prepared, request);
  if (request.background === 'transparent') {
    throw new Error('Transparent screenshots cannot include Electron UI chrome.');
  }
  if (request.format === 'webp') {
    throw new Error('WebP screenshots with Electron UI chrome are not available.');
  }
  const window = getWindow();
  if (!window || window.isDestroyed()) throw new Error('Renderer view host is unavailable.');
  const captureRect = validateCaptureRectangle(prepared?.captureRect, window);
  const captured = await window.webContents.capturePage(captureRect);
  const width = Math.round(request.width * request.pixelRatio);
  const height = Math.round(request.height * request.pixelRatio);
  const capturedSize = captured.getSize();
  const resized =
    capturedSize.width === width && capturedSize.height === height
      ? captured
      : captured.resize({ width, height, quality: 'best' });
  const bytes =
    request.format === 'jpeg'
      ? resized.toJPEG(Math.round((request.quality ?? 0.92) * 100))
      : resized.toPNG();
  return {
    schema: 'himmelcad.screenshot-result',
    version: 1,
    requestId: request.requestId,
    mimeType: request.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    width,
    height,
    encoding: 'base64',
    data: bytes.toString('base64'),
  };
}

function validatePreparedScreenshot(value, request) {
  const width = Math.round(request.width * request.pixelRatio);
  const height = Math.round(request.height * request.pixelRatio);
  const mimeType =
    request.format === 'jpeg'
      ? 'image/jpeg'
      : request.format === 'webp'
        ? 'image/webp'
        : 'image/png';
  if (
    !value ||
    value.schema !== 'himmelcad.screenshot-result' ||
    value.version !== 1 ||
    value.requestId !== request.requestId ||
    value.mimeType !== mimeType ||
    value.width !== width ||
    value.height !== height ||
    value.encoding !== 'base64' ||
    typeof value.data !== 'string'
  ) {
    throw new Error('Renderer returned an invalid GPU screenshot result.');
  }
  return value;
}

function validateScreenshotRequest(request) {
  const allowedKeys = new Set([
    'schema',
    'version',
    'requestId',
    'format',
    'width',
    'height',
    'pixelRatio',
    'background',
    'includeUi',
    'quality',
  ]);
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => !allowedKeys.has(key)) ||
    request.schema !== 'himmelcad.screenshot-request' ||
    request.version !== 1 ||
    typeof request.requestId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(request.requestId) ||
    !['png', 'jpeg', 'webp'].includes(request.format) ||
    !Number.isSafeInteger(request.width) ||
    !Number.isSafeInteger(request.height) ||
    request.width < 1 ||
    request.height < 1 ||
    request.width > 16_384 ||
    request.height > 16_384 ||
    typeof request.pixelRatio !== 'number' ||
    !Number.isFinite(request.pixelRatio) ||
    request.pixelRatio < 0.25 ||
    request.pixelRatio > 4 ||
    !['view', 'transparent'].includes(request.background) ||
    typeof request.includeUi !== 'boolean'
  ) {
    throw new Error('Screenshot request is invalid.');
  }
  const pixels =
    Math.round(request.width * request.pixelRatio) *
    Math.round(request.height * request.pixelRatio);
  if (pixels > 100_000_000) throw new Error('Screenshot pixel budget exceeded.');
  if (
    request.quality !== undefined &&
    (typeof request.quality !== 'number' ||
      !Number.isFinite(request.quality) ||
      request.quality < 0 ||
      request.quality > 1 ||
      request.format === 'png')
  ) {
    throw new Error('Screenshot quality is invalid for the requested format.');
  }
  if (request.background === 'transparent' && request.format === 'jpeg') {
    throw new Error('JPEG cannot preserve a transparent screenshot background.');
  }
}

function validateCaptureRectangle(value, window) {
  if (
    !value ||
    !['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(value[key])) ||
    value.x < 0 ||
    value.y < 0 ||
    value.width <= 0 ||
    value.height <= 0
  ) {
    throw new Error('Renderer returned an invalid viewport capture rectangle.');
  }
  const bounds = typeof window.getContentBounds === 'function' ? window.getContentBounds() : null;
  if (
    bounds &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    (value.x + value.width > Math.floor(bounds.width) ||
      value.y + value.height > Math.floor(bounds.height))
  ) {
    throw new Error('Renderer viewport capture rectangle exceeds the content bounds.');
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function defaultAutomationPaths(repositoryRoot, applicationDataRoot, platform = process.platform) {
  return {
    runtimeRoot:
      platform === 'linux'
        ? resolve(repositoryRoot, '.build/automation-runtime/linux-x64')
        : resolve(repositoryRoot, '.build/automation-runtime/win32-x64'),
    workspaceRoot: resolve(applicationDataRoot, 'automation-workspace'),
  };
}

module.exports = {
  defaultAutomationPaths,
  registerElectronAutomationHost,
  _bootstrapAutomationWorkspaceForTest: bootstrapAutomationWorkspace,
  _captureScreenshotForTest: captureScreenshot,
  _isOwningMainFrameForTest: isOwningMainFrame,
  _providerCredentialResponseForTest: providerCredentialResponse,
};

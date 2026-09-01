'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createServer: createHttpServer } = require('node:http');
const { request: httpsRequest } = require('node:https');
const { lookup: dnsLookup } = require('node:dns/promises');
const { createServer: createNetServer, isIP } = require('node:net');
const { createReadStream } = require('node:fs');
const { access, chmod, mkdtemp, realpath, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { delimiter, isAbsolute, relative, resolve, sep } = require('node:path');
const { constants } = require('node:fs');

// One maximum 8 MiB bulk range expands to ~10.7 MiB as base64 JSON.
const MAX_RPC_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_BYTES = 256 * 1024;
const MAX_BULK_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const PROVIDER_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
const PROVIDER_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const PROVIDER_RELAY_PORT = 43_171;
const PROVIDER_MAX_ACTIVE_REQUESTS = 2;
const PROVIDER_RELAY_SUPERVISOR = String.raw`
import selectors
import socket
import subprocess
import sys
import threading

socket_path = sys.argv[1]
port = int(sys.argv[2])
command = sys.argv[3:]
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", port))
server.listen(16)

def bridge(client):
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        upstream.connect(socket_path)
        selector = selectors.DefaultSelector()
        selector.register(client, selectors.EVENT_READ, upstream)
        selector.register(upstream, selectors.EVENT_READ, client)
        while selector.get_map():
            for key, _ in selector.select():
                data = key.fileobj.recv(65536)
                target = key.data
                if data:
                    target.sendall(data)
                else:
                    selector.unregister(key.fileobj)
                    try:
                        target.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
    finally:
        client.close()
        upstream.close()

def accept_connections():
    while True:
        try:
            client, _ = server.accept()
        except OSError:
            return
        threading.Thread(target=bridge, args=(client,), daemon=True).start()

threading.Thread(target=accept_connections, daemon=True).start()
try:
    completed = subprocess.run(command, pass_fds=(3,))
    raise SystemExit(completed.returncode)
finally:
    server.close()
`;
const ALLOWED_METHODS = new Set([
  'app.negotiate',
  'app.protocol',
  'automation.entities.page',
  'automation.cas.describe',
  'automation.commands.validate',
  'automation.commands.status',
  'automation.commands.cancel',
  'automation.bulk.read',
  'automation.bulk.release',
  'view.state.get',
  'view.state.set',
  'view.screenshot',
]);
const ALLOWED_APP_METHODS = new Set([
  'readDocumentSnapshot',
  'readJournal',
  'readPropertySchemas',
  'queryProperties',
  'compilePropertyEdit',
  'executeCanonicalTransaction',
]);
const VIEW_METHODS = new Set(['view.state.get', 'view.state.set', 'view.screenshot']);

class AutomationRpcRouter {
  #sidecarCall;
  #viewCall;
  #confirmationCall;
  #connections = new Map();

  constructor(options) {
    if (!options || typeof options.sidecarCall !== 'function') {
      throw new TypeError('AutomationRpcRouter requires a sidecarCall function.');
    }
    this.#sidecarCall = options.sidecarCall;
    this.#viewCall = options.viewCall;
    this.#confirmationCall = options.confirmationCall;
  }

  registerConfirmationGrant(input) {
    if (
      !input ||
      !validToken(input.grant, 4_096) ||
      !validIdentifier(input.hostSessionId) ||
      !validIdentifier(input.commandId) ||
      !isSha256(input.planHash) ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= Date.now() ||
      input.expiresAt > Date.now() + 60_000
    ) {
      throw new TypeError('Invalid product confirmation grant.');
    }
    const connection = [...this.#connections.values()].find(
      (candidate) =>
        candidate.hostSessionId === input.hostSessionId &&
        candidate.plans.get(input.commandId)?.planHash === input.planHash,
    );
    if (!connection) throw new TypeError('Confirmation grant has no matching live connection.');
    connection.grants.set(input.grant, {
      commandId: input.commandId,
      planHash: input.planHash,
      expiresAt: input.expiresAt,
    });
  }

  revokeAll() {
    this.#connections.clear();
  }

  openConnection() {
    const connectionId = randomBytes(24).toString('hex');
    this.#connections.set(connectionId, newConnectionState());
    return connectionId;
  }

  closeConnection(connectionId) {
    this.#connections.delete(connectionId);
  }

  async handle(message, connectionId = 'direct') {
    const request = validateRpcRequest(message);
    if (connectionId === 'direct' && !this.#connections.has(connectionId)) {
      this.#connections.set(connectionId, newConnectionState());
    }
    const connection = this.#connections.get(connectionId);
    if (!connection) {
      return {
        id: request.id,
        error: normalizeAutomationError(
          protocolFailure('protocolMismatch', 'Automation connection is closed.'),
        ),
      };
    }
    try {
      const result = await this.#dispatch(connection, request.method, request.params);
      if (!isRecord(result))
        throw protocolFailure('internal', 'Host returned a non-object result.');
      return { id: request.id, result };
    } catch (error) {
      return { id: request.id, error: normalizeAutomationError(error) };
    }
  }

  async #dispatch(connection, method, params) {
    if (!ALLOWED_METHODS.has(method)) {
      throw protocolFailure('permissionDenied', `Automation method is not allowed: ${method}`);
    }
    if (method === 'app.negotiate') return await this.#negotiate(connection, params);
    if (!connection.negotiated) {
      throw protocolFailure('protocolMismatch', 'Automation session has not negotiated.');
    }
    if (VIEW_METHODS.has(method)) {
      if (typeof this.#viewCall !== 'function') {
        throw protocolFailure('missingCapability', 'No renderer view host is registered.');
      }
      const result = await this.#viewCall(method, params);
      return method === 'view.screenshot' ? normalizeScreenshotResult(connection, result) : result;
    }
    if (method === 'automation.bulk.read' && localLease(connection, params)) {
      return readLocalLease(connection, params);
    }
    if (method === 'automation.bulk.release' && localLease(connection, params)) {
      return releaseLocalLease(connection, params);
    }
    const forwardedParams =
      method === 'app.protocol' ? await this.#validateAppProtocol(connection, params) : params;
    const result = await this.#sidecarCall(method, forwardedParams);
    if (method === 'automation.commands.validate') this.#rememberPlan(connection, params, result);
    if (method === 'app.protocol') this.#consumeCommitGrant(connection, forwardedParams);
    return result;
  }

  async #negotiate(connection, params) {
    if (!isRecord(params)) throw protocolFailure('invalidRequest', 'Malformed negotiation.');
    const hostCapabilities = this.#viewCall
      ? [
          'automation.bulk.read',
          'automation.bulk.release',
          'view.read',
          'view.write',
          'view.screenshot',
        ]
      : [];
    const required = Array.isArray(params.requiredCapabilities)
      ? params.requiredCapabilities
      : undefined;
    if (!required) throw protocolFailure('invalidRequest', 'Malformed negotiation capabilities.');
    const sidecarParams = {
      ...params,
      requiredCapabilities: required.filter((capability) => !hostCapabilities.includes(capability)),
    };
    const sidecarResult = await this.#sidecarCall('app.negotiate', sidecarParams);
    if (!isRecord(sidecarResult) || !Array.isArray(sidecarResult.capabilities)) {
      throw protocolFailure('protocolMismatch', 'Sidecar negotiation response is malformed.');
    }
    const capabilities = [...new Set([...sidecarResult.capabilities, ...hostCapabilities])].sort();
    const missing = required.filter((capability) => !capabilities.includes(capability));
    if (missing.length > 0) {
      throw protocolFailure('missingCapability', 'Required automation capability is unavailable.', {
        missing,
      });
    }
    connection.negotiated = true;
    return { ...sidecarResult, sessionId: connection.hostSessionId, capabilities };
  }

  async #validateAppProtocol(connection, params) {
    if (!isRecord(params) || !isRecord(params.request)) {
      throw protocolFailure('invalidRequest', 'Malformed app.protocol envelope.');
    }
    const appMethod = params.request.method;
    if (typeof appMethod !== 'string' || !ALLOWED_APP_METHODS.has(appMethod)) {
      throw protocolFailure('permissionDenied', 'App protocol method is not allowed.');
    }
    if (appMethod !== 'executeCanonicalTransaction') return params;
    const transaction = params.request.params;
    if (!isRecord(transaction) || !validIdentifier(transaction.commandId)) {
      throw protocolFailure('invalidRequest', 'Canonical transaction is malformed.');
    }
    const plan = connection.plans.get(transaction.commandId);
    if (!plan || plan.transactionHash !== stableHash(transaction)) {
      throw protocolFailure(
        'confirmationRequired',
        'Every automation commit requires a current validation plan for the exact transaction.',
      );
    }
    if (!plan.valid) throw protocolFailure('conflict', 'The current validation plan is invalid.');
    if (!plan.requiresConfirmation) return params;
    const grant = confirmationGrant(params.extensions);
    const registered = grant ? connection.grants.get(grant) : undefined;
    if (
      grant &&
      registered &&
      registered.expiresAt > Date.now() &&
      registered.commandId === transaction.commandId &&
      registered.planHash === plan.planHash
    ) {
      return params;
    }
    if (typeof this.#confirmationCall !== 'function') {
      throw protocolFailure(
        'confirmationRequired',
        'A matching, unexpired product confirmation is required.',
      );
    }
    let issuedGrant;
    try {
      issuedGrant = await this.#confirmationCall({
        hostSessionId: connection.hostSessionId,
        commandId: transaction.commandId,
        planHash: plan.planHash,
        losses: plan.losses,
        conflicts: plan.conflicts,
      });
    } catch {
      throw protocolFailure('permissionDenied', 'Product confirmation was denied or expired.');
    }
    const expiresAt = Date.now() + 30_000;
    this.registerConfirmationGrant({
      grant: issuedGrant,
      hostSessionId: connection.hostSessionId,
      commandId: transaction.commandId,
      planHash: plan.planHash,
      expiresAt,
    });
    return {
      ...params,
      extensions: {
        ...(isRecord(params.extensions) ? params.extensions : {}),
        'hcad.automation.confirmation@1': { grant: issuedGrant },
      },
    };
  }

  #rememberPlan(connection, params, result) {
    if (!isRecord(params) || !isRecord(params.transaction) || !isRecord(result)) return;
    const commandId = params.transaction.commandId;
    if (
      !validIdentifier(commandId) ||
      typeof result.planHash !== 'string' ||
      !isSha256(result.planHash) ||
      typeof result.valid !== 'boolean' ||
      typeof result.requiresConfirmation !== 'boolean'
    ) {
      return;
    }
    connection.plans.set(commandId, {
      planHash: result.planHash,
      transactionHash: stableHash(params.transaction),
      valid: result.valid,
      requiresConfirmation: result.requiresConfirmation,
      losses: Array.isArray(result.losses) ? result.losses : [],
      conflicts: Array.isArray(result.conflicts) ? result.conflicts : [],
    });
  }

  #consumeCommitGrant(connection, params) {
    const transaction = params?.request?.params;
    if (!isRecord(transaction) || !validIdentifier(transaction.commandId)) return;
    const grant = confirmationGrant(params.extensions);
    if (grant) connection.grants.delete(grant);
    connection.plans.delete(transaction.commandId);
  }
}

class ManagedPythonHost {
  #options;
  #capabilities = new Map();
  #child = null;

  constructor(options) {
    if (
      !options ||
      !isAbsolute(options.runtimeRoot) ||
      !(options.router instanceof AutomationRpcRouter)
    ) {
      throw new TypeError('ManagedPythonHost requires an absolute runtime root and router.');
    }
    this.#options = {
      bwrapPath: '/usr/bin/bwrap',
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
      maxRpcMessageBytes: MAX_RPC_MESSAGE_BYTES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...options,
    };
  }

  get child() {
    return this.#child;
  }

  registerWorkspaceCapability(capabilityId, directory) {
    if (!validIdentifier(capabilityId) || !isAbsolute(directory)) {
      throw new TypeError('Invalid workspace capability.');
    }
    this.#capabilities.set(capabilityId, resolve(directory));
  }

  revokeWorkspaceCapability(capabilityId) {
    this.#capabilities.delete(capabilityId);
  }

  async run(options) {
    if (process.platform !== 'linux') {
      throw protocolFailure(
        'permissionDenied',
        'Managed Python is disabled: this platform has no audited OS sandbox backend.',
      );
    }
    if (this.#child) throw protocolFailure('invalidRequest', 'A managed Python process is active.');
    const workspace = this.#capabilities.get(options.workspaceCapabilityId);
    if (!workspace) throw protocolFailure('permissionDenied', 'Unknown workspace capability.');
    const canonicalWorkspace = await realpath(workspace);
    const script = resolve(canonicalWorkspace, options.scriptRelativePath);
    if (!isWithin(script, canonicalWorkspace)) {
      throw protocolFailure('permissionDenied', 'Python script escaped its workspace capability.');
    }
    const scriptMetadata = await stat(script);
    if (!scriptMetadata.isFile())
      throw protocolFailure('invalidRequest', 'Python script is not a file.');
    await access(this.#options.bwrapPath, constants.X_OK);
    const runtime = await realpath(this.#options.runtimeRoot);
    const python = resolve(runtime, 'python/bin/python3');
    await access(python, constants.X_OK);
    const filesystem = options.filesystem ?? 'readOnly';
    if (!['readOnly', 'readWrite'].includes(filesystem)) {
      throw protocolFailure('invalidRequest', 'Unknown filesystem scope.');
    }
    const sandboxArguments = [
      '--die-with-parent',
      '--new-session',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-net',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-cgroup-try',
      '--clearenv',
      '--setenv',
      'LANG',
      'C.UTF-8',
      '--setenv',
      'LC_ALL',
      'C.UTF-8',
      '--setenv',
      'PYTHONNOUSERSITE',
      '1',
      '--setenv',
      'PYTHONDONTWRITEBYTECODE',
      '1',
      '--setenv',
      'HIMMELCAD_AUTOMATION_RPC_FD',
      '3',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/usr',
      '--dir',
      '/workspace',
      '--ro-bind',
      runtime,
      '/runtime',
      filesystem === 'readWrite' ? '--bind' : '--ro-bind',
      canonicalWorkspace,
      '/workspace',
      '--chdir',
      '/workspace',
    ];
    for (const directory of ['/usr/lib', '/lib', '/lib64']) {
      try {
        const canonical = await realpath(directory);
        sandboxArguments.push('--ro-bind', canonical, directory);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    sandboxArguments.push(
      '/runtime/python/bin/python3',
      '-I',
      '-B',
      `/${relative(canonicalWorkspace, script).split(sep).join('/')}`.replace(
        /^\//u,
        '/workspace/',
      ),
      ...(options.arguments ?? []),
    );
    return await this.#spawnBounded(this.#options.bwrapPath, sandboxArguments);
  }

  async cancel() {
    const child = this.#child;
    if (!child) return;
    await terminateProcessGroup(child);
  }

  async #spawnBounded(command, args) {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: '/',
        detached: true,
        env: {},
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      this.#child = child;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let terminalError = null;
      let timer;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#child = null;
        callback();
      };
      const append = (current, chunk) => {
        if (stdout.length + stderr.length + chunk.length > this.#options.maxOutputBytes) {
          throw protocolFailure(
            'invalidRequest',
            'Managed process combined output limit exceeded.',
          );
        }
        return Buffer.concat([current, chunk]);
      };
      const failAndReap = (error) => {
        if (terminalError) return;
        terminalError = error;
        void terminateProcessGroup(child);
      };
      child.stdout.on('data', (chunk) => {
        try {
          stdout = append(stdout, chunk);
        } catch (error) {
          failAndReap(error);
        }
      });
      child.stderr.on('data', (chunk) => {
        try {
          stderr = append(stderr, chunk);
        } catch (error) {
          failAndReap(error);
        }
      });
      const rpc = child.stdio[3];
      attachRpcBridge(rpc, this.#options.router, this.#options.maxRpcMessageBytes, failAndReap);
      child.once('error', (error) => finish(() => reject(error)));
      child.once('exit', (exitCode, signal) => {
        finish(() => {
          if (terminalError) {
            reject(terminalError);
          } else {
            resolvePromise({
              exitCode,
              signal,
              stdout: stdout.toString('utf8'),
              stderr: stderr.toString('utf8'),
            });
          }
        });
      });
      timer = setTimeout(() => {
        failAndReap(protocolFailure('cancelled', 'Managed Python process timed out.'));
      }, this.#options.timeoutMs);
      timer.unref();
    });
  }
}

class DesktopAgentHarnessHostTransport {
  #options;
  #sessions = new Map();
  #listeners = new Map();
  #identities = new Map();
  #capabilities = new Map();

  constructor(options = {}) {
    if (options.spawnEnvironment !== undefined) {
      throw new TypeError('Harness credentials must not be supplied through process environment.');
    }
    const providerEgressManifest = freezeProviderEgressManifest(options.providerEgressManifest);
    if ((providerEgressManifest === null) !== (typeof options.getAuthorization !== 'function')) {
      throw new TypeError(
        'Provider-only egress requires both a frozen manifest and getAuthorization callback.',
      );
    }
    if (
      options._providerForwardRequestForTest !== undefined &&
      process.env.NODE_TEST_CONTEXT === undefined
    ) {
      throw new TypeError('Provider forwarding substitution is test-only.');
    }
    this.#options = {
      approvedPath: process.env.PATH ?? '',
      adapterVersion: 'himmelcad-agent-adapter-v1',
      bwrapPath: '/usr/bin/bwrap',
      ...options,
      providerEgressManifest,
    };
  }

  registerWorkspaceCapability(capabilityId, directory) {
    if (!validIdentifier(capabilityId) || !isAbsolute(directory)) {
      throw new TypeError('Invalid harness workspace capability.');
    }
    this.#capabilities.set(capabilityId, resolve(directory));
  }

  revokeWorkspaceCapability(capabilityId) {
    this.#capabilities.delete(capabilityId);
  }

  async request(request) {
    switch (request.kind) {
      case 'discover':
        return await this.#discover(request);
      case 'openSession':
        return this.#openSession(request);
      case 'sendTurn':
        await this.#sendTurn(request);
        return { kind: 'accepted' };
      case 'interrupt':
        await this.#interrupt(request.sessionId);
        return { kind: 'accepted' };
      case 'resume':
        throw new Error('Resume is unavailable for a non-interactive exec session.');
      case 'approval':
        throw new Error('Provider approvals are unavailable in non-interactive exec mode.');
      case 'closeSession':
        await this.#closeSession(request.sessionId);
        return { kind: 'accepted' };
      default:
        throw new Error('Unknown harness host request.');
    }
  }

  subscribe(sessionId, onPayload) {
    if (!this.#sessions.has(sessionId)) throw new Error('Unknown harness session.');
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(onPayload);
    this.#listeners.set(sessionId, listeners);
    return () => listeners.delete(onPayload);
  }

  async close() {
    await this.invalidateSessions();
    this.#capabilities.clear();
  }

  async invalidateSessions() {
    await Promise.all([...this.#sessions.keys()].map((sessionId) => this.#closeSession(sessionId)));
    this.#identities.clear();
  }

  async #discover(request) {
    if (
      typeof this.#options.approvedPath !== 'string' ||
      this.#options.approvedPath.trim().length === 0
    ) {
      return { kind: 'notConfigured', detail: 'No agent runtime is configured.' };
    }
    const resolvedExecutable = await resolveApprovedExecutable(
      request.executableNames,
      this.#options.approvedPath,
    );
    if (!resolvedExecutable) {
      return { kind: 'missing', detail: `${request.provider} CLI is not installed.` };
    }
    const canonicalExecutableRoot = await realpath(resolvedExecutable.executableRoot);
    const executableRelativePath = relativeWithin(
      resolvedExecutable.canonicalPath,
      canonicalExecutableRoot,
      'Harness executable escaped its approved executable root.',
    );
    const probeArguments = await linuxProbeSandboxArguments({
      executableRoot: canonicalExecutableRoot,
      command: resolve('/harness', executableRelativePath.split(sep).join('/')),
      arguments: request.versionArgs,
    });
    const version = await captureProcess(
      this.#options.bwrapPath,
      probeArguments,
      request.timeoutMs,
      request.maxOutputBytes,
    );
    if (version.exitCode !== 0) {
      return { kind: 'incompatible', detail: `${request.provider} version probe failed.` };
    }
    const canonicalExecutableHash = await hashFile(resolvedExecutable.canonicalPath);
    const capabilities =
      request.provider === 'codex'
        ? ['codexExecJson']
        : request.provider === 'claude'
          ? ['claudeJson']
          : ['openCodeJson'];
    const executableId = randomBytes(24).toString('hex');
    if (
      request.provider === 'codex' &&
      (await providerAuthorizationAvailable(this.#options, executableId))
    ) {
      capabilities.push('providerOnly');
    }
    const identity = {
      provider: request.provider,
      executableId,
      canonicalExecutableHash,
      version: `${version.stdout}${version.stderr}`.trim().slice(0, 512),
      adapterVersion: this.#options.adapterVersion,
      capabilities,
    };
    this.#identities.set(executableId, {
      identity: Object.freeze({ ...identity, capabilities: Object.freeze([...capabilities]) }),
      executable: resolvedExecutable.canonicalPath,
      executableRoot: canonicalExecutableRoot,
    });
    return { kind: 'discovered', identity };
  }

  #openSession(request) {
    if (request.experimentalApi) {
      throw new Error('Experimental harness APIs are disabled by default.');
    }
    if (
      request.scope.network === 'providerOnly' &&
      (!request.identity.capabilities.includes('providerOnly') ||
        !this.#options.providerEgressManifest ||
        typeof this.#options.getAuthorization !== 'function')
    ) {
      throw new Error('Provider-only network egress is unavailable and fails closed.');
    }
    if (request.scope.filesystem !== 'readOnly') {
      throw new Error('Harness workspace writes require a separate product grant.');
    }
    if (!validToken(request.systemPrompt, 64 * 1024)) {
      throw new Error('Harness system prompt is empty or oversized.');
    }
    const discovered = this.#identities.get(request.identity.executableId);
    if (!discovered || !sameIdentity(discovered.identity, request.identity)) {
      throw new Error('Harness executable identity was not frozen by this host.');
    }
    const workspace = this.#capabilities.get(request.scope.workspaceCapabilityId);
    if (!workspace) throw new Error('Unknown harness workspace capability.');
    if (!isSupportedHarnessMode(request.identity.provider, request.mode)) {
      throw new Error('The selected harness transport mode is unavailable.');
    }
    if (!this.#options.runtimeRoot || !(this.#options.router instanceof AutomationRpcRouter)) {
      throw new Error('The private SDK transport is unavailable.');
    }
    const hostSessionId = randomBytes(24).toString('hex');
    const providerThreadId = randomBytes(24).toString('hex');
    this.#sessions.set(hostSessionId, {
      identity: discovered.identity,
      executable: discovered.executable,
      executableRoot: discovered.executableRoot,
      workspace,
      mode: request.mode,
      systemPrompt: request.systemPrompt,
      network: request.scope.network,
      providerThreadId,
      child: null,
      providerBroker: null,
      automationBridge: null,
    });
    return { kind: 'sessionOpened', hostSessionId, providerThreadId };
  }

  async #sendTurn(request) {
    const session = this.#sessions.get(request.sessionId);
    if (!session) throw new Error('Unknown harness session.');
    if (session.child) throw new Error('Harness turn is already active.');
    if (!validIdentifier(request.turnId) || !validToken(request.prompt, 256 * 1024)) {
      throw new Error('Harness turn identity or prompt is invalid.');
    }
    const executable = await realpath(session.executable);
    if ((await hashFile(executable)) !== session.identity.canonicalExecutableHash) {
      throw new Error('Harness executable identity changed after discovery.');
    }
    const canonicalWorkspace = await realpath(session.workspace);
    const runtime = await realpath(this.#options.runtimeRoot);
    const executableRoot = await realpath(session.executableRoot);
    const harnessPath = resolve(
      '/harness',
      relativeWithin(
        executable,
        executableRoot,
        'Harness executable escaped its frozen executable root.',
      )
        .split(sep)
        .join('/'),
    );
    const automationBridge = await createAutomationSocketBridge(this.#options.router);
    session.automationBridge = automationBridge;
    try {
      await writeHarnessSystemPrompt(automationBridge.directory, session.systemPrompt);
    } catch (error) {
      session.automationBridge = null;
      await automationBridge.close();
      throw error;
    }
    const invocation = harnessInvocation(session, request.prompt, harnessPath);
    let providerBroker = null;
    try {
      providerBroker =
        session.network === 'providerOnly'
          ? await createProviderBroker({
              manifest: this.#options.providerEgressManifest,
              getAuthorization: this.#options.getAuthorization,
              sessionId: request.sessionId,
              allowInsecureLoopbackForTest: this.#options.allowInsecureLoopbackForTest === true,
              forwardRequestForTest: this.#options._providerForwardRequestForTest,
            })
          : null;
    } catch (error) {
      session.automationBridge = null;
      await automationBridge.close();
      throw error;
    }
    session.providerBroker = providerBroker;
    const sandboxArguments = await linuxSandboxArguments({
      runtime,
      workspace: canonicalWorkspace,
      filesystem: 'readOnly',
      extraReadOnlyMounts: [
        { source: executableRoot, target: '/harness' },
        { source: automationBridge.directory, target: '/automation-bridge' },
        ...(providerBroker
          ? [{ source: providerBroker.directory, target: '/provider-broker' }]
          : []),
      ],
      environment: {
        PATH: '/runtime/python/bin:/harness/bin:/usr/bin:/bin',
        HOME: '/home/agent',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        HIMMELCAD_AUTOMATION_RPC_FD: '3',
        HIMMELCAD_AUTOMATION_RPC_SOCKET: '/automation-bridge/automation.sock',
        ...invocation.environment,
      },
      command: providerBroker ? '/runtime/python/bin/python3' : harnessPath,
      arguments: providerBroker
        ? [
            '-I',
            '-B',
            '-c',
            PROVIDER_RELAY_SUPERVISOR,
            '/provider-broker/provider.sock',
            String(PROVIDER_RELAY_PORT),
            harnessPath,
            ...invocation.arguments,
          ]
        : invocation.arguments,
    });
    let child;
    try {
      child = spawn(this.#options.bwrapPath, sandboxArguments, {
        cwd: '/',
        detached: true,
        env: {},
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      session.providerBroker = null;
      session.automationBridge = null;
      await Promise.all([providerBroker?.close(), automationBridge.close()]);
      throw error;
    }
    session.child = child;
    attachRpcBridge(child.stdio[3], this.#options.router, MAX_RPC_MESSAGE_BYTES, (error) => {
      this.#emit(request.sessionId, { type: 'error', message: error.message });
      void terminateProcessGroup(child);
    });
    this.#emit(request.sessionId, {
      type: 'turn.started',
      thread_id: session.providerThreadId,
      turn_id: request.turnId,
    });
    let buffered = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderr = Buffer.alloc(0);
    let protocolError = null;
    const consumeLine = (line) => {
      if (!line.trim() || protocolError) return;
      try {
        const payload = JSON.parse(line);
        if (!isRecord(payload)) throw new Error('Harness event must be a JSON object.');
        this.#emit(request.sessionId, payload);
      } catch {
        protocolError = new Error(`Invalid ${session.identity.provider} JSON event.`);
        this.#emit(request.sessionId, { type: 'error', message: protocolError.message });
        void terminateProcessGroup(child);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes + stderrBytes > MAX_PROCESS_OUTPUT_BYTES) {
        void terminateProcessGroup(child);
        this.#emit(request.sessionId, { type: 'error', message: 'Harness output limit exceeded.' });
        return;
      }
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        consumeLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > MAX_PROCESS_OUTPUT_BYTES) void terminateProcessGroup(child);
      if (stderr.length < 32 * 1024) {
        stderr = Buffer.concat([stderr, chunk.subarray(0, 32 * 1024 - stderr.length)]);
      }
    });
    child.once('error', (error) => {
      session.child = null;
      const broker = session.providerBroker;
      session.providerBroker = null;
      const bridge = session.automationBridge;
      session.automationBridge = null;
      void Promise.all([broker?.close(), bridge?.close()]);
      this.#emit(request.sessionId, { type: 'error', message: String(error.message) });
      this.#emit(request.sessionId, {
        type: 'turn.failed',
        thread_id: session.providerThreadId,
        turn_id: request.turnId,
        exit_code: null,
        message: String(error.message).slice(0, 8_192),
      });
    });
    child.once('exit', (exitCode) => {
      consumeLine(buffered);
      session.child = null;
      const broker = session.providerBroker;
      session.providerBroker = null;
      const bridge = session.automationBridge;
      session.automationBridge = null;
      void Promise.all([broker?.close(), bridge?.close()]);
      this.#emit(request.sessionId, {
        type: exitCode === 0 && !protocolError ? 'turn.completed' : 'turn.failed',
        thread_id: session.providerThreadId,
        turn_id: request.turnId,
        exit_code: exitCode,
        message: (protocolError?.message || stderr.toString('utf8')).slice(0, 8_192),
      });
    });
    child.stdin.end(invocation.stdin);
  }

  async #interrupt(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error('Unknown harness session.');
    if (session.child) await terminateProcessGroup(session.child);
    const broker = session.providerBroker;
    session.providerBroker = null;
    const bridge = session.automationBridge;
    session.automationBridge = null;
    await Promise.all([broker?.close(), bridge?.close()]);
  }

  async #closeSession(sessionId) {
    if (!this.#sessions.has(sessionId)) return;
    await this.#interrupt(sessionId);
    this.#sessions.delete(sessionId);
    this.#listeners.delete(sessionId);
  }

  #emit(sessionId, payload) {
    for (const listener of this.#listeners.get(sessionId) ?? []) {
      try {
        listener(payload);
      } catch {
        // A renderer listener cannot disrupt host process ownership.
      }
    }
  }
}

function validateRpcRequest(message) {
  if (
    !isRecord(message) ||
    !Number.isSafeInteger(message.id) ||
    message.id < 0 ||
    typeof message.method !== 'string' ||
    message.method.length === 0 ||
    message.method.length > 128 ||
    !isRecord(message.params)
  ) {
    throw protocolFailure('invalidRequest', 'Malformed automation RPC request.');
  }
  return message;
}

function normalizeAutomationError(error) {
  const candidate = error?.data ?? error;
  if (isRecord(candidate) && typeof candidate.code === 'string') {
    return {
      code: candidate.code,
      message:
        typeof candidate.message === 'string' ? candidate.message : 'HimmelCAD request failed.',
      retryable: candidate.retryable === true,
      details: isRecord(candidate.details) ? candidate.details : {},
    };
  }
  if (error instanceof Error) {
    const matched = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/su.exec(error.message);
    if (matched && ERROR_CODES.has(matched[1])) {
      return {
        code: matched[1],
        message: matched[2] || 'HimmelCAD request failed.',
        retryable: false,
        details: {},
      };
    }
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : 'HimmelCAD request failed.',
    retryable: false,
    details: {},
  };
}

const ERROR_CODES = new Set([
  'protocolMismatch',
  'missingCapability',
  'invalidRequest',
  'invalidCursor',
  'generationChanged',
  'pageLimitExceeded',
  'byteLimitExceeded',
  'conflict',
  'lossAcceptanceRequired',
  'confirmationRequired',
  'operationNotFound',
  'cancelled',
  'leaseExpired',
  'leaseRevoked',
  'leaseRangeInvalid',
  'leaseBudgetExhausted',
  'hashMismatch',
  'permissionDenied',
  'internal',
]);

function normalizeScreenshotResult(connection, result) {
  if (!isRecord(result)) {
    throw protocolFailure('invalidRequest', 'Renderer screenshot response is malformed.');
  }
  if (result.encoding === 'base64') {
    if (
      typeof result.data !== 'string' ||
      result.data.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(result.data) ||
      Buffer.from(result.data, 'base64').length > MAX_SCREENSHOT_BYTES
    ) {
      throw protocolFailure('invalidRequest', 'Renderer screenshot base64 payload is invalid.');
    }
    const bytes = Buffer.from(result.data, 'base64');
    if (bytes.length <= MAX_INLINE_BYTES) return result;
    const leaseId = randomBytes(24).toString('hex');
    const accessToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 5 * 60_000;
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const lease = {
      leaseId,
      accessToken,
      contentHash,
      mediaType: result.mimeType,
      elementType: 'bytes',
      shape: [bytes.length],
      endianness: 'notApplicable',
      byteLength: bytes.length,
      expiresAt: new Date(expiresAt).toISOString(),
      maxReadableRange: MAX_BULK_RANGE_BYTES,
      remainingReadBudget: bytes.length,
      readOnly: true,
    };
    connection.leases.set(leaseId, {
      accessToken,
      bytes,
      expiresAt,
      remainingReadBudget: bytes.length,
    });
    const { data: _data, ...base } = result;
    return { ...base, encoding: 'bulkLease', lease };
  } else if (result.encoding !== 'bulkLease') {
    throw protocolFailure('invalidRequest', 'Renderer screenshot encoding is invalid.');
  }
  return result;
}

function localLease(connection, params) {
  return isRecord(params) && typeof params.leaseId === 'string'
    ? connection.leases.get(params.leaseId)
    : undefined;
}

function readLocalLease(connection, params) {
  const lease = connection.leases.get(params.leaseId);
  if (
    !lease ||
    !validToken(params.accessToken, 4_096) ||
    !timingSafeStringEqual(params.accessToken, lease.accessToken)
  ) {
    throw protocolFailure('leaseRevoked', 'Screenshot lease is unavailable.');
  }
  if (Date.now() >= lease.expiresAt) {
    connection.leases.delete(params.leaseId);
    throw protocolFailure('leaseExpired', 'Screenshot lease expired.');
  }
  if (
    !Number.isSafeInteger(params.offset) ||
    !Number.isSafeInteger(params.length) ||
    params.offset < 0 ||
    params.length <= 0 ||
    params.length > MAX_BULK_RANGE_BYTES ||
    params.offset + params.length > lease.bytes.length
  ) {
    throw protocolFailure('leaseRangeInvalid', 'Screenshot lease range is invalid.');
  }
  if (params.length > lease.remainingReadBudget) {
    throw protocolFailure('leaseBudgetExhausted', 'Screenshot lease read budget is exhausted.');
  }
  lease.remainingReadBudget -= params.length;
  return {
    leaseId: params.leaseId,
    offset: params.offset,
    byteLength: params.length,
    encoding: 'base64',
    data: lease.bytes.subarray(params.offset, params.offset + params.length).toString('base64'),
    remainingReadBudget: lease.remainingReadBudget,
  };
}

function releaseLocalLease(connection, params) {
  const lease = connection.leases.get(params.leaseId);
  const released =
    !!lease &&
    validToken(params.accessToken, 4_096) &&
    timingSafeStringEqual(params.accessToken, lease.accessToken);
  if (released) connection.leases.delete(params.leaseId);
  return { leaseId: params.leaseId, released };
}

function timingSafeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function protocolFailure(code, message, details = {}) {
  const error = new Error(message);
  error.data = { code, message, retryable: false, details };
  return error;
}

function confirmationGrant(extensions) {
  const extension = isRecord(extensions) ? extensions['hcad.automation.confirmation@1'] : undefined;
  return isRecord(extension) && validToken(extension.grant, 4_096) ? extension.grant : undefined;
}

async function resolveApprovedExecutable(names, approvedPath) {
  if (typeof approvedPath !== 'string' || approvedPath.trim().length === 0) return null;
  const directories = approvedPath.split(delimiter).filter((directory) => isAbsolute(directory));
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name)) continue;
    for (const directory of directories) {
      const candidate = resolve(directory, process.platform === 'win32' ? `${name}.exe` : name);
      try {
        const canonical = await realpath(candidate);
        const metadata = await stat(canonical);
        await access(canonical, constants.X_OK);
        if (metadata.isFile()) {
          return {
            canonicalPath: canonical,
            executableRoot: resolve(directory, '..'),
          };
        }
      } catch (error) {
        if (!['ENOENT', 'EACCES'].includes(error?.code)) throw error;
      }
    }
  }
  return null;
}

async function linuxSandboxArguments(options) {
  if (process.platform !== 'linux') {
    throw protocolFailure(
      'permissionDenied',
      'This platform has no audited automation sandbox backend.',
    );
  }
  const arguments_ = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--clearenv',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/usr',
    '--dir',
    '/home',
    '--dir',
    '/home/agent',
    '--dir',
    '/workspace',
    '--ro-bind',
    options.runtime,
    '/runtime',
    options.filesystem === 'readWrite' ? '--bind' : '--ro-bind',
    options.workspace,
    '/workspace',
    '--chdir',
    '/workspace',
  ];
  for (const directory of ['/usr/bin', '/usr/lib', '/lib', '/lib64']) {
    try {
      const canonical = await realpath(directory);
      arguments_.push('--ro-bind', canonical, directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  for (const mount of options.extraReadOnlyMounts ?? []) {
    arguments_.push('--ro-bind', mount.source, mount.target);
  }
  for (const [name, value] of Object.entries(options.environment)) {
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) ||
      typeof value !== 'string' ||
      value.length > 64 * 1024
    ) {
      throw protocolFailure('invalidRequest', 'Sandbox environment entry is invalid.');
    }
    arguments_.push('--setenv', name, value);
  }
  arguments_.push(options.command, ...options.arguments);
  return arguments_;
}

async function linuxProbeSandboxArguments(options) {
  if (process.platform !== 'linux') {
    throw protocolFailure(
      'permissionDenied',
      'This platform has no audited harness discovery sandbox backend.',
    );
  }
  const arguments_ = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--clearenv',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/usr',
    '--dir',
    '/home',
    '--dir',
    '/home/agent',
    '--ro-bind',
    options.executableRoot,
    '/harness',
    '--chdir',
    '/home/agent',
  ];
  for (const directory of ['/usr/bin', '/usr/lib', '/lib', '/lib64']) {
    try {
      const canonical = await realpath(directory);
      arguments_.push('--ro-bind', canonical, directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  arguments_.push(
    '--setenv',
    'PATH',
    '/harness/bin:/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/home/agent',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--setenv',
    'LC_ALL',
    'C.UTF-8',
    options.command,
    ...options.arguments,
  );
  return arguments_;
}

function isSupportedHarnessMode(provider, mode) {
  return (
    (provider === 'codex' && mode === 'codexExecJson') ||
    (provider === 'claude' && mode === 'claudeJson') ||
    (provider === 'opencode' && mode === 'openCodeJson')
  );
}

async function writeHarnessSystemPrompt(directory, systemPrompt) {
  const path = resolve(directory, 'system-prompt.md');
  await writeFile(path, systemPrompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
}

function harnessInvocation(session, prompt, executable) {
  switch (session.identity.provider) {
    case 'codex':
      return {
        arguments: [
          'exec',
          '--json',
          '--ephemeral',
          '--ignore-user-config',
          '--skip-git-repo-check',
          '-s',
          // The outer bwrap boundary enforces the declared filesystem and
          // network scope. Codex's nested seccomp sandbox would also deny the
          // private AF_UNIX SDK capability required by tool subprocesses.
          'danger-full-access',
          '-C',
          '/workspace',
          '-c',
          `developer_instructions=${JSON.stringify(session.systemPrompt)}`,
          ...(session.network === 'providerOnly'
            ? codexProviderArguments(PROVIDER_RELAY_PORT)
            : []),
          '-',
        ],
        environment: {},
        stdin: prompt,
      };
    case 'claude':
      return {
        arguments: [
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
        ],
        environment: {
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        stdin: prompt,
      };
    case 'opencode':
      return {
        arguments: [
          '--pure',
          'run',
          '--format',
          'json',
          '--dir',
          '/workspace',
          '--agent',
          'himmelcad',
        ],
        environment: openCodeEnvironment(),
        stdin: prompt,
      };
    default:
      throw protocolFailure('invalidRequest', `Unsupported harness executable: ${executable}`);
  }
}

function openCodeEnvironment() {
  const permission = {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    bash: 'allow',
    edit: 'deny',
    task: 'deny',
    external_directory: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    question: 'deny',
    doom_loop: 'deny',
  };
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false,
      agent: {
        himmelcad: {
          description: 'HimmelCAD private SDK automation agent',
          mode: 'primary',
          prompt: '{file:/automation-bridge/system-prompt.md}',
          permission,
        },
      },
    }),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_PRUNE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
  };
}

function codexProviderArguments(port) {
  return [
    '-c',
    'model_provider="himmelcad_provider"',
    '-c',
    'model_providers.himmelcad_provider.name="HimmelCAD Provider Broker"',
    '-c',
    `model_providers.himmelcad_provider.base_url="http://127.0.0.1:${port}/v1"`,
    '-c',
    'model_providers.himmelcad_provider.wire_api="responses"',
    '-c',
    'model_providers.himmelcad_provider.requires_openai_auth=false',
    '-c',
    'model_providers.himmelcad_provider.supports_websockets=false',
  ];
}

function freezeProviderEgressManifest(value) {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    value.provider !== 'codex' ||
    value.redirects !== 'deny' ||
    value.websockets !== 'deny' ||
    !Array.isArray(value.requests) ||
    value.requests.length !== 1 ||
    !isRecord(value.requests[0]) ||
    value.requests[0].method !== 'POST' ||
    value.requests[0].path !== '/v1/responses'
  ) {
    throw new TypeError('Provider egress manifest is not the audited Codex Responses contract.');
  }
  const origin = new URL(value.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new TypeError('Provider egress origin must be an exact credential-free HTTPS origin.');
  }
  return Object.freeze({
    provider: 'codex',
    origin: origin.origin,
    requests: Object.freeze([Object.freeze({ method: 'POST', path: '/v1/responses' })]),
    redirects: 'deny',
    websockets: 'deny',
  });
}

async function providerAuthorizationAvailable(options, sessionId) {
  if (
    !options.providerEgressManifest ||
    typeof options.getAuthorization !== 'function' ||
    typeof options.authorizationAvailable !== 'function'
  ) {
    return false;
  }
  try {
    return (
      (await options.authorizationAvailable({
        provider: options.providerEgressManifest.provider,
        origin: options.providerEgressManifest.origin,
        sessionId,
        signal: AbortSignal.timeout(2_000),
      })) === true
    );
  } catch {
    return false;
  }
}

async function acquireProviderAuthorization(getAuthorization, manifest, sessionId, signal) {
  let value = await getAuthorization({
    provider: manifest.provider,
    origin: manifest.origin,
    sessionId,
    signal,
  });
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
    throw new Error('Provider authorization callback returned an invalid value.');
  }
  let authorization;
  if (Buffer.isBuffer(value)) {
    try {
      authorization = value.toString('utf8');
    } finally {
      value.fill(0);
    }
  } else {
    authorization = value;
  }
  value = null;
  if (!validToken(authorization, 16 * 1024) || !/^[\x20-\x7e]+$/u.test(authorization)) {
    throw new Error('Provider authorization is empty, oversized, or contains unsafe bytes.');
  }
  return authorization;
}

async function createAutomationSocketBridge(router) {
  const directory = await mkdtemp(resolve(tmpdir(), 'hcad-automation-bridge-'));
  const socketPath = resolve(directory, 'automation.sock');
  const sockets = new Set();
  const server = createNetServer((socket) => {
    if (sockets.size >= 8) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    attachRpcBridge(socket, router, MAX_RPC_MESSAGE_BYTES, () => socket.destroy());
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return {
    directory,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function createProviderBroker(options) {
  const resolvedOrigin = options.forwardRequestForTest
    ? null
    : await resolveProviderOrigin(options.manifest.origin);
  const directory = await mkdtemp(resolve(tmpdir(), 'hcad-provider-broker-'));
  const socketPath = resolve(directory, 'provider.sock');
  const abortController = new AbortController();
  let activeRequests = 0;
  const server = createHttpServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    if (activeRequests >= PROVIDER_MAX_ACTIVE_REQUESTS) {
      drainAndReply(request, response, 429, 'Provider broker concurrency limit exceeded.');
      return;
    }
    activeRequests += 1;
    void handleProviderRequest(
      request,
      response,
      { ...options, resolvedOrigin },
      abortController.signal,
    ).finally(() => {
      activeRequests -= 1;
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 4;
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return {
    directory,
    async close() {
      if (closed) return;
      closed = true;
      abortController.abort();
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function handleProviderRequest(request, response, options, signal) {
  try {
    if (
      request.method !== options.manifest.requests[0].method ||
      request.url !== options.manifest.requests[0].path ||
      request.headers.upgrade !== undefined ||
      request.headers['transfer-encoding'] !== undefined ||
      request.headers.authorization !== undefined ||
      request.headers.cookie !== undefined ||
      request.headers['proxy-authorization'] !== undefined ||
      rawHeaderCount(request, 'content-length') !== 1 ||
      rawHeaderCount(request, 'content-type') !== 1
    ) {
      drainAndReply(request, response, 403, 'Provider request is outside the egress manifest.');
      return;
    }
    const declaredLength = Number(request.headers['content-length']);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 2 ||
      declaredLength > PROVIDER_REQUEST_MAX_BYTES ||
      !String(request.headers['content-type'] ?? '')
        .toLowerCase()
        .startsWith('application/json')
    ) {
      drainAndReply(request, response, 400, 'Provider request body is invalid.');
      return;
    }
    const body = await readBoundedRequest(request, declaredLength, signal);
    const parsed = JSON.parse(body.toString('utf8'));
    if (!isRecord(parsed)) throw new Error('Provider request JSON must be an object.');
    let authorization = await acquireProviderAuthorization(
      options.getAuthorization,
      options.manifest,
      options.sessionId,
      signal,
    );
    if (authorization === null) {
      replyText(response, 503, 'Provider authorization is unavailable.');
      return;
    }
    await (options.forwardRequestForTest ?? forwardProviderRequest)({
      manifest: options.manifest,
      body,
      authorization,
      accept: request.headers.accept,
      response,
      signal,
      allowInsecureLoopbackForTest: options.allowInsecureLoopbackForTest,
      resolvedOrigin: options.resolvedOrigin,
    });
    authorization = null;
  } catch (error) {
    if (!response.headersSent) {
      replyText(
        response,
        signal.aborted ? 503 : 502,
        signal.aborted ? 'Provider broker closed.' : 'Provider request failed.',
      );
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }
}

async function readBoundedRequest(request, declaredLength, signal) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw new Error('Provider broker closed.');
    bytes += chunk.length;
    if (bytes > declaredLength || bytes > PROVIDER_REQUEST_MAX_BYTES) {
      throw new Error('Provider request exceeded its declared length.');
    }
    chunks.push(chunk);
  }
  if (bytes !== declaredLength) throw new Error('Provider request length does not match its body.');
  return Buffer.concat(chunks, bytes);
}

async function forwardProviderRequest(options) {
  const upstreamUrl = new URL(options.manifest.requests[0].path, options.manifest.origin);
  await new Promise((resolveForward, rejectForward) => {
    const upstream = httpsRequest(
      upstreamUrl,
      {
        method: 'POST',
        headers: {
          accept: validHttpHeader(options.accept) ? options.accept : 'application/json',
          authorization: options.authorization,
          'content-length': String(options.body.length),
          'content-type': 'application/json',
        },
        rejectUnauthorized: !(
          options.allowInsecureLoopbackForTest &&
          ['127.0.0.1', '::1'].includes(upstreamUrl.hostname)
        ),
        lookup: options.resolvedOrigin
          ? (_hostname, _lookupOptions, callback) =>
              callback(null, options.resolvedOrigin.address, options.resolvedOrigin.family)
          : undefined,
        signal: options.signal,
      },
      (upstreamResponse) => {
        const statusCode = upstreamResponse.statusCode ?? 502;
        if (statusCode >= 300 && statusCode < 400) {
          upstreamResponse.resume();
          replyText(options.response, 502, 'Provider redirects are denied.');
          resolveForward();
          return;
        }
        const headers = {};
        for (const name of ['content-type', 'x-request-id']) {
          if (validHttpHeader(upstreamResponse.headers[name])) {
            headers[name] = upstreamResponse.headers[name];
          }
        }
        options.response.writeHead(statusCode, headers);
        let responseBytes = 0;
        upstreamResponse.on('data', (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > PROVIDER_RESPONSE_MAX_BYTES) {
            upstream.destroy(new Error('Provider response exceeded its byte limit.'));
            return;
          }
          options.response.write(chunk);
        });
        upstreamResponse.once('end', () => {
          options.response.end();
          resolveForward();
        });
        upstreamResponse.once('error', rejectForward);
      },
    );
    upstream.setTimeout(DEFAULT_TIMEOUT_MS, () =>
      upstream.destroy(new Error('Provider request timed out.')),
    );
    upstream.once('error', rejectForward);
    upstream.end(options.body);
  });
}

function validHttpHeader(value) {
  return typeof value === 'string' && value.length <= 8_192 && !/[\0\r\n]/u.test(value);
}

function rawHeaderCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count;
}

async function resolveProviderOrigin(origin) {
  const url = new URL(origin);
  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await dnsLookup(url.hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((candidate) => !publicProviderAddress(candidate.address, candidate.family))
  ) {
    throw new Error('Provider origin resolved to a denied or unavailable network range.');
  }
  return Object.freeze({ address: addresses[0].address, family: addresses[0].family });
}

function publicProviderAddress(address, family) {
  if (family === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;
    const [a, b, c] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 168 && b === 63 && c === 129 && octets[3] === 16) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family !== 6) return false;
  const words = ipv6Words(address);
  if (!words) return false;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return publicProviderAddress(
      `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`,
      4,
    );
  }
  return !(
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
    (words[0] & 0xfe00) === 0xfc00 ||
    (words[0] & 0xffc0) === 0xfe80 ||
    (words[0] & 0xffc0) === 0xfec0 ||
    (words[0] & 0xff00) === 0xff00 ||
    (words[0] === 0x2001 && words[1] === 0x0db8) ||
    (words[0] === 0x2001 && words[1] === 0x0002) ||
    (words[0] === 0x0064 && words[1] === 0xff9b) ||
    (words[0] === 0x2001 && words[1] === 0x0000) ||
    words[0] === 0x2002 ||
    (words[0] === 0x0100 && words.slice(1).every((word) => word === 0))
  );
}

function ipv6Words(address) {
  const normalized = address.toLowerCase().split('%')[0];
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const values = half.split(':');
    const last = values.at(-1);
    if (last?.includes('.')) {
      const octets = last.split('.').map(Number);
      if (
        octets.length !== 4 ||
        octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
      ) {
        return null;
      }
      values.splice(-1, 1, ((octets[0] << 8) | octets[1]).toString(16));
      values.push(((octets[2] << 8) | octets[3]).toString(16));
    }
    if (values.some((value) => !/^[0-9a-f]{1,4}$/u.test(value))) return null;
    return values.map((value) => Number.parseInt(value, 16));
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function drainAndReply(request, response, statusCode, message) {
  request.resume();
  replyText(response, statusCode, message);
}

function replyText(response, statusCode, message) {
  if (response.headersSent) return;
  const body = Buffer.from(message);
  response.writeHead(statusCode, {
    'content-length': String(body.length),
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

function attachRpcBridge(stream, router, maximumBytes, onError) {
  const connectionId = router.openConnection();
  let buffer = Buffer.alloc(0);
  let sequence = Promise.resolve();
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maximumBytes) {
      onError(protocolFailure('invalidRequest', 'Automation RPC frame is oversized.'));
      return;
    }
    let newline;
    while ((newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      sequence = sequence
        .then(async () => {
          let request;
          try {
            request = JSON.parse(line.toString('utf8'));
          } catch {
            throw protocolFailure('invalidRequest', 'Automation RPC is not valid JSON.');
          }
          const response = await router.handle(request, connectionId);
          const encoded = Buffer.from(`${JSON.stringify(response)}\n`);
          if (encoded.length > maximumBytes) {
            throw protocolFailure('internal', 'Automation RPC response is oversized.');
          }
          await new Promise((resolveWrite, rejectWrite) =>
            stream.write(encoded, (error) => (error ? rejectWrite(error) : resolveWrite())),
          );
        })
        .catch(onError);
    }
  });
  stream.on('error', onError);
  stream.once('close', () => router.closeConnection(connectionId));
}

async function terminateProcessGroup(child, graceMilliseconds = 750) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  signalProcessGroup(child.pid, 'SIGTERM');
  if (await waitForExit(child, graceMilliseconds)) return;
  signalProcessGroup(child.pid, 'SIGKILL');
  await waitForExit(child, 2_000);
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolveWait) => {
    const done = () => {
      clearTimeout(timer);
      resolveWait(true);
    };
    child.once('exit', done);
    const timer = setTimeout(() => {
      child.off('exit', done);
      resolveWait(false);
    }, timeoutMilliseconds);
    timer.unref();
  });
}

function sameIdentity(left, right) {
  return (
    left.provider === right.provider &&
    left.executableId === right.executableId &&
    left.canonicalExecutableHash === right.canonicalExecutableHash &&
    left.version === right.version &&
    left.adapterVersion === right.adapterVersion &&
    JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities) &&
    JSON.stringify(left.appServerSchema) === JSON.stringify(right.appServerSchema)
  );
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function captureProcess(command, args, timeoutMs, maxOutputBytes) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      detached: true,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let terminalError = null;
    const append = (current, chunk) => {
      if (stdout.length + stderr.length + chunk.length > maxOutputBytes) {
        throw new Error('Harness probe output exceeded its limit.');
      }
      return Buffer.concat([current, chunk]);
    };
    const failAndReap = (error) => {
      if (terminalError) return;
      terminalError = error;
      void terminateProcessGroup(child);
    };
    child.stdout.on('data', (chunk) => {
      try {
        stdout = append(stdout, chunk);
      } catch (error) {
        failAndReap(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        stderr = append(stderr, chunk);
      } catch (error) {
        failAndReap(error);
      }
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminalError) reject(terminalError);
      else resolvePromise({ exitCode, stdout: stdout.toString(), stderr: stderr.toString() });
    });
    const timer = setTimeout(
      () => failAndReap(protocolFailure('cancelled', 'Harness version probe timed out.')),
      timeoutMs,
    );
    timer.unref();
  });
}

function stableHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(sortJson(value)))
    .digest('hex');
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function isWithin(path, parent) {
  const difference = relative(parent, path);
  return (
    difference !== '' &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function relativeWithin(path, parent, message) {
  const difference = relative(parent, path);
  if (
    difference === '' ||
    difference === '..' ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error(message);
  }
  return difference;
}

function validIdentifier(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)
  );
}

function validToken(value, maximum) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\0\r\n]/u.test(value)
  );
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function newConnectionState() {
  return {
    hostSessionId: randomBytes(24).toString('hex'),
    negotiated: false,
    plans: new Map(),
    grants: new Map(),
    leases: new Map(),
  };
}

module.exports = {
  AutomationRpcRouter,
  DesktopAgentHarnessHostTransport,
  ManagedPythonHost,
  normalizeAutomationError,
};

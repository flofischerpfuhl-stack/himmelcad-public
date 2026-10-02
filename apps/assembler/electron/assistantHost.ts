/**
 * The embedded assistant's harness host (assembler/AGENT-ASSISTANT.md
 * "Desktop host"): implements the `@himmelcad/agent` host transport
 * (`discover`, `openSession`, `sendTurn`, `interrupt`, `closeSession`,
 * `subscribe`) for HimmelCAD Assembler by running the user's own Claude
 * Code, Codex or OpenCode CLI — installed and signed in by the user, with
 * their own subscription — as a child process per turn.
 *
 * Why not Builder's `@himmelcad/automation-host`: that host routes tool
 * calls to Builder's sidecar protocol and refuses to run anywhere but Linux
 * (bubblewrap sandbox). Assembler's tools are the `hcasm.agent-api@1`
 * contract answered in the renderer, and its users are on Windows first.
 *
 * Trust model (documented in AGENT-ASSISTANT.md):
 *
 * - The CLI runs with the user's rights, like in their own terminal, in a
 *   private working folder per thread (`userData/assistant/threads/<id>`),
 *   never in the user's project folder.
 * - Its tools are restricted to the app's MCP server (Claude: no built-in
 *   tools, only `mcp__hcasm`; Codex: read-only sandbox, no user config;
 *   OpenCode: every built-in tool denied). The MCP server reaches the app
 *   through a loopback endpoint with a per-turn token (`assistantTools.ts`);
 *   the renderer's command layer validates every call and asks the user
 *   before destructive steps — no tool can answer that question.
 * - Network: the CLI talks to its own provider (the user's subscription);
 *   the app sends nothing anywhere.
 *
 * Pure Node (no Electron import), so it is tested with a scripted harness.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

/** Must equal `ADAPTER_VERSION` in `@himmelcad/agent` `drivers.ts`. */
export const ADAPTER_VERSION = 'himmelcad-agent-adapter-v1';

export type Provider = 'codex' | 'claude' | 'opencode';

const PROVIDERS: readonly Provider[] = ['codex', 'claude', 'opencode'];
const CAPABILITY: Record<Provider, string> = {
  codex: 'codexExecJson',
  claude: 'claudeJson',
  opencode: 'openCodeJson',
};
const MODE: Record<Provider, string> = {
  codex: 'codexExecJson',
  claude: 'claudeJson',
  opencode: 'openCodeJson',
};

/** Node-based CLIs start slowly on Windows; the shared driver's 2 s is raised to this. */
const MIN_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_TURN_OUTPUT_BYTES = 32 * 1024 * 1024;
/** One turn may run this long before the host stops it. */
export const MAX_TURN_MS = 30 * 60_000;
const MAX_PROMPT_CHARS = 256 * 1024;

export interface Identity {
  provider: Provider;
  executableId: string;
  canonicalExecutableHash: string;
  version: string;
  adapterVersion: string;
  capabilities: readonly string[];
}

/** How to start a CLI: the executable plus fixed leading arguments (an npm shim's script). */
export interface Launch {
  command: string;
  prefixArgs: readonly string[];
  /** The file whose hash identifies the CLI. */
  identityFile: string;
  /** Extra environment for the child (the scripted test harness runs on Electron's Node). */
  env?: Readonly<Record<string, string>>;
}

export interface ToolEndpoint {
  url: string;
  /** Issues a token for a running turn of `threadId`. */
  issue(threadId: string): string;
  revoke(token: string): void;
}

export interface AssistantHostOptions {
  /** `userData/assistant`: thread folders and the resume bindings. */
  dataDir: string;
  tools: ToolEndpoint;
  /** Runs the MCP server script (`process.execPath` with ELECTRON_RUN_AS_NODE). */
  nodeCommand: string;
  mcpServerScript: string;
  /** Test only: a scripted harness that stands in for `claude` (no provider is ever called). */
  testHarness?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

interface Session {
  hostSessionId: string;
  threadId: string;
  identity: Identity;
  launch: Launch;
  workspace: string;
  systemPrompt: string;
  nativeId: string | null;
  child: ChildProcess | null;
  token: string | null;
  interrupted: boolean;
}

interface Binding {
  provider: Provider;
  nativeId: string | null;
  workspace: string;
}

type Listener = (payload: unknown) => void;

export class AssistantHarnessHost {
  readonly #options: AssistantHostOptions;
  readonly #identities = new Map<string, { identity: Identity; launch: Launch }>();
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Map<string, Set<Listener>>();
  #bindings: Record<string, Binding> | null = null;

  constructor(options: AssistantHostOptions) {
    this.#options = options;
  }

  async request(raw: unknown): Promise<unknown> {
    const request = record(raw);
    if (!request) throw new Error('Invalid assistant host request.');
    switch (request.kind) {
      case 'discover':
        return this.#discover(request);
      case 'openSession':
        return this.#openSession(request);
      case 'sendTurn':
        await this.#sendTurn(request);
        return { kind: 'accepted' };
      case 'interrupt':
        await this.#interrupt(str(request.sessionId));
        return { kind: 'accepted' };
      case 'closeSession':
        await this.#closeSession(str(request.sessionId));
        return { kind: 'accepted' };
      case 'resume':
        throw new Error('Continue with a new message in the same session.');
      case 'approval':
        throw new Error('The app asks for destructive steps itself; CLI approvals are not used.');
      default:
        throw new Error('Unknown assistant host request.');
    }
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    if (!this.#sessions.has(sessionId)) throw new Error('Unknown assistant session.');
    const set = this.#listeners.get(sessionId) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(sessionId, set);
    return () => set.delete(listener);
  }

  /** Stops every running CLI (window closed, app quit). */
  async close(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.#closeSession(id)));
  }

  // ---- discovery ------------------------------------------------------------------------

  async #discover(request: Record<string, unknown>): Promise<unknown> {
    const provider = request.provider as Provider;
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider.');
    const names = Array.isArray(request.executableNames)
      ? request.executableNames.filter(
          (n): n is string => typeof n === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(n),
        )
      : [];
    const versionArgs = Array.isArray(request.versionArgs)
      ? request.versionArgs.filter((a): a is string => typeof a === 'string').slice(0, 4)
      : ['--version'];
    const timeoutMs = Math.max(MIN_DISCOVERY_TIMEOUT_MS, Number(request.timeoutMs) || 0);
    let launch: Launch | null;
    if (this.#options.testHarness) {
      launch =
        provider === 'claude'
          ? {
              command: this.#options.nodeCommand,
              prefixArgs: [this.#options.testHarness],
              identityFile: this.#options.testHarness,
              env: { ELECTRON_RUN_AS_NODE: '1' },
            }
          : null;
    } else {
      launch = await resolveLaunch(names, this.#env(), this.#platform());
    }
    if (!launch)
      return { kind: 'missing', detail: `${displayName(provider)} CLI is not installed.` };
    const probe = await captureProcess(
      launch,
      versionArgs,
      timeoutMs,
      this.#env(),
      this.#platform(),
    );
    if (probe.exitCode !== 0) {
      return {
        kind: 'incompatible',
        detail: `${displayName(provider)} --version failed${probe.timedOut ? ' (timed out)' : ''}.`,
      };
    }
    const identity: Identity = {
      provider,
      executableId: randomBytes(24).toString('hex'),
      canonicalExecutableHash: await hashFile(launch.identityFile),
      version: `${probe.stdout}${probe.stderr}`.trim().split('\n')[0]!.slice(0, 200) || 'unknown',
      adapterVersion: ADAPTER_VERSION,
      capabilities: [CAPABILITY[provider]],
    };
    this.#identities.set(identity.executableId, { identity, launch });
    return { kind: 'discovered', identity };
  }

  // ---- sessions -------------------------------------------------------------------------

  async #openSession(request: Record<string, unknown>): Promise<unknown> {
    const identity = record(request.identity);
    const known = identity ? this.#identities.get(str(identity.executableId)) : undefined;
    if (
      !identity ||
      !known ||
      known.identity.canonicalExecutableHash !== identity.canonicalExecutableHash
    ) {
      throw new Error('The agent CLI was not found by this app session; refresh the list.');
    }
    if (request.mode !== MODE[known.identity.provider])
      throw new Error('Unsupported harness mode.');
    const systemPrompt = typeof request.systemPrompt === 'string' ? request.systemPrompt : '';
    if (!systemPrompt.trim() || systemPrompt.length > 64 * 1024) {
      throw new Error('The system prompt is empty or too long.');
    }
    const bindings = await this.#loadBindings();
    const resumeId = typeof request.resumeThreadId === 'string' ? request.resumeThreadId : null;
    const previous = resumeId ? bindings[resumeId] : undefined;
    const reuse = Boolean(
      resumeId &&
      previous &&
      previous.provider === known.identity.provider &&
      /^[0-9a-f]{48}$/u.test(resumeId),
    );
    const threadId = reuse ? resumeId! : randomBytes(24).toString('hex');
    if ([...this.#sessions.values()].some((s) => s.threadId === threadId)) {
      throw new Error('This conversation is already open.');
    }
    const workspace = join(this.#options.dataDir, 'threads', threadId);
    await fs.mkdir(workspace, { recursive: true });
    const hostSessionId = randomBytes(24).toString('hex');
    this.#sessions.set(hostSessionId, {
      hostSessionId,
      threadId,
      identity: known.identity,
      launch: known.launch,
      workspace,
      systemPrompt,
      nativeId: reuse ? (previous?.nativeId ?? null) : null,
      child: null,
      token: null,
      interrupted: false,
    });
    if (!reuse)
      await this.#saveBinding(threadId, {
        provider: known.identity.provider,
        nativeId: null,
        workspace,
      });
    return { kind: 'sessionOpened', hostSessionId, providerThreadId: threadId };
  }

  async #sendTurn(request: Record<string, unknown>): Promise<void> {
    const session = this.#sessions.get(str(request.sessionId));
    if (!session) throw new Error('Unknown assistant session.');
    if (session.child) throw new Error('A turn of this session is already running.');
    const prompt = typeof request.prompt === 'string' ? request.prompt : '';
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS)
      throw new Error('The message is empty or too long.');
    const turnId = str(request.turnId) || randomUUID();
    if (
      (await hashFile(session.launch.identityFile)) !== session.identity.canonicalExecutableHash
    ) {
      throw new Error('The agent CLI changed since it was found; refresh the list.');
    }
    const token = this.#options.tools.issue(session.threadId);
    session.token = token;
    session.interrupted = false;
    const mcpConfigPath = join(session.workspace, 'hcasm-mcp.json');
    const mcpEnv = {
      ELECTRON_RUN_AS_NODE: '1',
      HCASM_TOOL_URL: this.#options.tools.url,
      HCASM_TOOL_TOKEN: token,
    };
    await fs.writeFile(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          hcasm: {
            type: 'stdio',
            command: this.#options.nodeCommand,
            args: [this.#options.mcpServerScript],
            env: mcpEnv,
          },
        },
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    // Claude takes the id of a new conversation from us; it is kept once the CLI reports it.
    const newClaudeId =
      session.identity.provider === 'claude' && !session.nativeId ? randomUUID() : null;
    const invocation = harnessArguments(
      session,
      mcpConfigPath,
      {
        command: this.#options.nodeCommand,
        script: this.#options.mcpServerScript,
        env: mcpEnv,
      },
      newClaudeId,
    );
    const env: NodeJS.ProcessEnv = {
      ...this.#env(),
      ...(session.launch.env ?? {}),
      ...invocation.env,
    };
    const child = spawn(
      session.launch.command,
      [...session.launch.prefixArgs, ...invocation.args],
      {
        cwd: session.workspace,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: this.#platform() !== 'win32',
      },
    );
    session.child = child;
    this.#emit(session.hostSessionId, { type: 'turn.started', turn_id: turnId });
    let buffered = '';
    let bytes = 0;
    let stderr = '';
    const limit = setTimeout(() => {
      this.#emit(session.hostSessionId, {
        type: 'error',
        code: 'turnTimeLimit',
        message: 'The turn ran longer than 30 minutes and was stopped.',
      });
      void killTree(child, this.#platform());
    }, MAX_TURN_MS);
    limit.unref?.();
    const consume = (line: string) => {
      const text = line.trim();
      if (!text.startsWith('{')) return; // banners and warnings are not protocol
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return;
      }
      void this.#learnNativeId(session, payload);
      this.#emit(session.hostSessionId, payload);
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_TURN_OUTPUT_BYTES) {
        this.#emit(session.hostSessionId, {
          type: 'error',
          code: 'outputLimit',
          message: 'The agent CLI wrote too much output and was stopped.',
        });
        void killTree(child, this.#platform());
        return;
      }
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        consume(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8 * 1024);
    });
    const finish = (exitCode: number | null, error?: Error) => {
      clearTimeout(limit);
      if (session.child !== child) return;
      consume(buffered);
      buffered = '';
      session.child = null;
      if (session.token) this.#options.tools.revoke(session.token);
      session.token = null;
      const detail = (error?.message ?? stderr.trim().split('\n').slice(-6).join('\n')).slice(
        0,
        4000,
      );
      const type = session.interrupted
        ? 'turn.interrupted'
        : exitCode === 0 && !error
          ? 'turn.completed'
          : 'turn.failed';
      this.#emit(session.hostSessionId, {
        type,
        turn_id: turnId,
        exit_code: exitCode,
        ...(type === 'turn.failed' && detail ? { detail } : {}),
      });
    };
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(prompt);
  }

  async #interrupt(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error('Unknown assistant session.');
    if (!session.child) return;
    session.interrupted = true;
    await killTree(session.child, this.#platform());
  }

  async #closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    if (session.child) {
      session.interrupted = true;
      await killTree(session.child, this.#platform());
    }
    if (session.token) this.#options.tools.revoke(session.token);
    this.#sessions.delete(sessionId);
    this.#listeners.delete(sessionId);
  }

  /** The CLI's own session id, for continuing the conversation in the next turn. */
  async #learnNativeId(session: Session, payload: unknown): Promise<void> {
    const value = record(payload);
    if (!value) return;
    let id: string | null = null;
    if (session.identity.provider === 'claude' && value.type === 'system')
      id = str(value.session_id);
    if (session.identity.provider === 'codex' && value.type === 'thread.started')
      id = str(value.thread_id);
    if (session.identity.provider === 'opencode') {
      id =
        str(value.sessionID) ||
        str(record(value.part)?.sessionID) ||
        str(record(value.properties)?.sessionID);
    }
    if (!id || id === session.nativeId || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) return;
    session.nativeId = id;
    await this.#saveBinding(session.threadId, {
      provider: session.identity.provider,
      nativeId: id,
      workspace: session.workspace,
    });
  }

  #emit(sessionId: string, payload: unknown): void {
    for (const listener of this.#listeners.get(sessionId) ?? []) {
      try {
        listener(payload);
      } catch {
        // A renderer listener never breaks process ownership.
      }
    }
  }

  // ---- resume bindings (local only, never in a project file) -----------------------------

  async #loadBindings(): Promise<Record<string, Binding>> {
    if (this.#bindings) return this.#bindings;
    try {
      const parsed = JSON.parse(
        await fs.readFile(join(this.#options.dataDir, 'threads.json'), 'utf8'),
      ) as unknown;
      this.#bindings = record(parsed) ? (parsed as Record<string, Binding>) : {};
    } catch {
      this.#bindings = {};
    }
    return this.#bindings;
  }

  async #saveBinding(threadId: string, binding: Binding): Promise<void> {
    const bindings = await this.#loadBindings();
    bindings[threadId] = binding;
    const entries = Object.entries(bindings);
    // Keep the newest 200 conversations.
    if (entries.length > 200) this.#bindings = Object.fromEntries(entries.slice(-200));
    await fs.mkdir(this.#options.dataDir, { recursive: true });
    const path = join(this.#options.dataDir, 'threads.json');
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.#bindings), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, path);
  }

  #env(): NodeJS.ProcessEnv {
    return this.#options.env ?? process.env;
  }

  #platform(): NodeJS.Platform {
    return this.#options.platform ?? process.platform;
  }
}

// ---- CLI invocations ----------------------------------------------------------------------

/** The arguments of one turn per CLI (the prompt goes to stdin). Exported for tests. */
export function harnessArguments(
  session: Pick<Session, 'identity' | 'nativeId' | 'systemPrompt' | 'workspace'>,
  mcpConfigPath: string,
  mcp: { command: string; script: string; env: Readonly<Record<string, string>> },
  newClaudeId: string | null = null,
): { args: string[]; env: Record<string, string> } {
  switch (session.identity.provider) {
    case 'claude': {
      const native = session.nativeId;
      return {
        args: [
          '-p',
          '--verbose',
          '--output-format',
          'stream-json',
          '--input-format',
          'text',
          '--permission-mode',
          'dontAsk',
          '--tools',
          '',
          '--allowedTools',
          'mcp__hcasm',
          '--strict-mcp-config',
          '--mcp-config',
          mcpConfigPath,
          '--append-system-prompt',
          session.systemPrompt,
          ...(native ? ['--resume', native] : newClaudeId ? ['--session-id', newClaudeId] : []),
        ],
        env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      };
    }
    case 'codex': {
      const toml = (value: string) => JSON.stringify(value);
      const options = [
        '--json',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '-s',
        'read-only',
        '-C',
        session.workspace,
        '-c',
        'approval_policy="never"',
        '-c',
        `developer_instructions=${toml(session.systemPrompt)}`,
        '-c',
        `mcp_servers.hcasm.command=${toml(mcp.command)}`,
        '-c',
        `mcp_servers.hcasm.args=[${toml(mcp.script)}]`,
        ...Object.entries(mcp.env).flatMap(([key, value]) => [
          '-c',
          `mcp_servers.hcasm.env.${key}=${toml(value)}`,
        ]),
      ];
      return {
        args: ['exec', ...options, ...(session.nativeId ? ['resume', session.nativeId] : []), '-'],
        env: {},
      };
    }
    case 'opencode': {
      const permission = {
        '*': 'deny',
        bash: 'deny',
        edit: 'deny',
        read: 'deny',
        glob: 'deny',
        grep: 'deny',
        list: 'deny',
        task: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
        external_directory: 'deny',
        'hcasm_*': 'allow',
      };
      return {
        args: [
          'run',
          '--format',
          'json',
          '--agent',
          'himmelcad',
          ...(session.nativeId ? ['--session', session.nativeId] : []),
        ],
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            autoupdate: false,
            mcp: {
              hcasm: {
                type: 'local',
                command: [mcp.command, mcp.script],
                environment: mcp.env,
                enabled: true,
              },
            },
            agent: {
              himmelcad: {
                description: 'HimmelCAD Assembler modeling assistant',
                mode: 'primary',
                prompt: session.systemPrompt,
                permission,
              },
            },
          }),
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
          OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
          OPENCODE_DISABLE_CLAUDE_CODE: 'true',
        },
      };
    }
  }
}

// ---- executable resolution ----------------------------------------------------------------

/**
 * Finds a CLI on `PATH`. Windows: `<name>.exe`, or an npm `<name>.cmd` shim,
 * which is resolved to the executable or Node script it starts (never run
 * through `cmd.exe`, so arguments and the prompt are not shell-parsed).
 */
export async function resolveLaunch(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<Launch | null> {
  const pathValue = env.PATH ?? env.Path ?? '';
  const directories = pathValue
    .split(platform === 'win32' ? ';' : delimiter)
    .filter((d) => d && isAbsolute(d));
  for (const name of names) {
    for (const directory of directories) {
      if (platform === 'win32') {
        const exe = join(directory, `${name}.exe`);
        if (await isFile(exe)) return { command: exe, prefixArgs: [], identityFile: exe };
        const shim = join(directory, `${name}.cmd`);
        if (await isFile(shim)) {
          const launch = await launchFromCmdShim(shim, env, platform);
          if (launch) return launch;
        }
      } else {
        const file = join(directory, name);
        if (await isExecutable(file)) {
          const real = await fs.realpath(file);
          return { command: real, prefixArgs: [], identityFile: real };
        }
      }
    }
  }
  return null;
}

/** Reads what an npm `.cmd` shim starts: `"%dp0%\…\x.exe"` or `node "%dp0%\…\x.js"`. */
export async function launchFromCmdShim(
  shim: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<Launch | null> {
  let text: string;
  try {
    text = await fs.readFile(shim, 'utf8');
  } catch {
    return null;
  }
  const targets = [...text.matchAll(/"%(?:~)?dp0%\\?([^"%]+\.(?:exe|js|cjs|mjs))"/giu)].map(
    (m) => m[1]!,
  );
  const target = targets.at(-1);
  if (!target) return null;
  const file = resolve(dirname(shim), target.replace(/\\/g, '/'));
  if (!(await isFile(file))) return null;
  if (extname(file).toLowerCase() === '.exe')
    return { command: file, prefixArgs: [], identityFile: file };
  const localNode = join(dirname(shim), 'node.exe');
  const node = (await isFile(localNode)) ? localNode : await findOnPath('node', env, platform);
  if (!node) return null;
  return { command: node, prefixArgs: [file], identityFile: file };
}

async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const directory of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, platform === 'win32' ? `${name}.exe` : name);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await fs.access(path, constants.X_OK);
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(path))
    .digest('hex');
}

function captureProcess(
  launch: Launch,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(launch.command, [...launch.prefixArgs, ...args], {
        env: { ...env, ...(launch.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32',
      });
    } catch (error) {
      resolvePromise({ exitCode: null, stdout: '', stderr: String(error), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child, platform);
    }, timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/** Stops a CLI and everything it started (its MCP server, shells). */
export function killTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      resolvePromise();
      return;
    }
    const done = () => resolvePromise();
    child.once('close', done);
    setTimeout(done, 5_000).unref?.();
    try {
      if (platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        }).once('error', () => child.kill());
      } else {
        process.kill(-child.pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            // already gone
          }
        }, 2_000).unref?.();
      }
    } catch {
      child.kill();
    }
  });
}

function displayName(provider: Provider): string {
  return provider === 'claude' ? 'Claude Code' : provider === 'codex' ? 'Codex' : 'OpenCode';
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

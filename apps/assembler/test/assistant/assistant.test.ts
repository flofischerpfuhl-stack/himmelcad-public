/**
 * The embedded assistant without a UI or a CLI (assembler/AGENT-ASSISTANT.md):
 * the controller on the real store, command layer and OCCT kernel with a
 * fake harness — a turn's tool calls become ordinary History steps, the
 * whole turn is one undo step, deleting pre-existing work waits for the
 * user's approval, sessions are stored sanitized and travel in the project
 * file; the MCP tools and skills behave as documented.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

import type { NormalizedAgentEvent } from '@himmelcad/agent/src/events.js';
import type { HarnessExecutableIdentity } from '@himmelcad/agent/src/transport.js';
import type { AgentHarnessAdapter } from '@himmelcad/agent/src/vendor/t3code/providerShape.js';

import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/foundation/document/format.js';
import {
  collectProjectSections,
  loadProjectSections,
} from '../../renderer/src/foundation/document/projectSections.js';
import type { HostAssistant } from '../../renderer/src/foundation/host/host.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { AgentSession, APP_CAPABILITIES } from '../../renderer/src/interface/agent-api/session.js';
import {
  attachAssistantRuntime,
  classifyForTurn,
  composePrompt,
  configureAssistant,
  eventsFromStored,
  resetAssistantForTests,
  storedFromEvents,
  useAssistant,
} from '../../renderer/src/interface/assistant/controller.js';
import { buildAssistantPrompt } from '../../renderer/src/interface/assistant/prompt.js';
import { useAssistantSessions } from '../../renderer/src/interface/assistant/sessions.js';
import {
  BUILTIN_SKILLS,
  parseSkill,
  readSkillPage,
  skillTemplate,
  useProjectSkills,
} from '../../renderer/src/interface/assistant/skills.js';
import {
  ASSISTANT_TOOLS,
  callAssistantTool,
  handleMcpMessage,
  methodIndex,
  type McpToolResult,
} from '../../renderer/src/interface/assistant/tools.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

type Json = Record<string, unknown>;

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));
const session = new AgentSession({
  store,
  kernel,
  host: { server: 'app', capabilities: APP_CAPABILITIES },
});

const identity: HarnessExecutableIdentity = {
  provider: 'claude',
  executableId: 'exe-1',
  canonicalExecutableHash: 'a'.repeat(64),
  version: 'fake 1.0',
  adapterVersion: 'himmelcad-agent-adapter-v1',
  capabilities: ['claudeJson'],
};

/** A harness whose turns are driven by the test: tool calls and lifecycle events. */
class FakeHarness {
  emit: (event: NormalizedAgentEvent) => void = () => undefined;
  prompts: string[] = [];
  resumed: (string | undefined)[] = [];
  interrupted = 0;
  sequence = 0;
  toolListener:
    | ((id: string, request: { threadId: string; name: string; arguments: unknown }) => void)
    | null = null;
  responses = new Map<string, unknown>();
  waiters = new Map<string, (value: unknown) => void>();

  readonly bridge: HostAssistant = {
    harness: { request: async () => ({ kind: 'accepted' }), subscribe: () => () => undefined },
    onToolRequest: (listener) => {
      this.toolListener = listener;
      return () => {
        this.toolListener = null;
      };
    },
    respondTool: async (id, result) => {
      this.responses.set(id, result);
      this.waiters.get(id)?.(result);
    },
  };

  adapter(): AgentHarnessAdapter {
    return {
      identity,
      mode: 'claudeJson',
      diagnostics: null as never,
      events: null as never,
      startThread: async (input) => {
        this.resumed.push(input.resumeThreadId);
        return { threadId: input.resumeThreadId ?? 'f'.repeat(48) };
      },
      sendTurn: async (input) => {
        this.prompts.push(input.prompt);
      },
      interrupt: async () => {
        this.interrupted += 1;
        this.lifecycle('interrupted');
      },
      resume: async () => undefined,
      respondToApproval: async () => undefined,
      stop: async () => undefined,
      subscribe: (_threadId, listener) => {
        this.emit = listener;
        return () => undefined;
      },
    };
  }

  /** One MCP tool call of the running turn; resolves with the tool result. */
  call(name: string, args: Json, threadId = 'f'.repeat(48)): Promise<McpToolResult> {
    const id = `call-${(this.sequence += 1)}`;
    return new Promise((resolvePromise) => {
      this.waiters.set(id, (value) => resolvePromise(value as McpToolResult));
      this.toolListener!(id, { threadId, name, arguments: args });
    });
  }

  lifecycle(state: 'completed' | 'interrupted' | 'failed'): void {
    this.emit({
      schemaVersion: 1,
      id: `state-${(this.sequence += 1)}`,
      sequence: this.sequence,
      provider: 'claude',
      threadId: 'f'.repeat(48),
      createdAt: new Date().toISOString(),
      kind: 'turnState',
      state,
    });
  }

  say(text: string): void {
    this.emit({
      schemaVersion: 1,
      id: `msg-${(this.sequence += 1)}`,
      sequence: this.sequence,
      provider: 'claude',
      threadId: 'f'.repeat(48),
      createdAt: new Date().toISOString(),
      kind: 'message',
      messageId: `m${this.sequence}`,
      role: 'assistant',
      text,
      streaming: false,
    });
  }
}

function textOf(result: McpToolResult): Json {
  const block = result.content.find((c) => c.type === 'text');
  assert.ok(block && block.type === 'text', 'text content');
  return JSON.parse(block.text) as Json;
}

async function setup(): Promise<FakeHarness> {
  resetAssistantForTests();
  store.getState().loadDocument([], { projectName: 'Assistant test' });
  await store.getState().whenSettled();
  const harness = new FakeHarness();
  configureAssistant(
    {
      discover: async () => [{ state: 'available', identity }],
      create: () => harness.adapter(),
      redact: (text) => text.replace(/token=\S+/gu, 'token=[REDACTED]'),
    },
    harness.bridge,
    '',
  );
  attachAssistantRuntime({
    session,
    store,
    subscribeStore: (listener) =>
      store.subscribe((state, previous) => {
        if (
          state.features !== previous.features ||
          state.parameters !== previous.parameters ||
          state.checks !== previous.checks
        )
          listener();
      }),
  });
  await useAssistant.getState().refresh();
  assert.equal(useAssistant.getState().provider, 'claude');
  return harness;
}

const plate = (name: string, x: number) => ({
  method: 'feature.create',
  params: {
    kind: 'sketch',
    name,
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [{ kind: 'rectangle', x, y: 0, width: 20, height: 10 }],
    },
  },
});

void test('a turn: tool calls become History steps, the turn is one undo step, the transcript is stored', async () => {
  const harness = await setup();
  await useAssistant.getState().send('Make two plates token=secret-1');
  assert.equal(useAssistant.getState().busy, true);
  assert.match(harness.prompts[0]!, /two plates/);

  const listed = await harness.call('skills_list', {});
  assert.equal(listed.isError, undefined);
  const sketch = textOf(await harness.call('hcasm_call', plate('A', 0)));
  const extrude = textOf(
    await harness.call('hcasm_call', {
      method: 'feature.create',
      params: {
        kind: 'extrude',
        params: { profile: { kind: 'sketch', featureId: sketch.featureId }, distance: 4 },
      },
    }),
  );
  assert.equal(extrude.committed, true);
  await harness.call('hcasm_call', plate('B', 40));
  assert.equal(store.getState().features.length, 3);

  const render = await harness.call('view_render', { width: 128, height: 96 });
  assert.equal(render.isError, undefined);
  assert.ok(
    render.content.some((c) => c.type === 'image'),
    'the render is image content',
  );

  harness.say('Done token=secret-2');
  harness.lifecycle('completed');
  assert.equal(useAssistant.getState().busy, false);

  // One undo returns to the empty document; redo brings all three steps back.
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, 0);
  store.getState().redo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, 3);

  const sessions = useAssistantSessions.getState().sessions;
  assert.equal(sessions.length, 1);
  const stored = sessions[0]!;
  assert.equal(stored.state, 'idle');
  assert.equal(stored.threadId, 'f'.repeat(48));
  const text = JSON.stringify(stored.events);
  assert.match(text, /one undo step/);
  assert.equal(
    text.includes('secret-1') || text.includes('secret-2'),
    false,
    'tokens are redacted',
  );
  assert.equal(eventsFromStored(stored).length, stored.events.length);

  // The session and project skills travel in the .hcasm file.
  useProjectSkills.getState().save(skillTemplate('team-rules'));
  const sections = await collectProjectSections();
  const file = saveProjectFile({
    appVersion: 'test',
    createdAt: '2026-10-02T00:00:00.000Z',
    projectName: 'Assistant test',
    features: store.getState().features,
    parameters: store.getState().parameters,
    ...sections.fields,
  });
  const reopened = loadProjectFile(file);
  assert.equal(reopened.assistantSessions?.length, 1);
  assert.equal(reopened.assistantSkills?.length, 1);
  useAssistantSessions.getState().replaceAll([]);
  useProjectSkills.getState().replaceAll([]);
  loadProjectSections(reopened);
  assert.equal(useAssistantSessions.getState().sessions[0]?.id, stored.id);
  assert.equal(useProjectSkills.getState().skills[0]?.id, 'team-rules');
});

void test('a turn that also stores a check is one undo step; a check edit counts as a step', async () => {
  const harness = await setup();
  await useAssistant.getState().send('Make a plate and keep it under 1 cm³');
  textOf(await harness.call('hcasm_call', plate('Plate', 0)));
  const added = textOf(
    await harness.call('hcasm_call', {
      method: 'checks.add',
      params: { kind: 'bodyCount', params: { max: 3 }, name: 'At most 3 bodies' },
    }),
  );
  assert.equal((added.check as Json).displayName, 'At most 3 bodies');
  assert.equal(store.getState().checks.length, 1);
  // A query in between is no step.
  const run = textOf(await harness.call('hcasm_call', { method: 'checks.run', params: {} }));
  assert.equal(run.passed, true);
  harness.lifecycle('completed');

  // One undo removes both the sketch and the check; redo brings both back.
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, 0);
  assert.equal(store.getState().checks.length, 0);
  assert.equal(store.getState().history.canUndo, false, 'nothing else to undo');
  store.getState().redo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, 1);
  assert.equal(store.getState().checks.length, 1);
  store.getState().commitChecks([]);
});
void test('the next turn continues the same provider thread', async () => {
  const harness = await setup();
  await useAssistant.getState().send('first');
  harness.lifecycle('completed');
  await useAssistant.getState().send('second');
  harness.lifecycle('completed');
  // One thread for both turns: started once.
  assert.deepEqual(harness.resumed, [undefined]);
  // A new controller (an app restart) resumes the stored thread.
  const sessionId = useAssistantSessions.getState().activeId!;
  const sessions = useAssistantSessions.getState().sessions;
  const restarted = await setup();
  useAssistantSessions.getState().replaceAll(sessions);
  useAssistant.getState().selectSession(sessionId);
  await useAssistant.getState().send('third');
  assert.deepEqual(restarted.resumed, ['f'.repeat(48)]);
  restarted.lifecycle('completed');
});

void test('deleting a step that existed before the turn waits for the user; denied changes nothing', async () => {
  const harness = await setup();
  await useAssistant.getState().send('make a plate');
  const sketch = textOf(await harness.call('hcasm_call', plate('Mine', 0)));
  harness.lifecycle('completed');

  await useAssistant.getState().send('clean up');
  const pending = harness.call('hcasm_call', {
    method: 'feature.delete',
    params: { featureId: sketch.featureId },
  });
  await new Promise((r) => setTimeout(r, 20));
  const approval = useAssistant
    .getState()
    .live.find((event) => event.kind === 'approval' && event.state === 'pending');
  assert.ok(approval && approval.kind === 'approval', 'a pending approval is shown');
  assert.match(approval.title, /Delete the step “Mine”/);
  assert.equal(useAssistant.getState().respondApproval(approval.requestId, 'denied'), true);
  const denied = await pending;
  assert.equal(denied.isError, true);
  assert.equal(textOf(denied).code, 'permissionDenied');
  assert.equal(store.getState().features.length, 1, 'nothing was deleted');

  // A step the agent made in this turn can go without asking.
  const own = textOf(await harness.call('hcasm_call', plate('Temp', 50)));
  const removed = await harness.call('hcasm_call', {
    method: 'feature.delete',
    params: { featureId: own.featureId },
  });
  assert.equal(removed.isError, undefined);

  // Approved: the delete runs.
  const second = harness.call('hcasm_call', {
    method: 'feature.delete',
    params: { featureId: sketch.featureId },
  });
  await new Promise((r) => setTimeout(r, 20));
  const again = [...useAssistant.getState().live]
    .reverse()
    .find((event) => event.kind === 'approval' && event.state === 'pending');
  assert.ok(again && again.kind === 'approval');
  useAssistant.getState().respondApproval(again.requestId, 'approved');
  assert.equal((await second).isError, undefined);
  assert.equal(store.getState().features.length, 0);
  harness.lifecycle('completed');
});

void test('interrupt ends the turn and marks the session interrupted; tool calls after it are refused', async () => {
  const harness = await setup();
  await useAssistant.getState().send('make something big');
  await useAssistant.getState().interrupt();
  assert.equal(harness.interrupted, 1);
  assert.equal(useAssistant.getState().busy, false);
  assert.equal(useAssistantSessions.getState().sessions[0]?.state, 'interrupted');
  const late = await harness.call('hcasm_call', plate('Late', 0));
  assert.equal(late.isError, true);
  assert.equal(store.getState().features.length, 0);
});

void test('references: selection chips resolve to ids at send time', async () => {
  const harness = await setup();
  await useAssistant.getState().send('make a plate');
  const sketch = textOf(await harness.call('hcasm_call', plate('Ref', 0)));
  harness.lifecycle('completed');
  store.getState().select({ kind: 'feature', featureId: String(sketch.featureId) });
  useAssistant.getState().addSelection();
  const references = useAssistant.getState().references;
  assert.equal(references.length, 1);
  assert.match(references[0]!.label, /Step “Ref”/);
  const composed = composePrompt('make it bigger', references, {
    getState: () => store.getState(),
  });
  assert.match(composed.prompt, /featureId/);
  assert.match(composed.display, /@ Step “Ref”/);
  await useAssistant.getState().send('make it bigger');
  assert.match(harness.prompts.at(-1)!, /References the user selected/);
  assert.equal(useAssistant.getState().references.length, 0);
  harness.lifecycle('completed');
});

void test('approval rules: only work from before the turn, project replacement and undo past the turn', () => {
  const turn = { preexisting: new Set(['f1']), preexistingParameters: new Set(['p1']), steps: 0 };
  const state = {
    features: [{ id: 'f1', name: 'Base' }] as never,
    parameters: [{ id: 'p1', name: 'wall', unit: 'mm', value: 2 }] as never,
  };
  assert.ok(classifyForTurn(turn, 'feature.delete', { featureId: 'f1' }, state));
  assert.equal(classifyForTurn(turn, 'feature.delete', { featureId: 'new' }, state), null);
  assert.match(
    classifyForTurn(turn, 'parameter.delete', { parameterId: 'p1' }, state)!.title,
    /wall/,
  );
  assert.ok(classifyForTurn(turn, 'project.new', {}, state));
  assert.ok(classifyForTurn(turn, 'project.open', { text: '' }, state));
  assert.ok(classifyForTurn(turn, 'history.undo', {}, state));
  assert.equal(classifyForTurn({ ...turn, steps: 2 }, 'history.undo', {}, state), null);
  assert.equal(classifyForTurn(turn, 'feature.edit', { featureId: 'f1' }, state), null);
  // Stored checks (checks module): removing the user's check asks, one the turn added does not.
  const withChecks = { ...turn, preexistingChecks: new Set(['c1']) };
  const checkState = {
    ...state,
    checks: [
      { id: 'c1', kind: 'clearance', name: 'Lid gap', params: { min: 0.3 } },
      { id: 'c2', kind: 'volume', params: { min: 1 } },
    ] as never,
  };
  assert.match(
    classifyForTurn(withChecks, 'checks.remove', { checkId: 'c1' }, checkState)!.title,
    /Lid gap/,
  );
  assert.ok(classifyForTurn(withChecks, 'checks.remove', { checkId: 'Lid gap' }, checkState));
  assert.equal(classifyForTurn(withChecks, 'checks.remove', { checkId: 'c2' }, checkState), null);
  assert.equal(classifyForTurn(withChecks, 'checks.update', { checkId: 'c1' }, checkState), null);
});

void test('stored transcripts keep messages, tools and approvals, not reasoning', () => {
  const base = {
    schemaVersion: 1 as const,
    provider: 'claude' as const,
    threadId: 't',
    createdAt: '2026-10-02T00:00:00.000Z',
  };
  const events: NormalizedAgentEvent[] = [
    {
      ...base,
      id: '1',
      sequence: 1,
      kind: 'message',
      messageId: 'u',
      role: 'user',
      text: 'hi',
      streaming: false,
    },
    {
      ...base,
      id: '2',
      sequence: 2,
      kind: 'reasoning',
      reasoningId: 'r',
      summary: 'hidden',
      streaming: false,
    },
    {
      ...base,
      id: '3',
      sequence: 3,
      kind: 'command',
      operationId: 'c',
      command: 'hcasm_call',
      state: 'running',
    },
    {
      ...base,
      id: '4',
      sequence: 4,
      kind: 'command',
      operationId: 'c',
      command: 'hcasm_call',
      state: 'completed',
      outputPreview: 'ok',
    },
    { ...base, id: '5', sequence: 5, kind: 'usage', inputTokens: 3 },
  ];
  const stored = storedFromEvents(events, (t) => t);
  assert.deepEqual(
    stored.map((e) => e.kind),
    ['message', 'command'],
  );
  assert.equal(stored[1]!.kind === 'command' && stored[1]!.state, 'completed');
});

void test('tools: methods index, kind lookup, errors as results, MCP framing', async () => {
  assert.match(methodIndex(), /view\.render/);
  assert.match(methodIndex(), /skills\.read/);
  const host = { session };
  const kind = await callAssistantTool(host, 'hcasm_methods', { kind: 'extrude' });
  assert.match(JSON.stringify(kind.content), /distance/);
  const unknown = await callAssistantTool(host, 'hcasm_call', { method: 'nope.nothing' });
  assert.equal(unknown.isError, true);
  assert.equal(textOf(unknown).code, 'methodNotFound');
  const page = await callAssistantTool(host, 'skills_read', { id: 'printable-part' });
  assert.match(JSON.stringify(page.content), /acceptance rules/);

  const init = await handleMcpMessage(
    host,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { name: 't', version: '1' },
  );
  assert.equal((init?.result as Json).protocolVersion, '2025-03-26');
  const list = await handleMcpMessage(
    host,
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { name: 't', version: '1' },
  );
  assert.equal(((list?.result as Json).tools as unknown[]).length, ASSISTANT_TOOLS.length);
  assert.equal(
    await handleMcpMessage(
      host,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { name: 't', version: '1' },
    ),
    null,
  );
});

void test('skills: built-ins parse, the file format is closed, reads are paged, the generated file is current', () => {
  assert.deepEqual(
    BUILTIN_SKILLS.map((s) => s.id),
    ['api-quickstart', 'fix-printability', 'parametric-part', 'printable-part'],
  );
  for (const skill of BUILTIN_SKILLS) assert.equal(skill.scope, 'built-in');
  const ok = parseSkill(skillTemplate('x-y'), 'project');
  assert.equal(ok.ok, true);
  const unknownField = parseSkill(
    skillTemplate().replace('version: 1', 'version: 1\nshell: rm'),
    'project',
  );
  assert.equal(unknownField.ok, false);
  const wrongScope = parseSkill(skillTemplate(), 'built-in');
  assert.equal(wrongScope.ok, false);
  assert.throws(
    () => useProjectSkills.getState().save(skillTemplate('printable-part')),
    /built-in/,
  );
  const skill = BUILTIN_SKILLS.find((s) => s.id === 'printable-part')!;
  const first = readSkillPage(skill, 0, 500);
  assert.equal(first.text.length, 500);
  assert.equal(first.nextOffset, 500);
  // Tests run in apps/assembler (the package script's working directory).
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'generate-skills.mjs'), '--check'],
    {
      stdio: 'pipe',
    },
  );
});

void test('the system prompt names the tools and rules, not the model', () => {
  const prompt = buildAssistantPrompt(store.getState());
  assert.match(prompt, /hcasm_call/);
  assert.match(prompt, /view_render/);
  assert.match(prompt, /printable-part/);
  assert.ok(prompt.length < 8 * 1024);
});

/**
 * The assistant timeline for product users: human labels for tool calls,
 * consecutive calls folded into groups, lifecycle noise left out, failures
 * and approvals kept.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentTimelineRow } from '@himmelcad/agent/src/timeline.js';

import {
  foldToolRows,
  groupSummary,
  parseToolCommand,
  toolLabel,
  type CommandRow,
} from '../../renderer/src/interface/assistant/timelineRows.js';

const at = '2026-10-02T00:00:00.000Z';
let n = 0;
const command = (cmd: string, state = 'completed', detail?: string): CommandRow => ({
  id: `c${(n += 1)}`,
  kind: 'command',
  sequence: n,
  operationId: `op${n}`,
  command: cmd,
  state,
  ...(detail ? { detail } : {}),
  createdAt: at,
});
const message = (text: string): AgentTimelineRow => ({
  id: `m${(n += 1)}`,
  kind: 'message',
  sequence: n,
  role: 'assistant',
  text,
  streaming: false,
  createdAt: at,
});
const state = (value: string): AgentTimelineRow => ({
  id: `s${(n += 1)}`,
  kind: 'state',
  sequence: n,
  state: value,
  createdAt: at,
});

void test('tool commands of every CLI become human labels', () => {
  assert.deepEqual(parseToolCommand('hcasm_call · feature.create'), {
    tool: 'hcasm_call',
    arg: 'feature.create',
  });
  assert.deepEqual(parseToolCommand('hcasm.view_render · iso'), {
    tool: 'view_render',
    arg: 'iso',
  });
  assert.equal(toolLabel(command('hcasm_call · print.analyze')).text, 'Checked printability');
  assert.equal(
    toolLabel(command('hcasm_call · print.analyze', 'running')).text,
    'Checking printability…',
  );
  assert.equal(
    toolLabel(
      command(
        'hcasm_call · feature.create',
        'completed',
        '{"featureId":"f-1","name":"Plate sketch","kind":"sketch"}',
      ),
    ).text,
    'Added “Plate sketch”',
  );
  assert.equal(toolLabel(command('view_render · iso')).text, 'Rendered the iso view');
  assert.equal(
    toolLabel(command('skills_read · printable-part')).text,
    'Read the skill “printable-part”',
  );
  assert.equal(toolLabel(command('hcasm_call · sketch.setDimension')).text, 'Edited a sketch');
  assert.equal(toolLabel(command('Bash')).text, 'Bash');
});

void test('failures keep their message, also when the CLI reports the call as completed', () => {
  const failed = toolLabel(
    command(
      'hcasm_call · feature.delete',
      'completed',
      '{"code":"permissionDenied","message":"The user did not approve: Delete the step"}',
    ),
  );
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'The user did not approve: Delete the step');
  assert.equal(toolLabel(command('view_render', 'failed', 'boom')).error, 'boom');
});

void test('consecutive tool calls fold into one group; noise goes, failures and messages stay', () => {
  const groups = new Map<string, CommandRow[]>();
  const a = command('skills_list');
  const b = command('hcasm_call · feature.create');
  const c = command('view_render · iso', 'running');
  const lone = command('hcasm_call · print.analyze');
  const rows: AgentTimelineRow[] = [
    state('running'),
    message('Building.'),
    a,
    b,
    c,
    message('Checking.'),
    lone,
    { id: 'u', kind: 'usage', sequence: 99, detail: '0 input', createdAt: at },
    state('interrupted'),
  ];
  const shown = foldToolRows(rows, groups);
  assert.deepEqual(
    shown.map((row) => row.id),
    [rows[1]!.id, a.id, rows[5]!.id, lone.id, rows[8]!.id],
  );
  assert.deepEqual(groups.get(a.id), [a, b, c]);
  assert.equal(groups.has(lone.id), false);
  const summary = groupSummary(groups.get(a.id)!);
  assert.equal(summary.count, 3);
  assert.equal(summary.running?.text, 'Rendering the iso view…');
  // Calling again replaces the groups (no stale anchors).
  foldToolRows([message('x')], groups);
  assert.equal(groups.size, 0);
});

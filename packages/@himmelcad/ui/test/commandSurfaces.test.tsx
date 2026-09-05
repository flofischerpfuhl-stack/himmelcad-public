import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CommandContext } from '../../app/src/commands.js';
import {
  EntityCommandMenu,
  QuickCommandSurface,
  clampMenuPosition,
} from '../src/CommandSurfaces.js';

const context: CommandContext = {
  hasProject: true,
  selectedEntityIds: ['line'],
  selectedEntityKinds: ['polyline'],
  selectionVisibility: 'visible',
  selectionEditable: true,
  selectionExportable: true,
  clipboardAdmissible: true,
  candidates: [
    { entityId: 'line', kind: 'Polyline', name: 'Boundary' },
    { entityId: 'surface', kind: 'Mesh', name: 'Existing ground' },
  ],
};

void test('entity command menu groups registry rows and renders the candidate submenu', () => {
  const html = renderToStaticMarkup(
    <EntityCommandMenu
      x={24}
      y={32}
      context={context}
      currentCandidateId="line"
      candidateSubmenuOpen
      onExecute={() => undefined}
      onClose={() => undefined}
    />,
  );
  assert.match(html, /Select under cursor/);
  assert.match(html, /Polyline · Boundary/);
  assert.match(html, /Mesh · Existing ground/);
  assert.match(html, /aria-current="true"/);
  assert.ok((html.match(/role="separator"/g) ?? []).length >= 2);
});

void test('quick surface has the exact header and registry cap', () => {
  const html = renderToStaticMarkup(
    <QuickCommandSurface
      x={24}
      y={32}
      context={context}
      onExecute={() => undefined}
      onClose={() => undefined}
    />,
  );
  assert.match(html, />Viewport</);
  assert.ok((html.match(/role="menuitem"/g) ?? []).length <= 7);
  assert.match(html, /Frame all/);
  assert.match(html, /Clear selection/);
  assert.match(html, /Paste in place/);
});

void test('context surfaces clamp to the viewport', () => {
  assert.deepEqual(clampMenuPosition(995, 795, 240, 320, 1_000, 800), { x: 756, y: 476 });
});

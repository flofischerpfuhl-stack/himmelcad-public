import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CommandContext } from '../../app/src/commands.js';
import {
  EntityCommandMenu,
  QuickCommandSurface,
  clampMenuPosition,
} from '../src/CommandSurfaces.js';
import { dispatchEntityTreeCommand } from '../src/EntityTree.js';
import type { EntityId } from '@himmelcad/data';

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
      target={{ entityIds: ['line'], kind: 'Polyline3D' }}
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

void test('PhotoLab image command is visible only for the PhotoLab CameraImage menu', () => {
  const imageContext: CommandContext = {
    ...context,
    productId: 'photolab',
    selectedEntityIds: ['image-1'],
    selectedEntityKinds: ['other'],
    selectedCanonicalEntityKinds: ['CameraImage'],
    entityKind: 'CameraImage',
    candidates: [],
  };
  const render = (productId: string) =>
    renderToStaticMarkup(
      <EntityCommandMenu
        x={24}
        y={32}
        context={{ ...imageContext, productId }}
        target={{ entityIds: ['image-1'], kind: 'CameraImage' }}
        onExecute={() => undefined}
        onClose={() => undefined}
      />,
    );
  assert.match(render('photolab'), /Remove from project…/);
  assert.doesNotMatch(render('builder'), /Remove from project…/);
});

void test('tree-unhandled command ids are forwarded unchanged with the selected ids', () => {
  const calls: Array<{ commandId: string; entityIds: readonly EntityId[] }> = [];
  dispatchEntityTreeCommand(
    'photolab.images.remove',
    { entityIds: ['image-1', 'image-2'], kind: 'CameraImage' },
    'image-1' as EntityId,
    {
      productId: 'photolab',
      onRename: () => undefined,
      onContextAction: (commandId: string, entityIds: readonly EntityId[]) =>
        calls.push({ commandId, entityIds }),
    },
  );
  assert.deepEqual(calls, [
    { commandId: 'photolab.images.remove', entityIds: ['image-1', 'image-2'] },
  ]);
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

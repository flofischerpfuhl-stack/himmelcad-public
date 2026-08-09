import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addPlanSheet,
  createPlanDocument,
  createPlanSheet,
  duplicatePlanSheet,
  movePlanSheet,
  parsePlanDocument,
  removePlanSheet,
  renamePlanSheet,
  replaceSheetScene,
  serializePlanDocument,
  validatePlanDocument,
} from './document.js';

describe('PlanDocument', () => {
  it('roundtrips a versioned multi-sheet document with Excalidraw scene per sheet', () => {
    let document = createPlanDocument({ id: 'plan-1', name: 'Site plan', projectId: 'project-1' });
    const firstId = document.sheets[0]!.id;
    document = replaceSheetScene(document, firstId, {
      elements: [{ id: 'rect-1', type: 'rectangle', x: 40, y: 80, width: 120, height: 60 }],
      appState: { zoom: { value: 1 } },
      files: {},
    });
    document = addPlanSheet(document, createPlanSheet('sheet-2', 'Details'));
    document = duplicatePlanSheet(document, 'sheet-2', 'sheet-3');
    document = renamePlanSheet(document, 'sheet-3', 'Sections');
    document = movePlanSheet(document, 'sheet-3', -1);

    assert.deepEqual(
      document.sheets.map((sheet) => sheet.id),
      [firstId, 'sheet-3', 'sheet-2'],
    );
    const serialized = serializePlanDocument(document);
    assert.deepEqual(parsePlanDocument(serialized), document);
    assert.equal(validatePlanDocument(document).length, 0);

    const reduced = removePlanSheet(document, 'sheet-2');
    assert.equal(reduced.sheets.length, 2);
    assert.throws(
      () => removePlanSheet(removePlanSheet(reduced, 'sheet-3'), firstId),
      /at least one sheet/,
    );
  });

  it('migrates the documented v1 composition wrapper', () => {
    const legacy = JSON.stringify({
      formatVersion: 1,
      kind: 'planDocument',
      id: 'legacy-plan',
      name: 'Legacy',
      plotProfileId: 'monochrome',
      sheets: [
        {
          id: 'old-sheet',
          paper: { size: 'A4', orientation: 'portrait', marginMm: 8 },
          compositionScene: {
            engine: 'excalidraw',
            data: { elements: [{ id: 'text-1', type: 'text', text: 'Legacy note' }] },
          },
        },
      ],
    });
    const migrated = parsePlanDocument(legacy);
    assert.equal(migrated.formatVersion, 2);
    assert.equal(migrated.plotProfile, 'monochrome');
    assert.equal(migrated.sheets[0]!.scene.elements.length, 1);
    assert.equal(validatePlanDocument(migrated).length, 0);
  });

  it('rejects modified v2 content whose hash was not revised', () => {
    const document = createPlanDocument({ id: 'plan-hash', name: 'Original' });
    const parsed = JSON.parse(serializePlanDocument(document)) as Record<string, unknown>;
    parsed.name = 'Tampered';
    assert.throws(() => parsePlanDocument(JSON.stringify(parsed)), /content hash/i);
  });
});

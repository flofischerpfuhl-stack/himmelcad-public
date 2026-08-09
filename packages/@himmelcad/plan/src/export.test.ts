import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addPlanSheet,
  createPlanDocument,
  createPlanSheet,
  replaceSheetScene,
} from './document.js';
import { exportPlanDeterministically } from './export.js';

describe('deterministic plan export', () => {
  it('emits repeatable multi-sheet SVG and PDF with physical page sizes', () => {
    let document = createPlanDocument({ id: 'export-plan', name: 'Export fixture' });
    const first = document.sheets[0]!.id;
    document = replaceSheetScene(document, first, {
      elements: [
        { id: 'box', type: 'rectangle', x: 40, y: 40, width: 400, height: 200 },
        {
          id: 'label',
          type: 'text',
          x: 60,
          y: 60,
          width: 200,
          height: 40,
          text: 'Sheet one',
          fontSize: 20,
        },
      ],
      appState: {},
      files: {},
    });
    const second = createPlanSheet('sheet-a4', 'A4 portrait');
    second.paper = { sizeId: 'a4', orientation: 'portrait', marginMm: 8 };
    document = addPlanSheet(document, second);

    const firstExport = exportPlanDeterministically(document);
    const secondExport = exportPlanDeterministically(document);
    assert.deepEqual(firstExport, secondExport);
    assert.equal(firstExport.sheets.length, 2);
    assert.match(firstExport.sheets[0]!.svg, /width="420mm" height="297mm"/);
    assert.match(firstExport.sheets[1]!.svg, /width="210mm" height="297mm"/);
    const pdf = new TextDecoder().decode(firstExport.pdf);
    assert.match(pdf, /^%PDF-1\.4/);
    assert.match(pdf, /\/Count 2/);
    assert.match(pdf, /\/MediaBox \[0 0 1190\.5512 841\.8898\]/);
    assert.equal(firstExport.report.sheetCount, 2);
    assert.equal(firstExport.report.vectorElementCount, 2);
    assert.equal(firstExport.report.schemaVersion, 1);
    assert.equal(
      firstExport.report.targets.find((target) => target.format === 'pdf')?.deterministic,
      true,
    );
    assert.equal(
      firstExport.report.targets.find((target) => target.format === 'png')?.deterministic,
      false,
    );
    assert(firstExport.report.warnings.some((warning) => warning.code === 'fontSubstituted'));
    assert.equal(
      firstExport.report.warnings.filter((warning) => warning.code === 'browserRasterization')
        .length,
      2,
    );
  });
});

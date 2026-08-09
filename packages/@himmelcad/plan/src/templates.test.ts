import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBuiltinPlanTemplates, instantiatePlanTemplate } from './templates.js';

describe('plan templates', () => {
  it('ships every typed composition group and freezes bindings', () => {
    const templates = createBuiltinPlanTemplates();
    assert.deepEqual(
      new Set(templates.map((template) => template.kind)),
      new Set([
        'frame',
        'titleBlock',
        'northArrow',
        'scaleBar',
        'legend',
        'logo',
        'textGroup',
        'stamp',
      ]),
    );
    const titleBlock = templates.find((template) => template.kind === 'titleBlock')!;
    const placed = instantiatePlanTemplate(
      titleBlock,
      'instance-1',
      { x: 250, y: 240 },
      {
        project: { name: 'Himmel survey' },
        plan: { name: 'Site plan' },
        sheet: { name: 'Sheet 03' },
        user: { name: 'Ada' },
        viewport: { scale: '1:250' },
      },
    );
    assert.ok(placed.elements.some((element) => element.text === 'Himmel survey'));
    assert.ok(placed.elements.some((element) => element.text === '1:250'));
    assert.equal(placed.instance.templateContentHash, titleBlock.contentHash);
    assert.equal(new Set(placed.instance.elementIds).size, placed.instance.elementIds.length);
  });
});

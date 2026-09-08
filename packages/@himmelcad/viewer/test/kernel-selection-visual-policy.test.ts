import assert from 'node:assert/strict';
import test from 'node:test';

import { kernelSelectionVisualPolicy } from '../src/kernel/index.js';

void test('G-B2-SELECTION-VISUAL uses semantic tokens, direction glyphs, point squares and symbol anchors', () => {
  const line = kernelSelectionVisualPolicy(
    { entityKind: 'Polyline3D', selected: true, hovered: false, pickable: true },
    { supportGeometryVisible: true, directionArrowSizePixels: 11 },
  );
  assert.equal(line.colorToken, '--hc-geometry-selection');
  assert.deepEqual(line.directionGlyph, { kind: 'endArrow', sizePixels: 11 });
  assert.equal(
    kernelSelectionVisualPolicy(
      { entityKind: 'SinglePoint', selected: true, hovered: false, pickable: true },
      { supportGeometryVisible: true },
    ).visualClass,
    'pointSquare',
  );
  const symbol = kernelSelectionVisualPolicy(
    {
      entityKind: 'SinglePoint',
      selected: true,
      hovered: false,
      pickable: true,
      symbolBearingPoint: true,
    },
    { supportGeometryVisible: true },
  );
  assert.equal(symbol.visualClass, 'symbolAnchor');
  assert.equal(symbol.anchorOnly, true);
  assert.equal(
    kernelSelectionVisualPolicy(
      { entityKind: 'Polyline3D', selected: false, hovered: true, pickable: true },
      { supportGeometryVisible: false },
    ).colorToken,
    '--hc-geometry-hover',
  );
});

void test('G-B2-SELECTION-VISUAL support overlay is toggle-bound and clouds never hover-restyle', () => {
  const input = {
    entityKind: 'curve',
    selected: false,
    hovered: true,
    pickable: true,
    supportRole: 'defining_curve' as const,
  };
  assert.equal(
    kernelSelectionVisualPolicy(input, { supportGeometryVisible: true }).colorToken,
    '--hc-geometry-support',
  );
  assert.equal(
    kernelSelectionVisualPolicy(input, { supportGeometryVisible: false }).visualClass,
    null,
  );
  const cloud = kernelSelectionVisualPolicy(
    { entityKind: 'PointCloud', selected: false, hovered: true, pickable: true },
    { supportGeometryVisible: true },
  );
  assert.equal(cloud.hovered, false);
  assert.equal(cloud.visualClass, null);
});

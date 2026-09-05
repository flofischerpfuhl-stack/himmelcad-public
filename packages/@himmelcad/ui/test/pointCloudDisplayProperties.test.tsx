import assert from 'node:assert/strict';
import test from 'node:test';
import type { PointCloudDisplayStyle } from '@himmelcad/app';
import { renderToStaticMarkup } from 'react-dom/server';

import { PointCloudDisplayProperties } from '../src/PointCloudDisplayProperties.js';

const first: PointCloudDisplayStyle = {
  schemaId: 'hcad.resource.point-cloud-display@1',
  pointSizePixels: 2,
  colorMode: 'classification',
  classes: [
    { code: 2, name: 'Ground', visible: true },
    { code: 5, name: 'High vegetation', visible: false },
  ],
};

void test('point-cloud display exposes bounded controls and P9 mixed class state', () => {
  const markup = renderToStaticMarkup(
    <PointCloudDisplayProperties
      styles={[
        first,
        {
          ...first,
          classes: first.classes.map((item) =>
            item.code === 5 ? { ...item, visible: true } : item,
          ),
        },
      ]}
      onChange={() => undefined}
    />,
  );

  assert.match(markup, /aria-label="Point size"[^>]*min="1"[^>]*max="8"/);
  assert.match(markup, /aria-label="Point cloud color"/);
  assert.match(markup, />Classification<\/span>/);
  assert.match(markup, /aria-checked="mixed"/);
  assert.match(markup, /High vegetation/);
});

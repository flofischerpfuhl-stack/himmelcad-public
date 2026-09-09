import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ExportIsland } from '../src/ExportIsland.js';

const noop = (): void => undefined;
const formats = [
  { id: 'dxf', label: 'DXF', enabled: true },
  {
    id: 'ifc',
    label: 'IFC',
    enabled: false,
    disabledReason: 'IFC export requires an unchanged IFC import scope.',
  },
] as const;

test('export island discloses every lossy plan row before enabling export', () => {
  const html = renderToStaticMarkup(
    <ExportIsland
      formats={formats}
      formatId="dxf"
      scope="selection"
      selectionCount={3}
      path="/projects/road.dxf"
      planRows={[
        {
          entityKind: 'Surface',
          count: 1,
          writtenAs: '3DFACE + breaklines',
          lossNote: 'TIN is written as separate faces',
          lossCodes: ['hcad.loss.dxf.mesh-entity-partition@1'],
        },
        {
          entityKind: 'Point cloud',
          count: 2,
          writtenAs: 'not written',
          lossNote: 'Geometry is not representable and is omitted',
          lossCodes: ['hcad.loss.dxf.entity-omitted@1'],
        },
      ]}
      outputs={['road.dxf']}
      onFormatChange={noop}
      onScopeChange={noop}
      onChoosePath={noop}
      onPlan={noop}
      onExport={noop}
      onCancel={noop}
      onClose={noop}
    />,
  );
  assert.match(html, /Losses disclosed/);
  assert.match(html, /Point cloud/);
  assert.match(html, /not written/);
  assert.match(html, /hcad\.loss\.dxf\.entity-omitted@1/);
  assert.match(html, />Export<\/span><\/button>/);
});

test('export island shows phase, progress, and cancel while running', () => {
  const html = renderToStaticMarkup(
    <ExportIsland
      formats={formats}
      formatId="dxf"
      scope="visible"
      selectionCount={0}
      path="/projects/road.dxf"
      planRows={[]}
      running={{ phase: 'Writing staged DXF', fraction: 0.64 }}
      onFormatChange={noop}
      onScopeChange={noop}
      onChoosePath={noop}
      onPlan={noop}
      onExport={noop}
      onCancel={noop}
      onClose={noop}
    />,
  );
  assert.match(html, /Writing staged DXF/);
  assert.match(html, /64%/);
  assert.match(html, />Cancel<\/span><\/button>/);
  assert.match(html, /disabled=""[^>]*><span>Export/);
});

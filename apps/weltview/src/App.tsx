import { useState } from 'react';

import type { SnapResult } from '@himmelcad/data';
import { AppShell, EntityTree, FunctionPanel, Ribbon, StatusBar, TitleBar } from '@himmelcad/ui';
import { Viewport } from '@himmelcad/viewer';

const VIEWER_TABS = [
  {
    id: 'view',
    label: 'View',
    groups: [
      {
        id: 'view.camera',
        label: 'Camera',
        actions: [
          { id: 'view.frame', label: 'Frame All' },
          { id: 'view.top', label: 'Top' },
        ],
      },
      {
        id: 'view.measure',
        label: 'Measure',
        actions: [{ id: 'inspect.distance', label: 'Distance' }],
      },
    ],
  },
];

export function App(): JSX.Element {
  const [snap, setSnap] = useState<SnapResult | null>(null);

  return (
    <AppShell
      titleBar={<TitleBar appName="HimmelCAD" productLabel="WeltView" controls={null} />}
      ribbon={<Ribbon tabs={VIEWER_TABS} />}
      leftPanel={<EntityTree project={null} selectedIds={new Set()} onSelect={() => undefined} />}
      rightPanel={<FunctionPanel activeFunctionId={null} />}
      bottomPanel={<div style={{ padding: 12, color: 'var(--hc-fg-muted)' }}>Read-only viewer</div>}
      viewport={<Viewport onCursorSnap={setSnap} />}
      statusBar={
        <StatusBar
          items={[
            { id: 'mode', content: 'Read-only', align: 'left' },
            { id: 'snap', content: snap ? `Snap: ${snap.kind}` : 'Snap: —', align: 'right' },
          ]}
        />
      }
    />
  );
}

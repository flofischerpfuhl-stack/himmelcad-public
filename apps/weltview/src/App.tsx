import { useState } from 'react';

import { AppShell, EntityTree, FunctionPanel, Ribbon, StatusBar, TitleBar } from '@himmelcad/ui';
import type { HimmelcadViewerWasmLoader } from '@himmelcad/viewer/kernel';
import { KernelViewport } from '@himmelcad/viewer/kernel/react';

const viewerWasmUrl = new URL('viewer-wasm/himmelcad_wasm.js', window.location.href).href;
const decodeWasmUrl = new URL('viewer-decode-wasm/himmelcad_decode_wasm.js', window.location.href)
  .href;
const wasmLoader: HimmelcadViewerWasmLoader = async () => import(/* @vite-ignore */ viewerWasmUrl);

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
  const [snapKind, setSnapKind] = useState<string | null>(null);

  return (
    <AppShell
      titleBar={<TitleBar appName="HimmelCAD" productLabel="WeltView" controls={null} />}
      ribbon={<Ribbon tabs={VIEWER_TABS} />}
      leftPanel={<EntityTree project={null} selectedIds={new Set()} onSelect={() => undefined} />}
      rightPanel={<FunctionPanel activeFunctionId={null} />}
      bottomPanel={<div style={{ padding: 12, color: 'var(--hc-fg-muted)' }}>Read-only viewer</div>}
      viewport={
        <KernelViewport
          wasmLoader={wasmLoader}
          decodeWasmModuleUrl={decodeWasmUrl}
          authoritativeSectionTolerance={0.001}
          presentationMode="windowMask"
          onActivePick={(candidate) => setSnapKind(candidate?.snapKind ?? null)}
        />
      }
      statusBar={
        <StatusBar
          items={[
            { id: 'mode', content: 'Read-only', align: 'left' },
            { id: 'snap', content: snapKind ? `Snap: ${snapKind}` : 'Snap: —', align: 'right' },
          ]}
        />
      }
    />
  );
}

import { useEffect, useMemo, useState } from 'react';

import { Console, logEvent } from '@himmelcad/console';
import type { EntityId, ProjectSnapshot, SnapResult } from '@himmelcad/data';
import {
  AppShell,
  EntityTree,
  FunctionPanel,
  Ribbon,
  StatusBar,
  useLayoutStore,
} from '@himmelcad/ui';
import { Viewport } from '@himmelcad/viewer';

import { ribbonTabs } from './ribbon.js';

export function App(): JSX.Element {
  const [project, _setProject] = useState<ProjectSnapshot | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<EntityId>>(new Set());
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const activeFunctionId = useLayoutStore((s) => s.activeFunctionId);

  useEffect(() => {
    logEvent('info', 'renderer', 'Polyshape renderer mounted');
  }, []);

  const statusItems = useMemo(
    () => [
      { id: 'tool', content: activeFunctionId ?? 'Idle', align: 'left' as const },
      { id: 'sel', content: `Selected: ${selected.size}`, align: 'left' as const },
      {
        id: 'snap',
        content: snap ? `Snap: ${snap.kind}` : 'Snap: —',
        align: 'right' as const,
      },
      { id: 'units', content: 'm', align: 'right' as const },
    ],
    [activeFunctionId, selected.size, snap],
  );

  const onSelect = (id: EntityId, mode: 'replace' | 'add' | 'toggle') => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (mode === 'replace') {
        next.clear();
        next.add(id);
      } else if (mode === 'add') {
        next.add(id);
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <AppShell
      ribbon={<Ribbon tabs={ribbonTabs} />}
      leftPanel={<EntityTree project={project} selectedIds={selected} onSelect={onSelect} />}
      rightPanel={
        <FunctionPanel activeFunctionId={activeFunctionId} title={functionTitle(activeFunctionId)}>
          {functionBody(activeFunctionId)}
        </FunctionPanel>
      }
      bottomPanel={<Console defaultLevel="debug" />}
      viewport={<Viewport onCursorSnap={setSnap} />}
      statusBar={<StatusBar items={statusItems} />}
    />
  );
}

function functionTitle(id: string | null): string | undefined {
  if (!id) return undefined;
  return id.replace(/[._:-]/g, ' ');
}

function functionBody(id: string | null): JSX.Element | null {
  if (!id) return null;
  return (
    <div style={{ color: 'var(--hc-fg-muted)', fontSize: 12 }}>
      Parameters for <code>{id}</code> appear here once the function ships.
    </div>
  );
}

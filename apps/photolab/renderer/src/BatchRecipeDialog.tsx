import type { EntityId, ObjectHash, ProcessingSetRecord } from '@himmelcad/data';
import { Select } from '@himmelcad/ui';
import { FileDown, FileUp, Play, RotateCcw, X } from 'lucide-react';
import { useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { BatchPipelineStep } from './BatchConfiguratorPanel.js';
import {
  graphForBatchRecipePreset,
  instantiateBatchRecipe,
  isBatchRecipeTemplateFile,
  type BatchRecipeCanvasNode,
  type BatchRecipePreset,
  type BatchRecipeTemplateFile,
} from './batchRecipe.js';
import styles from './BatchRecipeDialog.module.css';

export interface BatchRecipeArtifactCandidate {
  entityId: EntityId;
  label: string;
  kind: 'dem';
  versionHash: ObjectHash;
}

export function BatchRecipeDialog({
  busy,
  allCameraIds,
  selectedCameraIds,
  processingSets,
  activeProcessingSetId,
  artifacts,
  onActivateProcessingSet,
  onClearProcessingSet,
  onRun,
  onClose,
  onError,
}: {
  busy: boolean;
  allCameraIds: readonly EntityId[];
  selectedCameraIds: readonly EntityId[];
  processingSets: readonly ProcessingSetRecord[];
  activeProcessingSetId: EntityId | null;
  artifacts: readonly BatchRecipeArtifactCandidate[];
  onActivateProcessingSet: (id: EntityId) => void;
  onClearProcessingSet: () => void;
  onRun: (
    steps: BatchPipelineStep[],
    cameraEntityIds: readonly EntityId[],
    scopeLabel: string,
  ) => void;
  onClose: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const titleId = useId();
  const [name, setName] = useState('All products');
  const [preset, setPreset] = useState<BatchRecipePreset>('allProducts');
  const initialGraph = useMemo(() => graphForBatchRecipePreset(preset), [preset]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selectedNodeId, setSelectedNodeId] = useState('alignment');
  const [scope, setScope] = useState<'all' | 'selection' | `processing:${string}`>(
    activeProcessingSetId ? `processing:${activeProcessingSetId}` : 'all',
  );
  const [externalDemId, setExternalDemId] = useState<EntityId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{
    id: string;
    pointerId: number;
    start: { x: number; y: number };
    origin: { x: number; y: number };
  } | null>(null);
  const nodes = initialGraph.nodes.map((node) => ({
    ...node,
    position: positions[node.id] ?? node.position,
  }));
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0];
  const processingSetId = scope.startsWith('processing:')
    ? (scope.slice('processing:'.length) as EntityId)
    : null;
  const processingSet = processingSets.find((candidate) => candidate.entityId === processingSetId);
  const cameraIds =
    scope === 'all'
      ? allCameraIds
      : scope === 'selection'
        ? selectedCameraIds
        : (processingSet?.cameraEntityIds ?? []);
  const selectedDem = artifacts.find((artifact) => artifact.entityId === externalDemId);
  const issues = [
    ...(cameraIds.length < 2 ? ['Select at least two images.'] : []),
    ...(processingSetId && !processingSet ? ['The frozen processing set no longer exists.'] : []),
    ...(preset === 'orthomosaicExternalDem' && !selectedDem
      ? ['Bind the DEM input to one exact project artifact.']
      : []),
    ...(!name.trim() ? ['Recipe name is required.'] : []),
  ];
  const ready = issues.length === 0;

  const changePreset = (next: BatchRecipePreset): void => {
    setPreset(next);
    setName(next === 'allProducts' ? 'All products' : 'Orthomosaic from selected DEM');
    setSelectedNodeId('alignment');
    setPositions({});
    setExternalDemId(null);
    setError(null);
  };

  const startDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    node: BatchRecipeCanvasNode,
  ): void => {
    drag.current = {
      id: node.id,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: node.position,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setPositions((positions) => ({
      ...positions,
      [current.id]: {
        x: clamp(current.origin.x + event.clientX - current.start.x, 18, 690),
        y: clamp(current.origin.y + event.clientY - current.start.y, 18, 390),
      },
    }));
  };
  const stopDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const save = async (): Promise<void> => {
    setError(null);
    try {
      const template: BatchRecipeTemplateFile = {
        formatVersion: 2,
        lifecycle: 'recipeTemplate',
        name: name.trim(),
        preset,
        nodes,
        edges: initialGraph.edges,
      };
      await window.himmelcad?.batch.save(template);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      onError(message);
    }
  };

  const load = async (): Promise<void> => {
    setError(null);
    try {
      const value = await window.himmelcad?.batch.load<unknown>();
      if (value == null) return;
      if (!isBatchRecipeTemplateFile(value))
        throw new Error('This file is not a PhotoLab RecipeTemplate.');
      setName(value.name);
      setPreset(value.preset);
      setPositions(Object.fromEntries(value.nodes.map((node) => [node.id, node.position])));
      setSelectedNodeId(value.nodes[0]?.id ?? 'alignment');
      // Artifact bindings intentionally never travel with a reusable template.
      setExternalDemId(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      onError(message);
    }
  };

  const instantiate = (): void => {
    if (!ready) return;
    const steps = instantiateBatchRecipe(preset, selectedDem?.entityId, selectedDem?.versionHash);
    const label = processingSet
      ? `${processingSet.name} · immutable processing set`
      : scope === 'selection'
        ? `Current selection · ${cameraIds.length}`
        : `All images · ${cameraIds.length}`;
    onRun(steps, scope === 'all' ? [] : cameraIds, label);
  };

  return (
    <div className={styles.root} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className={styles.header} data-task-drag-handle>
        <h2 id={titleId}>Configure batch</h2>
        <button type="button" onClick={onClose} aria-label="Close batch configuration">
          <X size={15} />
        </button>
      </header>
      <div className={styles.toolbar}>
        <label>
          <span>Recipe</span>
          <Select
            value={preset}
            disabled={busy}
            onChange={(event) => changePreset(event.currentTarget.value as BatchRecipePreset)}
          >
            <option value="allProducts">All products · linear standard</option>
            <option value="orthomosaicExternalDem">Orthomosaic · selected external DEM</option>
          </Select>
        </label>
        <label>
          <span>Scope</span>
          <Select
            value={scope}
            disabled={busy}
            onChange={(event) => {
              const next = event.currentTarget.value as typeof scope;
              setScope(next);
              if (next.startsWith('processing:'))
                onActivateProcessingSet(next.slice(11) as EntityId);
              else onClearProcessingSet();
            }}
          >
            <option value="all">All images · {allCameraIds.length}</option>
            <option value="selection">Current selection · {selectedCameraIds.length}</option>
            {processingSets.map((item) => (
              <option key={item.entityId} value={`processing:${item.entityId}`}>
                {item.name} · {item.cameraEntityIds.length}
              </option>
            ))}
          </Select>
        </label>
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={() => void load()}>
            <FileUp size={14} /> Load
          </button>
          <button type="button" disabled={busy || !name.trim()} onClick={() => void save()}>
            <FileDown size={14} /> Save template
          </button>
          <button type="button" disabled={busy} onClick={() => changePreset('allProducts')}>
            <RotateCcw size={14} /> Standard
          </button>
        </div>
      </div>
      <div className={styles.body}>
        <div className={styles.canvas} aria-label="Batch recipe node canvas">
          <svg className={styles.edges} width={820} height={470} aria-hidden="true">
            {initialGraph.edges.map((edge) => {
              const from = nodes.find((node) => node.id === edge.from);
              const to = nodes.find((node) => node.id === edge.to);
              if (!from || !to) return null;
              const x1 = from.position.x + 128;
              const y1 = from.position.y + 38;
              const x2 = to.position.x;
              const y2 = to.position.y + 38;
              const bend = Math.max(40, Math.abs(x2 - x1) * 0.45);
              return (
                <path
                  key={`${edge.from}-${edge.to}-${edge.artifact}`}
                  d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                />
              );
            })}
            {preset === 'orthomosaicExternalDem' && (
              <path className={styles.externalEdge} d="M 465 280 C 500 280, 485 188, 510 188" />
            )}
          </svg>
          {nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`${styles.node} ${selectedNode?.id === node.id ? styles.nodeSelected : ''}`}
              style={{ left: node.position.x, top: node.position.y }}
              onClick={() => setSelectedNodeId(node.id)}
              onPointerDown={(event) => startDrag(event, node)}
              onPointerMove={moveDrag}
              onPointerUp={stopDrag}
              onPointerCancel={stopDrag}
            >
              <span className={styles.inputPorts}>
                {node.inputs.map((port) => (
                  <i key={port} title={`${port} input`} />
                ))}
              </span>
              <strong>{node.label}</strong>
              <small>{node.kind}</small>
              <i className={styles.outputPort} title={`${node.output} output`} />
            </button>
          ))}
          {preset === 'orthomosaicExternalDem' && (
            <div
              className={`${styles.slot} ${selectedDem ? styles.slotBound : styles.slotInvalid}`}
            >
              <strong>DEM slot</strong>
              <span>{selectedDem ? selectedDem.label : 'Unbound'}</span>
            </div>
          )}
        </div>
        <aside className={styles.inspector}>
          <h3>Inspector</h3>
          <label>
            <span>Template name</span>
            <input
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          {selectedNode && (
            <div className={styles.nodeDetails}>
              <strong>{selectedNode.label}</strong>
              <span>Inputs: {selectedNode.inputs.join(', ') || 'none'}</span>
              <span>Output: {selectedNode.output}</span>
            </div>
          )}
          {preset === 'orthomosaicExternalDem' && (
            <label>
              <span>DEM binding</span>
              <Select
                value={externalDemId ?? ''}
                disabled={busy}
                onChange={(event) =>
                  setExternalDemId((event.currentTarget.value || null) as EntityId | null)
                }
              >
                <option value="">Select exact project artifact…</option>
                {artifacts.map((artifact) => (
                  <option key={artifact.entityId} value={artifact.entityId}>
                    {artifact.label} · {artifact.versionHash.slice(0, 10)}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <div className={ready ? styles.ready : styles.invalid}>
            <strong>{ready ? 'Ready for unattended run' : 'Not ready'}</strong>
            {issues.map((issue) => (
              <span key={issue}>{issue}</span>
            ))}
            {ready && (
              <span>
                All mandatory inputs are resolved before Run. Runtime cannot request user input.
              </span>
            )}
          </div>
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
        </aside>
      </div>
      <footer className={styles.footer}>
        <span>
          Template bindings are symbolic; this run freezes exact entity revisions and hashes.
        </span>
        <button
          type="button"
          className={styles.run}
          disabled={busy || !ready}
          onClick={instantiate}
        >
          <Play size={15} /> {busy ? 'Queueing…' : 'Instantiate & run'}
        </button>
      </footer>
    </div>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

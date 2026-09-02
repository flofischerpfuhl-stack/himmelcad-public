import { X } from 'lucide-react';
import { useId, useMemo } from 'react';

import type { BatchPipelineStep } from './BatchConfiguratorPanel.js';
import { deriveBatchPipelineEdges } from './batchRecipe.js';
import styles from './BatchRecipeDialog.module.css';

const NODE_WIDTH = 126;
const NODE_HEIGHT = 64;
const NODE_GAP = 28;
const NODE_Y = 174;

export function BatchRecipeDialog({
  steps,
  onClose,
}: {
  steps: readonly BatchPipelineStep[];
  onClose: () => void;
}): JSX.Element {
  const titleId = useId();
  const edges = useMemo(() => deriveBatchPipelineEdges(steps), [steps]);
  const width = Math.max(720, steps.length * (NODE_WIDTH + NODE_GAP) + NODE_GAP);

  return (
    <div className={styles.root} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className={styles.header} data-task-drag-handle>
        <div>
          <h2 id={titleId}>Pipeline preview</h2>
          <span>Read-only view of the current batch configuration</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close pipeline preview">
          <X size={15} />
        </button>
      </header>
      <div className={styles.body}>
        <div className={styles.canvas} aria-label="Batch pipeline dependency graph">
          <svg viewBox={`0 0 ${width} 300`} width={width} height="300" role="img">
            <defs>
              <marker
                id="batch-preview-arrow"
                markerWidth="6"
                markerHeight="6"
                refX="5"
                refY="3"
                orient="auto"
              >
                <path className={styles.arrow} d="M 0 0 L 6 3 L 0 6 Z" />
              </marker>
            </defs>
            {edges.map((edge, index) => {
              const sourceX = nodeX(edge.from) + NODE_WIDTH / 2;
              const targetX = nodeX(edge.to) + NODE_WIDTH / 2;
              const laneY = Math.max(22, NODE_Y - 34 - index * 9);
              return (
                <g key={`${edge.from}-${edge.to}-${edge.artifact}`}>
                  <path
                    className={styles.edge}
                    d={`M ${sourceX} ${NODE_Y} C ${sourceX} ${laneY}, ${targetX} ${laneY}, ${targetX} ${NODE_Y}`}
                    markerEnd="url(#batch-preview-arrow)"
                  />
                  <text className={styles.edgeLabel} x={(sourceX + targetX) / 2} y={laneY - 3}>
                    {edge.artifact}
                  </text>
                </g>
              );
            })}
            {steps.map((step, index) => {
              const x = nodeX(index);
              const label = batchStepLabel(step);
              const detail = batchStepDetail(step);
              return (
                <g key={`${index}-${label}`} className={styles.node}>
                  <title>{`${label} · ${detail}`}</title>
                  <rect x={x} y={NODE_Y} width={NODE_WIDTH} height={NODE_HEIGHT} rx="8" />
                  <text className={styles.nodeLabel} x={x + 12} y={NODE_Y + 26}>
                    {label}
                  </text>
                  <text className={styles.nodeDetail} x={x + 12} y={NODE_Y + 45}>
                    {detail}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <footer className={styles.footer}>
        <span>
          Edges follow the same alignment and product prerequisite rules used at run time.
        </span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </footer>
    </div>
  );
}

function nodeX(index: number): number {
  return NODE_GAP + index * (NODE_WIDTH + NODE_GAP);
}

function batchStepLabel(step: BatchPipelineStep): string {
  if (step.kind === 'alignment') return 'Align Photos';
  return {
    depth: 'Depth Maps',
    dense: 'Dense Cloud',
    dem: 'DEM',
    ortho: 'Orthomosaic',
    mesh: 'Mesh',
    splat: 'Gaussian Splat',
  }[step.configuration.kind];
}

function batchStepDetail(step: BatchPipelineStep): string {
  if (step.kind === 'alignment') return 'alignment';
  if (step.configuration.kind === 'ortho' && step.configuration.sourceDemEntityId) {
    return 'external DEM';
  }
  return step.configuration.kind;
}

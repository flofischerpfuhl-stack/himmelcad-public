/**
 * Tool-session chrome: a top-centre pill (tool name, shortcut, one-line
 * prompt, the tool's option badge — Extrude New/Join/Cut, Fillet/Chamfer,
 * Union/Subtract/Intersect, Radius/Diameter — and the kernel's error for
 * the current parameters) plus floating Done/Cancel buttons near the bottom
 * centre. Rendered whenever `activeTool` is set; the viewport owns the
 * in-canvas handles and editable dimension chips this refers to.
 */
import { AlertTriangle, Check, LoaderCircle, X } from 'lucide-react';

import { Button, Tooltip } from '@himmelcad/ui';

import {
  isPreviewTool,
  type AssemblerState,
  type ToolSession as ToolSessionState,
} from '../model/store.js';
import { draftBadges, draftMeta } from '../model/featureTools.js';
import styles from './ToolSession.module.css';

interface ToolMeta {
  label: string;
  shortcut: string;
  prompt: string;
}

function toolMeta(tool: ToolSessionState): ToolMeta {
  switch (tool.kind) {
    case 'sketchRectangle':
      return {
        label: 'Rectangle',
        shortcut: 'R',
        prompt:
          tool.plane.kind === 'face'
            ? 'Click two corners.'
            : 'Click two corners on the grid or a face.',
      };
    case 'sketchCircle':
      return {
        label: 'Circle',
        shortcut: 'C',
        prompt: tool.center
          ? 'Click to set the radius or type a value. Esc to restart.'
          : tool.plane.kind === 'face'
            ? 'Click the centre.'
            : 'Click the centre on the grid or a planar face.',
      };
    case 'extrude':
      return {
        label: 'Extrude',
        shortcut: 'E',
        prompt:
          tool.distance === 0
            ? 'Drag the arrow or type a distance.'
            : 'Drag the arrow or type a distance, then Done.',
      };
    case 'move':
      return {
        label: 'Move/Rotate',
        shortcut: 'M',
        prompt:
          'Drag an arrow or ring, or type a value. Rings snap to 15° (Shift: free); drag the centre to move the pivot.',
      };
    case 'feature':
      return draftMeta(tool.draft);
    case 'edgeBlend':
      return {
        label: tool.blend === 'fillet' ? 'Fillet' : 'Chamfer',
        shortcut: 'F',
        prompt: `Drag the arrow or type a ${tool.blend === 'fillet' ? 'radius' : 'distance'}. ${tool.edges.length} ${tool.edges.length === 1 ? 'edge' : 'edges'}; click edges to add or remove.`,
      };
    case 'shell':
      return {
        label: 'Shell',
        shortcut: 'H',
        prompt: `Drag the arrow or type a wall thickness. ${tool.faces.length} open ${tool.faces.length === 1 ? 'face' : 'faces'}.`,
      };
    case 'boolean':
      return {
        label: 'Boolean',
        shortcut: '',
        prompt: `Keeps the first selected body; ${tool.toolBodyIds.length === 1 ? '1 tool body is' : `${tool.toolBodyIds.length} tool bodies are`} consumed.`,
      };
  }
}

interface BadgeOption<T extends string> {
  value: T;
  label: string;
}

function Badge<T extends string>(props: {
  ariaLabel: string;
  value: T;
  options: readonly BadgeOption<T>[];
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <span className={styles.badge} role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={props.value === option.value}
          className={`${styles.badgeOption} ${props.value === option.value ? styles.badgeOptionActive : ''}`}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

function ToolBadge({
  state,
  tool,
}: {
  state: AssemblerState;
  tool: ToolSessionState;
}): JSX.Element | null {
  switch (tool.kind) {
    case 'extrude':
      if (tool.profile.kind !== 'sketch') return null;
      return (
        <Badge
          ariaLabel="Extrude operation"
          value={tool.operation}
          options={[
            { value: 'new', label: 'New body' },
            { value: 'join', label: 'Join' },
            { value: 'cut', label: 'Cut' },
          ]}
          onChange={(operation) => state.setExtrudeOperation(operation)}
        />
      );
    case 'edgeBlend':
      return (
        <Badge
          ariaLabel="Edge treatment"
          value={tool.blend}
          options={[
            { value: 'fillet', label: 'Fillet' },
            { value: 'chamfer', label: 'Chamfer' },
          ]}
          onChange={(blend) => state.setBlendKind(blend)}
        />
      );
    case 'boolean':
      return (
        <Badge
          ariaLabel="Boolean operation"
          value={tool.operation}
          options={[
            { value: 'union', label: 'Union' },
            { value: 'subtract', label: 'Subtract' },
            { value: 'intersect', label: 'Intersect' },
          ]}
          onChange={(operation) => state.setBooleanOperation(operation)}
        />
      );
    case 'sketchCircle':
      return (
        <Badge
          ariaLabel="Circle dimension"
          value={tool.dimension}
          options={[
            { value: 'radius', label: 'Radius' },
            { value: 'diameter', label: 'Diameter' },
          ]}
          onChange={(dimension) => state.setCircleDimension(dimension)}
        />
      );
    case 'move':
      return (
        <Badge
          ariaLabel="Move or copy"
          value={tool.copy ? 'copy' : 'move'}
          options={[
            { value: 'move', label: 'Move' },
            { value: 'copy', label: 'Copy' },
          ]}
          onChange={(value) => state.setMoveCopy(value === 'copy')}
        />
      );
    case 'feature':
      return (
        <>
          {draftBadges(tool.draft).map((badge) => (
            <Badge
              key={badge.ariaLabel}
              ariaLabel={badge.ariaLabel}
              value={badge.value}
              options={badge.options}
              onChange={(value) =>
                state.updateFeatureDraft((draft, evaluation) =>
                  badge.apply(draft, value, evaluation),
                )
              }
            />
          ))}
        </>
      );
    default:
      return null;
  }
}

export function ToolSession({ state }: { state: AssemblerState }): JSX.Element | null {
  const tool = state.activeTool;
  if (!tool) return null;
  const meta = toolMeta(tool);
  const preview = isPreviewTool(tool) ? tool : null;
  const error = preview?.previewError ?? null;
  const blocked = error !== null && !(preview?.previewPending ?? false);

  return (
    <>
      <div className={styles.pill} role="status" aria-label={`${meta.label} tool active`}>
        <span className={styles.name}>{meta.label}</span>
        {meta.shortcut ? <span className={styles.shortcut}>{meta.shortcut}</span> : null}
        <span className={styles.divider} aria-hidden />
        <span className={styles.prompt}>{meta.prompt}</span>
        <ToolBadge state={state} tool={tool} />
        {preview?.previewPending ? (
          <span className={styles.busy} aria-label="Computing preview">
            <LoaderCircle size={13} />
          </span>
        ) : null}
      </div>
      {error ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={13} aria-hidden />
          <span>{error}</span>
          <span className={styles.errorHint}>Showing the last valid preview.</span>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Tooltip content="Cancel (Esc)">
          <Button
            variant="secondary"
            size="small"
            icon={<X size={14} />}
            aria-label="Cancel tool"
            onClick={() => state.cancel()}
          >
            Cancel
          </Button>
        </Tooltip>
        <Tooltip content={blocked ? 'Fix the error first' : 'Done (Enter)'}>
          <Button
            variant="primary"
            size="small"
            icon={<Check size={14} />}
            aria-label="Commit tool"
            disabled={blocked}
            onClick={() => state.commit()}
          >
            Done
          </Button>
        </Tooltip>
      </div>
    </>
  );
}

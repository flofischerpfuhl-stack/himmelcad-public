/**
 * Sketch-mode chrome: the top-centre pill (sketch name, active tool,
 * one-line prompt, constraint status, Finish), the over-constraint banner,
 * and the bottom-centre palette with the drawing tools, tool options and
 * the constraint buttons. Availability comes from the command registry,
 * so buttons, shortcuts and command search always agree.
 */
import {
  Check,
  Circle,
  DraftingCompass,
  Hexagon,
  Layers2,
  MousePointer2,
  RectangleHorizontal,
  Ruler,
  Scissors,
  Slash,
  SquareDashed,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';

import { Button, Tooltip } from '@himmelcad/ui';

import { findCommand } from '../../model/commands/registry.js';
import { useAssemblerStore } from '../../model/store.js';
import { CONSTRAINT_INFO } from '../constraintRules.js';
import { useSketchStore, type SketchSession } from '../session.js';
import type { SketchTool, SketchToolKind } from '../tools.js';
import styles from './SketchChrome.module.css';

const TOOLS: {
  kind: SketchToolKind;
  label: string;
  shortcut: string;
  icon: LucideIcon;
  command?: string;
}[] = [
  { kind: 'select', label: 'Select', shortcut: '', icon: MousePointer2 },
  { kind: 'line', label: 'Line', shortcut: 'L', icon: Slash, command: 'sketch.line' },
  { kind: 'arc', label: 'Arc', shortcut: 'A', icon: DraftingCompass, command: 'sketch.arc' },
  { kind: 'circle', label: 'Circle', shortcut: 'C', icon: Circle, command: 'sketch.circle' },
  {
    kind: 'rectangle',
    label: 'Rectangle',
    shortcut: 'R',
    icon: RectangleHorizontal,
    command: 'sketch.rectangle',
  },
  { kind: 'polygon', label: 'Polygon', shortcut: 'G', icon: Hexagon, command: 'sketch.polygon' },
  { kind: 'trim', label: 'Trim', shortcut: 'T', icon: Scissors, command: 'sketch.trim' },
  { kind: 'offset', label: 'Offset', shortcut: 'O', icon: Layers2, command: 'sketch.offset' },
  {
    kind: 'dimension',
    label: 'Dimension',
    shortcut: 'D',
    icon: Ruler,
    command: 'sketch.dimension',
  },
];

export function toolPrompt(tool: SketchTool): string {
  switch (tool.kind) {
    case 'select':
      return 'Click to select, drag to move unconstrained geometry. Esc leaves the sketch.';
    case 'line':
      return tool.start || tool.lastPointId
        ? 'Click the next point or type a length. Double-click or Enter ends the line.'
        : 'Click the start point.';
    case 'arc':
      if (!tool.start) return 'Click the start point (a line end continues tangentially).';
      if (tool.tangent || !tool.end) return 'Click the end point.';
      return 'Click a point on the arc.';
    case 'circle':
      return tool.center ? 'Click to set the size or type a diameter.' : 'Click the centre.';
    case 'rectangle':
      if (tool.first) return 'Click the opposite corner or type width and height.';
      return tool.mode === 'center' ? 'Click the centre.' : 'Click the first corner.';
    case 'polygon':
      return tool.center ? 'Click a vertex.' : 'Click the centre.';
    case 'trim':
      return 'Click the segments to remove.';
    case 'offset':
      return tool.curveId
        ? 'Move to a side, click or type a distance.'
        : 'Click the curve or chain to offset.';
    case 'dimension':
      return tool.first
        ? 'Click a second item, or click empty space to place the dimension.'
        : 'Click a line, circle, arc or point.';
  }
}

function statusText(session: SketchSession): { text: string; done: boolean } {
  if (session.solving) return { text: 'Solving…', done: false };
  if (session.sketch.entities.length === 0) return { text: 'Empty sketch', done: false };
  if (session.dof === 0) return { text: 'Fully constrained', done: true };
  return {
    text: `${session.dof} ${session.dof === 1 ? 'degree' : 'degrees'} of freedom`,
    done: false,
  };
}

function Option<T extends string | number>(props: {
  value: T;
  current: T;
  label: string;
  onSelect: (value: T) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.value === props.current}
      className={`${styles.option} ${props.value === props.current ? styles.optionActive : ''}`}
      onClick={() => props.onSelect(props.value)}
    >
      {props.label}
    </button>
  );
}

function ToolOptions({ tool }: { tool: SketchTool }): JSX.Element | null {
  const setOption = useSketchStore((s) => s.setToolOption);
  if (tool.kind === 'rectangle') {
    return (
      <div className={styles.row} role="radiogroup" aria-label="Rectangle mode">
        <Option
          value="corner"
          current={tool.mode}
          label="2 corners"
          onSelect={(mode) => setOption({ mode })}
        />
        <Option
          value="center"
          current={tool.mode}
          label="Centre"
          onSelect={(mode) => setOption({ mode })}
        />
      </div>
    );
  }
  if (tool.kind === 'polygon') {
    return (
      <div className={styles.row} role="radiogroup" aria-label="Polygon sides">
        {[3, 5, 6, 8].map((sides) => (
          <Option
            key={sides}
            value={sides}
            current={tool.sides}
            label={`${sides} sides`}
            onSelect={(n) => setOption({ sides: n })}
          />
        ))}
      </div>
    );
  }
  if (tool.kind === 'dimension') {
    return (
      <div className={styles.row} role="radiogroup" aria-label="Distance type">
        <Option
          value="aligned"
          current={tool.mode}
          label="Aligned"
          onSelect={(mode) => setOption({ mode })}
        />
        <Option
          value="horizontal"
          current={tool.mode}
          label="Horizontal"
          onSelect={(mode) => setOption({ mode })}
        />
        <Option
          value="vertical"
          current={tool.mode}
          label="Vertical"
          onSelect={(mode) => setOption({ mode })}
        />
      </div>
    );
  }
  return null;
}

export function SketchChrome(): JSX.Element | null {
  const session = useSketchStore((s) => s.session);
  const main = useAssemblerStore((s) => s);
  if (!session) return null;
  const status = statusText(session);
  const name =
    main.features.find((f) => f.id === session.featureId)?.name ??
    (session.isNew ? 'New sketch' : 'Sketch');
  const activeLabel = TOOLS.find((t) => t.kind === session.tool.kind)?.label ?? '';

  return (
    <>
      <div className={styles.pill} role="status" aria-label="Sketch mode">
        <span className={styles.name}>{name}</span>
        <span className={styles.divider} aria-hidden />
        <span className={styles.name}>{activeLabel}</span>
        <span className={styles.prompt}>{toolPrompt(session.tool)}</span>
        <span
          className={`${styles.status} ${status.done ? styles.statusDone : ''}`}
          data-sketch-status=""
        >
          {status.text}
        </span>
        <Tooltip content="Finish sketch (Esc twice)">
          <Button
            variant="primary"
            size="small"
            icon={<Check size={14} />}
            aria-label="Finish sketch"
            onClick={() => void useSketchStore.getState().finish()}
          >
            Finish
          </Button>
        </Tooltip>
      </div>
      {session.problem ? (
        <div className={styles.problem} role="alert" data-sketch-problem="">
          <TriangleAlert size={13} aria-hidden />
          <span>{session.problem.message}</span>
          <Button
            variant="secondary"
            size="small"
            icon={<X size={13} />}
            aria-label="Dismiss"
            onClick={() => useSketchStore.getState().dismissProblem()}
          />
        </div>
      ) : null}
      <div
        className={styles.palette}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label="Sketch tools"
      >
        <ToolOptions tool={session.tool} />
        <div className={styles.row} role="toolbar" aria-label="Sketch tools">
          {TOOLS.map((tool) => {
            const Icon = tool.icon;
            const hint = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label;
            return (
              <Tooltip key={tool.kind} content={hint}>
                <button
                  type="button"
                  aria-label={tool.label}
                  aria-pressed={session.tool.kind === tool.kind}
                  className={`${styles.tool} ${session.tool.kind === tool.kind ? styles.toolActive : ''}`}
                  onClick={() => useSketchStore.getState().setTool(tool.kind)}
                >
                  <Icon size={16} />
                </button>
              </Tooltip>
            );
          })}
          <span className={styles.separator} aria-hidden />
          <Tooltip content={session.construction ? 'Construction on (Q)' : 'Construction (Q)'}>
            <button
              type="button"
              aria-label="Construction"
              aria-pressed={session.construction}
              className={`${styles.tool} ${session.construction ? styles.toolActive : ''}`}
              onClick={() => void useSketchStore.getState().toggleConstructionOfSelection()}
            >
              <SquareDashed size={16} />
            </button>
          </Tooltip>
        </div>
        <div className={styles.row} role="toolbar" aria-label="Constraints">
          {CONSTRAINT_INFO.map((info) => {
            const command = findCommand(`sketch.constrain.${info.kind}`);
            const availability = command?.availability(main) ?? { enabled: false };
            const tip = availability.enabled
              ? `${info.label} (${info.shortcut})`
              : `${info.label} (${info.shortcut}) — ${availability.reason ?? ''}`;
            return (
              <Tooltip key={info.kind} content={tip}>
                <button
                  type="button"
                  aria-label={info.label}
                  className={styles.tool}
                  disabled={!availability.enabled}
                  onClick={() => command?.run(main)}
                >
                  {info.glyph}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </>
  );
}

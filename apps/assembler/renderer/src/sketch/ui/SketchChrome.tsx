/**
 * Sketch-mode chrome: the top-centre pill (sketch name, active tool,
 * one-line prompt or notice, constraint status, Finish), the problem banner
 * (with the "Add as reference" way out for already determined dimensions),
 * the projected-geometry warning, the text panel, and the bottom-centre
 * palette with the drawing tools, the modify tools, tool options and the
 * constraint buttons. Availability comes from the command registry, so
 * buttons, shortcuts and command search always agree.
 */
import {
  ArrowDownToLine,
  Check,
  Circle,
  CornerDownRight,
  DraftingCompass,
  Egg,
  FlipHorizontal2,
  Hexagon,
  Layers2,
  LayoutGrid,
  MousePointer2,
  Pill,
  RectangleHorizontal,
  Ruler,
  Scissors,
  Slash,
  Spline,
  SquareDashed,
  TriangleAlert,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button, NumberInput, Tooltip } from '@himmelcad/ui';

import fieldStyles from '../../chrome/ExpressionField.module.css';
import { findCommand } from '../../model/commands/registry.js';
import { useAssemblerStore } from '../../model/store.js';
import { CONSTRAINT_INFO } from '../constraintRules.js';
import { useSketchStore, type SketchSession } from '../session.js';
import type { SketchTool, SketchToolKind } from '../tools.js';
import styles from './SketchChrome.module.css';

interface ToolEntry {
  kind: SketchToolKind;
  label: string;
  icon: LucideIcon;
  command?: string;
}

const DRAW_TOOLS: readonly ToolEntry[] = [
  { kind: 'select', label: 'Select', icon: MousePointer2 },
  { kind: 'line', label: 'Line', icon: Slash, command: 'sketch.line' },
  { kind: 'arc', label: 'Arc', icon: DraftingCompass, command: 'sketch.arc' },
  { kind: 'circle', label: 'Circle', icon: Circle, command: 'sketch.circle' },
  { kind: 'rectangle', label: 'Rectangle', icon: RectangleHorizontal, command: 'sketch.rectangle' },
  { kind: 'polygon', label: 'Polygon', icon: Hexagon, command: 'sketch.polygon' },
  { kind: 'spline', label: 'Spline', icon: Spline, command: 'sketch.spline' },
  { kind: 'slot', label: 'Slot', icon: Pill, command: 'sketch.slot' },
  { kind: 'ellipse', label: 'Ellipse', icon: Egg, command: 'sketch.ellipse' },
  { kind: 'text', label: 'Text', icon: Type, command: 'sketch.text' },
];

const MODIFY_TOOLS: readonly ToolEntry[] = [
  { kind: 'trim', label: 'Trim', icon: Scissors, command: 'sketch.trim' },
  { kind: 'offset', label: 'Offset', icon: Layers2, command: 'sketch.offset' },
  { kind: 'corner', label: 'Fillet / Chamfer', icon: CornerDownRight, command: 'sketch.fillet' },
  { kind: 'mirror', label: 'Mirror', icon: FlipHorizontal2, command: 'sketch.mirror' },
  { kind: 'pattern', label: 'Pattern', icon: LayoutGrid, command: 'sketch.pattern' },
  { kind: 'project', label: 'Project', icon: ArrowDownToLine, command: 'sketch.project' },
  { kind: 'dimension', label: 'Dimension', icon: Ruler, command: 'sketch.dimension' },
];

const ALL_TOOLS = [...DRAW_TOOLS, ...MODIFY_TOOLS];

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
      if (!tool.center) return 'Click the centre.';
      return tool.inscribed ? 'Click a vertex.' : 'Click the middle of an edge.';
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
    case 'spline':
      if (tool.points.length === 0) return 'Click the first point.';
      return tool.mode === 'fit'
        ? 'Click points the curve passes through. Enter, double-click or the first point ends it.'
        : 'Click control points. Enter, double-click or the first point ends the spline.';
    case 'slot':
      if (!tool.first)
        return tool.mode === 'straight' ? 'Click the first centre.' : 'Click the arc centre.';
      if (!tool.second) {
        return tool.mode === 'straight'
          ? 'Click the second centre or type the centre distance.'
          : 'Click the start of the slot.';
      }
      if (tool.mode === 'arc' && !tool.third) return 'Click the end of the slot.';
      return 'Click to set the width or type it.';
    case 'ellipse':
      if (!tool.center) return 'Click the centre.';
      if (!tool.major) return 'Click the end of the first axis or type its radius.';
      if (tool.minor === null) return 'Click to set the second axis or type its radius.';
      return tool.start === null ? 'Click where the arc starts.' : 'Click where the arc ends.';
    case 'mirror':
      return tool.step === 'geometry'
        ? 'Click the curves to mirror, then Enter (or Next).'
        : 'Click the line to mirror about.';
    case 'pattern':
      if (tool.step === 'geometry') return 'Click the curves to repeat, then Enter (or Next).';
      return tool.mode === 'linear'
        ? 'Move along the direction and click where the last copy goes, or type the spacing.'
        : 'Click the centre of the pattern.';
    case 'corner':
      return tool.pointId
        ? `Move to size the ${tool.mode === 'fillet' ? 'fillet' : 'chamfer'}, click or type it.`
        : 'Click a corner between two lines.';
    case 'project':
      return 'Click body edges or faces to project them into the sketch. Esc ends.';
    case 'text':
      if (tool.editing) return 'Change the text, its height or rotation, then Update.';
      return tool.anchor
        ? 'Type the text, set height and rotation, then Place.'
        : 'Click where the text starts (baseline, left).';
  }
}

function statusText(session: SketchSession): { text: string; done: boolean } {
  if (session.solving) return { text: 'Solving…', done: false };
  if (session.sketch.entities.length === 0) return { text: 'Empty sketch', done: false };
  // The initial analysis runs asynchronously: no result yet is not "fully constrained".
  if (session.dof === null) return { text: 'Analyzing constraints…', done: false };
  if (session.dof === 0) return { text: 'Fully constrained', done: true };
  return {
    text: `${session.dof} ${session.dof === 1 ? 'degree' : 'degrees'} of freedom`,
    done: false,
  };
}

function Option<T extends string | number | boolean>(props: {
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

function Modes<T extends string>(props: {
  label: string;
  current: T;
  options: readonly [T, string][];
}): JSX.Element {
  const setOption = useSketchStore((s) => s.setToolOption);
  return (
    <div className={styles.row} role="radiogroup" aria-label={props.label}>
      {props.options.map(([value, label]) => (
        <Option
          key={value}
          value={value}
          current={props.current}
          label={label}
          onSelect={(mode) => setOption({ mode })}
        />
      ))}
    </div>
  );
}

function ToolOptions({ tool }: { tool: SketchTool }): JSX.Element | null {
  const setOption = useSketchStore((s) => s.setToolOption);
  const dispatch = useSketchStore((s) => s.dispatch);
  switch (tool.kind) {
    case 'rectangle':
      return (
        <Modes
          label="Rectangle mode"
          current={tool.mode}
          options={[
            ['corner', '2 corners'],
            ['center', 'Centre'],
          ]}
        />
      );
    case 'polygon':
      return (
        <div className={styles.row} role="group" aria-label="Polygon options">
          {[3, 5, 6, 8].map((sides) => (
            <Option
              key={sides}
              value={sides}
              current={tool.sides}
              label={`${sides} sides`}
              onSelect={(n) => setOption({ sides: n })}
            />
          ))}
          <label className={styles.inlineField}>
            <span>Sides</span>
            <NumberInput
              aria-label="Polygon sides"
              value={tool.sides}
              min={3}
              max={64}
              step={1}
              precision={0}
              onCommit={(n) => setOption({ sides: n })}
            />
          </label>
          <span className={styles.separator} aria-hidden />
          <Option
            value={true}
            current={tool.inscribed}
            label="Inscribed"
            onSelect={() => setOption({ inscribed: true })}
          />
          <Option
            value={false}
            current={tool.inscribed}
            label="Circumscribed"
            onSelect={() => setOption({ inscribed: false })}
          />
        </div>
      );
    case 'dimension':
      return (
        <Modes
          label="Distance type"
          current={tool.mode}
          options={[
            ['aligned', 'Aligned'],
            ['horizontal', 'Horizontal'],
            ['vertical', 'Vertical'],
          ]}
        />
      );
    case 'spline':
      return (
        <Modes
          label="Spline mode"
          current={tool.mode}
          options={[
            ['fit', 'Fit points'],
            ['control', 'Control points'],
          ]}
        />
      );
    case 'slot':
      return (
        <Modes
          label="Slot mode"
          current={tool.mode}
          options={[
            ['straight', 'Straight'],
            ['arc', 'Arc'],
          ]}
        />
      );
    case 'ellipse':
      return (
        <Modes
          label="Ellipse mode"
          current={tool.mode}
          options={[
            ['full', 'Ellipse'],
            ['arc', 'Elliptical arc'],
          ]}
        />
      );
    case 'corner':
      return (
        <Modes
          label="Corner"
          current={tool.mode}
          options={[
            ['fillet', 'Fillet'],
            ['chamfer', 'Chamfer'],
          ]}
        />
      );
    case 'mirror':
      return tool.step === 'geometry' ? (
        <div className={styles.row} role="group" aria-label="Mirror">
          <span className={styles.count}>{tool.ids.length} selected</span>
          <Button
            variant="primary"
            size="small"
            disabled={tool.ids.length === 0}
            onClick={() => void dispatch({ type: 'finish' })}
          >
            Next: mirror line
          </Button>
        </div>
      ) : null;
    case 'pattern':
      return (
        <div className={styles.row} role="group" aria-label="Pattern options">
          <Option
            value="linear"
            current={tool.mode}
            label="Linear"
            onSelect={() => setOption({ mode: 'linear' })}
          />
          <Option
            value="circular"
            current={tool.mode}
            label="Circular"
            onSelect={() => setOption({ mode: 'circular' })}
          />
          <span className={styles.separator} aria-hidden />
          <label className={styles.inlineField}>
            <span>Count</span>
            <NumberInput
              aria-label="Pattern count"
              value={tool.count}
              min={2}
              max={200}
              step={1}
              precision={0}
              onCommit={(n) => setOption({ count: n })}
            />
          </label>
          {tool.mode === 'circular' ? (
            <label className={styles.inlineField}>
              <span>Angle</span>
              <NumberInput
                aria-label="Pattern angle"
                value={tool.angle}
                min={-360}
                max={360}
                step={15}
                unit="°"
                onCommit={(n) => setOption({ angle: n })}
              />
            </label>
          ) : null}
          {tool.step === 'geometry' ? (
            <>
              <span className={styles.count}>{tool.ids.length} selected</span>
              <Button
                variant="primary"
                size="small"
                disabled={tool.ids.length === 0}
                onClick={() => void dispatch({ type: 'finish' })}
              >
                Next: place
              </Button>
            </>
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

/** Text content, height and rotation while the Text tool places or edits a text. */
function TextPanel({ tool }: { tool: Extract<SketchTool, { kind: 'text' }> }): JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null);
  const setOption = useSketchStore((s) => s.setToolOption);
  const active = tool.anchor !== null || tool.editing !== null;
  useEffect(() => {
    if (!active) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [active, tool.editing]);
  if (!active) return null;
  const commit = () => void useSketchStore.getState().commitText();
  return (
    <div
      className={styles.textPanel}
      role="group"
      aria-label="Text"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <label className={fieldStyles.field}>
        <span className={fieldStyles.label}>Text</span>
        <div className={fieldStyles.wrap}>
          <input
            ref={inputRef}
            className={fieldStyles.input}
            value={tool.text}
            aria-label="Text content"
            onChange={(event) => setOption({ text: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                commit();
              }
            }}
          />
        </div>
      </label>
      <label className={styles.inlineField}>
        <span>Height</span>
        <NumberInput
          aria-label="Text height"
          value={tool.height}
          min={0.1}
          step={1}
          unit="mm"
          onCommit={(n) => setOption({ height: n })}
        />
      </label>
      <label className={styles.inlineField}>
        <span>Rotation</span>
        <NumberInput
          aria-label="Text rotation"
          value={tool.angle}
          min={-360}
          max={360}
          step={15}
          unit="°"
          onCommit={(n) => setOption({ angle: n })}
        />
      </label>
      <Button variant="primary" size="small" icon={<Check size={13} />} onClick={commit}>
        {tool.editing ? 'Update' : 'Place'}
      </Button>
      <Button
        variant="secondary"
        size="small"
        aria-label="Cancel text"
        icon={<X size={13} />}
        onClick={() => useSketchStore.getState().setTool('select')}
      />
    </div>
  );
}

function ProjectionWarning({ featureId }: { featureId: string }): JSX.Element | null {
  const evaluated = useAssemblerStore((s) =>
    s.evaluation.sketches.find((sk) => sk.featureId === featureId),
  );
  const broken = (evaluated?.projections ?? []).filter((p) => p.status !== 'ok');
  if (broken.length === 0) return null;
  const text =
    broken[0]!.status === 'frozen'
      ? `Projected geometry lost its source (${broken[0]!.message ?? 'missing'}); it stays where it was.`
      : (broken[0]!.message ?? 'Projected geometry changed shape; project it again.');
  return (
    <div className={styles.warning} role="status" data-sketch-projection-warning="">
      <TriangleAlert size={13} aria-hidden />
      <span>
        {text}
        {broken.length > 1 ? ` (+${broken.length - 1} more)` : ''}
      </span>
    </div>
  );
}

export function SketchChrome(): JSX.Element | null {
  const session = useSketchStore((s) => s.session);
  const main = useAssemblerStore((s) => s);
  if (!session) return null;
  const status = statusText(session);
  const name =
    main.features.find((f) => f.id === session.featureId)?.name ??
    (session.isNew ? 'New sketch' : 'Sketch');
  const activeLabel = ALL_TOOLS.find((t) => t.kind === session.tool.kind)?.label ?? '';

  const toolButton = (tool: ToolEntry) => {
    const Icon = tool.icon;
    const shortcut = tool.command ? findCommand(tool.command)?.shortcut : undefined;
    const hint = shortcut ? `${tool.label} (${shortcut})` : tool.label;
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
  };

  return (
    <>
      <div className={styles.pill} role="status" aria-label="Sketch mode">
        <span className={styles.name}>{name}</span>
        <span className={styles.divider} aria-hidden />
        <span className={styles.name}>{activeLabel}</span>
        {session.notice ? (
          <span className={styles.notice} data-sketch-notice="">
            {session.notice}
          </span>
        ) : (
          <span className={styles.prompt}>{toolPrompt(session.tool)}</span>
        )}
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
          {session.problem.offer ? (
            <Button
              variant="primary"
              size="small"
              onClick={() => void useSketchStore.getState().acceptOffer()}
            >
              {session.problem.offer.label}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="small"
            icon={<X size={13} />}
            aria-label="Dismiss"
            onClick={() => useSketchStore.getState().dismissProblem()}
          />
        </div>
      ) : (
        <ProjectionWarning featureId={session.featureId} />
      )}
      {session.tool.kind === 'text' ? <TextPanel tool={session.tool} /> : null}
      <div
        className={styles.palette}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label="Sketch tools"
      >
        <ToolOptions tool={session.tool} />
        <div className={styles.row} role="toolbar" aria-label="Sketch tools">
          {DRAW_TOOLS.map(toolButton)}
          <span className={styles.separator} aria-hidden />
          {MODIFY_TOOLS.map(toolButton)}
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

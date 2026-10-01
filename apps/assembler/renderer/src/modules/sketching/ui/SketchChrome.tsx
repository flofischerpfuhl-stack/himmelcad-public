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
  AlignCenter,
  AlignLeft,
  AlignRight,
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
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, NumberInput, Select, Tooltip } from '@himmelcad/ui';

import {
  fontLabel,
  knownSketchFonts,
  listSketchFonts,
  loadSketchFont,
  systemFontsAvailable,
} from '../../../foundation/sketch-solver/text/fonts.js';

import fieldStyles from '../../../platform/widgets/ExpressionField.module.css';
import { findCommand } from '../../../foundation/commands/registry.js';
import { useAssemblerStore } from '../../../foundation/commands/store.js';
import { CONSTRAINT_INFO } from '../constraintRules.js';
import { patternOf, type PatternPatch } from '../operations.js';
import { useSketchStore, type SketchSession } from '../session.js';
import type { SketchPattern } from '../../../foundation/sketch-solver/types.js';
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
      if (tool.mode === 'threePoint') {
        if (!tool.start) return 'Click the start point.';
        return tool.through ? 'Click the end point.' : 'Click a point on the arc.';
      }
      if (!tool.start) return 'Click the start point (a line end continues tangentially).';
      if (tool.tangent || !tool.end) return 'Click the end point.';
      return 'Move to bend the arc, click or type its height.';
    case 'circle':
      return tool.center ? 'Click to set the size or type a diameter.' : 'Click the centre.';
    case 'rectangle':
      if (tool.mode === 'threePoint') {
        if (!tool.first) return 'Click the start of the base line.';
        return tool.second
          ? 'Click to set the height or type it.'
          : 'Click the end of the base line or type its width.';
      }
      if (tool.first) return 'Click the opposite corner or type width and height.';
      return tool.mode === 'center' ? 'Click the centre.' : 'Click the first corner.';
    case 'polygon':
      if (!tool.center) return 'Click the centre.';
      return tool.inscribed ? 'Click a vertex.' : 'Click the middle of an edge.';
    case 'trim':
      return 'Click the segments to remove.';
    case 'offset':
      return tool.curveId
        ? 'Move to a side, click or type a distance. Click another curve to add its loop.'
        : tool.mode === 'single'
          ? 'Click the curve to offset.'
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
      if (tool.mode === 'circular') return 'Click the centre of the pattern.';
      if (tool.directions === 2) {
        return tool.first
          ? 'Second direction: click where its last copy goes, or type the spacing.'
          : 'First direction: click where its last copy goes, or type the spacing.';
      }
      return 'Move along the direction and click where the last copy goes, or type the spacing.';
    case 'corner':
      return tool.pointId
        ? `Move to size the ${tool.mode === 'fillet' ? 'fillet' : 'chamfer'}, click or type it.`
        : 'Click a corner between two lines or arcs.';
    case 'project':
      return 'Click body edges or faces to project them into the sketch. Esc ends.';
    case 'text':
      if (tool.editing) {
        return 'Change the text, font or size; drag the handles to move or turn it; then Update.';
      }
      return tool.anchor
        ? 'Type the text, pick font and size; drag the handles to move or turn it; then Place.'
        : 'Click where the text goes (its anchor on the baseline).';
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
            ['threePoint', '3 points'],
          ]}
        />
      );
    case 'arc':
      return (
        <Modes
          label="Arc mode"
          current={tool.mode}
          options={[
            ['endsBulge', 'Ends, then bulge'],
            ['threePoint', '3 points'],
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
    case 'offset':
      return (
        <div className={styles.row} role="group" aria-label="Offset options">
          <Option
            value="chain"
            current={tool.mode}
            label="Chain"
            onSelect={() => setOption({ mode: 'chain' })}
          />
          <Option
            value="single"
            current={tool.mode}
            label="Single"
            onSelect={() => setOption({ mode: 'single' })}
          />
          {tool.loops.length > 1 ? (
            <span className={styles.count}>
              {tool.loops.length} loops · click an arrow to flip its side
            </span>
          ) : null}
        </div>
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
          ) : (
            <>
              <span className={styles.separator} aria-hidden />
              <Option
                value={1}
                current={tool.directions}
                label="1 direction"
                onSelect={() => setOption({ directions: 1 })}
              />
              <Option
                value={2}
                current={tool.directions}
                label="2 directions"
                onSelect={() => setOption({ directions: 2 })}
              />
              {tool.directions === 2 ? (
                <label className={styles.inlineField}>
                  <span>Count 2</span>
                  <NumberInput
                    aria-label="Pattern count, second direction"
                    value={tool.count2}
                    min={2}
                    max={200}
                    step={1}
                    precision={0}
                    onCommit={(n) => setOption({ count2: n })}
                  />
                </label>
              ) : null}
            </>
          )}
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

/**
 * The font menu of the text panel: the bundled font, then the fonts
 * installed on the computer (desktop app; listed when the panel opens, or on
 * "Show installed fonts" when the platform needs a click for it).
 */
function FontPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [fonts, setFonts] = useState(() => knownSketchFonts());
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const canList = systemFontsAvailable();
  const load = useCallback(() => {
    setState('loading');
    void listSketchFonts().then((list) => {
      setFonts(list);
      setState(list.some((f) => f.source === 'system') ? 'idle' : 'failed');
    });
  }, []);
  const tried = useRef(false);
  useEffect(() => {
    // Once per panel; already listed fonts (an earlier panel) need no new listing.
    if (!canList || tried.current || knownSketchFonts().some((f) => f.source === 'system')) return;
    tried.current = true;
    load();
  }, [canList, load]);
  // A document's font that is not listed here (another computer's installed font) stays visible.
  const options = fonts.some((f) => f.id === value)
    ? fonts
    : [
        ...fonts,
        { id: value, label: `${fontLabel(value)} (not installed)`, source: 'system' as const },
      ];
  return (
    <label className={styles.inlineField}>
      <span>Font</span>
      <Select
        aria-label="Text font"
        wrapClassName={styles.fontSelect}
        value={value}
        options={options.map((f) => ({
          value: f.id,
          label: f.source === 'bundled' ? `${f.label} (bundled)` : f.label,
        }))}
        onChange={(event) => onChange(event.target.value)}
      />
      {canList && state === 'failed' ? (
        <Button variant="secondary" size="small" onClick={load}>
          Show installed fonts
        </Button>
      ) : null}
      {state === 'loading' ? <span className={styles.count}>Loading fonts…</span> : null}
    </label>
  );
}

/** Text content, font, alignment, height and rotation while the Text tool places or edits a text. */
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
  const pickFont = (font: string) => {
    setOption({ font });
    // Loaded for the live preview; a font that fails is reported when the text is placed.
    void loadSketchFont(font)
      .then(() => setOption({ font }))
      .catch(() => undefined);
  };
  const commit = () => void useSketchStore.getState().commitText();
  return (
    <div
      className={`${styles.textPanel} ${styles.textPanelRows}`}
      role="group"
      aria-label="Text"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className={styles.panelRow}>
        <label className={`${fieldStyles.field} ${styles.textField}`}>
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
      <div className={styles.panelRow}>
        <FontPicker value={tool.font} onChange={pickFont} />
        <div className={styles.row} role="radiogroup" aria-label="Text alignment">
          {(
            [
              ['left', 'Align left (anchor at the start)', AlignLeft],
              ['center', 'Align centre (anchor in the middle)', AlignCenter],
              ['right', 'Align right (anchor at the end)', AlignRight],
            ] as const
          ).map(([align, label, Icon]) => (
            <Tooltip key={align} content={label}>
              <button
                type="button"
                role="radio"
                aria-checked={tool.align === align}
                aria-label={label}
                className={`${styles.option} ${tool.align === align ? styles.optionActive : ''}`}
                onClick={() => setOption({ align })}
              >
                <Icon size={13} aria-hidden />
              </button>
            </Tooltip>
          ))}
        </div>
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
      </div>
    </div>
  );
}

/**
 * Shapr3D: selecting an element of a sketch pattern brings its controls
 * back. With the Select tool and a pattern element selected, its count
 * (and second count / total angle) can be changed; the copies are rebuilt
 * as one undo step.
 */
function PatternPanel({ session }: { session: SketchSession }): JSX.Element | null {
  const pattern = selectedPattern(session);
  if (!pattern) return null;
  const edit = (patch: PatternPatch) =>
    void useSketchStore.getState().editPattern(pattern.id, patch);
  return (
    <div
      className={`${styles.textPanel} ${styles.centered}`}
      role="group"
      aria-label="Pattern"
      data-sketch-pattern-panel=""
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className={styles.panelTitle}>
        {pattern.kind === 'linear' ? 'Linear pattern' : 'Circular pattern'}
      </span>
      <label className={styles.inlineField}>
        <span>Count</span>
        <NumberInput
          aria-label="Pattern count"
          value={pattern.count}
          min={2}
          max={200}
          step={1}
          precision={0}
          onCommit={(n) => edit({ count: n })}
        />
      </label>
      {pattern.count2 !== undefined ? (
        <label className={styles.inlineField}>
          <span>Count 2</span>
          <NumberInput
            aria-label="Pattern count, second direction"
            value={pattern.count2}
            min={2}
            max={200}
            step={1}
            precision={0}
            onCommit={(n) => edit({ count2: n })}
          />
        </label>
      ) : null}
      {pattern.kind === 'circular' ? (
        <label className={styles.inlineField}>
          <span>Angle</span>
          <NumberInput
            aria-label="Pattern angle"
            value={pattern.angle ?? 360}
            min={-360}
            max={360}
            step={15}
            unit="°"
            onCommit={(n) => edit({ angle: n })}
          />
        </label>
      ) : (
        <span className={styles.count}>Spacing: edit its dimension</span>
      )}
    </div>
  );
}

/** The recorded pattern the sketch selection belongs to (Select tool only). */
export function selectedPattern(session: SketchSession): SketchPattern | null {
  if (session.tool.kind !== 'select') return null;
  for (const id of session.selection) {
    const pattern = patternOf(session.sketch, id);
    if (pattern) return pattern;
  }
  return null;
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
      <PatternPanel session={session} />
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

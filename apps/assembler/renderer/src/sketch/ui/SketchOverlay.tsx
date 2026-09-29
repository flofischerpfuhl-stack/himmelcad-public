/**
 * Sketch mode drawing surface, layered over the 3D viewport while a sketch
 * session is open. Draws the sketch in screen space (SVG) from the sketch
 * frame projected with the live camera: detected profiles, curves coloured
 * by constraint state (blue under-constrained, green fully constrained,
 * red conflicting, orange selected, dashed construction), constraint
 * glyphs, dimension annotations with editable value chips, the active
 * tool's rubber band, snap point, inference hints and guidelines.
 *
 * Input: left button draws/selects/drags (right/middle/wheel fall through
 * to the viewport camera). Keyboard: Delete, Enter, digits (open the tool's
 * value chip); Escape is a rung of the shared escape ladder.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { registerEscapeRung } from '@himmelcad/ui';

import { useAssemblerStore } from '../../model/store.js';
import { boxModeFor, normalizeRect } from '../../viewport/boxSelect.js';
import { DimensionLabel } from '../../viewport/DimensionLabel.js';
import { SelectionBox } from '../../viewport/SelectionBox.js';
import {
  SKETCH_BOX_FILTERS,
  nextSketchBoxFilter,
  sketchBoxFilterForKey,
  sketchBoxSelect,
  type SketchBoxFilter,
} from './sketchBoxSelect.js';
import { constraintInfo } from '../constraintRules.js';
import { entityCurve, sampleCurve } from '../geometry.js';
import {
  hitTest,
  infer,
  type Inference,
  type InferenceHint,
  type SketchHit,
} from '../inference.js';
import { constraintAnchor, dimensionLayout, formatDimension } from '../measure.js';
import { detectRegions, loopPolygon } from '../regions.js';
import { useSketchStore } from '../session.js';
import { segmentStart, toolInProgress, toolPreview, type ValueField } from '../tools.js';
import { curvePointIds, entityMap, isCurve, type SketchData, type Vec2 } from '../types.js';
import styles from './SketchOverlay.module.css';

/** Screen mapping of the sketch plane, provided by the viewport. */
export interface SketchViewApi {
  /** Sketch (u, v) → CSS pixels relative to the viewport host, `null` behind the camera. */
  toScreen: (uv: Vec2) => [number, number] | null;
  /** Client pixel → sketch (u, v) on the sketch plane, `null` when the ray misses it. */
  fromClient: (clientX: number, clientY: number) => Vec2 | null;
  /** The planar body face under a client pixel (to move a new sketch onto it). */
  pickPlanarFace: (clientX: number, clientY: number) => { bodyId: string; faceKey: string } | null;
  width: number;
  height: number;
}

const HINT_TEXT: Record<InferenceHint, string> = {
  endpoint: 'Endpoint',
  center: 'Center',
  origin: 'Origin',
  midpoint: 'Midpoint',
  on: 'On curve',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  perpendicular: 'Perpendicular',
  parallel: 'Parallel',
  grid: '',
};

/** Constraint glyphs drawn even when their geometry is not selected. */
const ALWAYS_SHOWN = new Set<string>([
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
  'fixed',
  'midpoint',
]);

const FIELD_LABEL: Record<ValueField, string> = {
  length: 'Length',
  radius: 'Radius',
  diameter: 'Diameter',
  width: 'Width',
  height: 'Height',
  distance: 'Offset distance',
};

interface DragGesture {
  pointerId: number;
  startClient: [number, number];
  startUv: Vec2;
  pointIds: string[];
  starts: Vec2[];
  hit: SketchHit | null;
  additive: boolean;
  moved: boolean;
  /** Started on empty space with the Select tool: a selection box. */
  box: boolean;
}

interface SketchBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  filter: SketchBoxFilter;
}

const SKETCH_FILTER_CHIPS: Record<SketchBoxFilter, { label: string; key: string }> = {
  all: { label: 'All', key: 'A' },
  curves: { label: 'Curves', key: 'E' },
  points: { label: 'Points', key: 'P' },
};

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function pathOf(points: readonly Vec2[], api: SketchViewApi, close = false): string | null {
  let d = '';
  for (const [i, p] of points.entries()) {
    const s = api.toScreen(p);
    if (!s) return null;
    d += `${i === 0 ? 'M' : 'L'}${s[0].toFixed(1)} ${s[1].toFixed(1)}`;
  }
  return close ? `${d}Z` : d;
}

/** Millimetres per screen pixel near `uv`. */
function mmPerPxAt(api: SketchViewApi, uv: Vec2): number {
  const a = api.toScreen(uv);
  const b = api.toScreen([uv[0] + 1, uv[1]]);
  const c = api.toScreen([uv[0], uv[1] + 1]);
  if (!a || !b || !c) return 1;
  const px = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
  return px > 1e-9 ? 1 / px : 1;
}

export function SketchOverlay({
  api,
  tick,
}: {
  api: SketchViewApi;
  tick: number;
}): JSX.Element | null {
  const session = useSketchStore((s) => s.session);
  const view = useAssemblerStore((s) => s.viewState);
  const rootRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [chipEditing, setChipEditing] = useState(false);
  const [chipRequest, setChipRequest] = useState<{
    nonce: number;
    text: string;
    field: ValueField;
  } | null>(null);
  const dragRef = useRef<DragGesture | null>(null);
  const [box, setBox] = useState<SketchBox | null>(null);
  const boxRef = useRef<SketchBox | null>(null);
  boxRef.current = box;
  void tick;

  // While a box is dragged: Tab cycles the filter, A/E/P choose it, Escape cancels.
  const boxActive = box !== null;
  useEffect(() => {
    if (!boxActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        dragRef.current = null;
        setBox(null);
        return;
      }
      const current = boxRef.current;
      if (!current) return;
      const next =
        event.key === 'Tab'
          ? nextSketchBoxFilter(current.filter, event.shiftKey)
          : event.ctrlKey || event.metaKey || event.altKey
            ? null
            : sketchBoxFilterForKey(event.key);
      if (!next) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setBox((b) => (b ? { ...b, filter: next } : b));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [boxActive]);

  const display: SketchData | null = session ? (session.dragPreview ?? session.sketch) : null;
  const regions = useMemo(() => (display ? detectRegions(display) : []), [display]);
  const map = useMemo(() => (display ? entityMap(display) : new Map()), [display]);

  const tool = session?.tool ?? null;
  const drawing = tool !== null && tool.kind !== 'select';
  const scale = mmPerPxAt(api, cursor ?? [0, 0]);
  const grid = view.snapToGrid ? view.gridStep : null;
  const inference: Inference | null =
    session && display && cursor && drawing
      ? infer(display, cursor, {
          mmPerPx: scale,
          ...(segmentStart(display, session.tool)
            ? { from: segmentStart(display, session.tool)! }
            : {}),
          gridStep: grid,
        })
      : null;
  const hit = display && cursor ? hitTest(display, cursor, scale) : null;
  const preview = session && display && tool ? toolPreview(display, tool, inference, hit) : null;

  // ---- keyboard ------------------------------------------------------------------------
  const active = session !== null;
  useEffect(() => {
    if (!active) return;
    const unregister = registerEscapeRung('tool', () => useSketchStore.getState().escape(), {
      order: 10,
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const store = useSketchStore.getState();
      const s = store.session;
      if (!s) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (s.selection.length === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void store.deleteSelection();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (toolInProgress(s.tool)) void store.dispatch({ type: 'finish' });
        else void store.finish();
        return;
      }
      if (/^[0-9.]$/.test(event.key)) {
        const chips = chipFieldsRef.current;
        if (chips.length === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        setChipRequest((previous) => ({
          nonce: (previous?.nonce ?? 0) + 1,
          text: event.key,
          field: chips[0]!,
        }));
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [active]);

  const chipFieldsRef = useRef<ValueField[]>([]);
  chipFieldsRef.current =
    tool && toolInProgress(tool) && preview ? preview.chips.map((c) => c.field) : [];

  // Leaving the tool clears transient input state.
  const toolKind = tool?.kind;
  useEffect(() => {
    setChipRequest(null);
    setChipEditing(false);
  }, [toolKind]);

  // A new dimension opens its value chip once its label is mounted (the label ignores the request it mounts with).
  const [editNonce, setEditNonce] = useState(0);
  const editDimensionId = session?.editDimensionId ?? null;
  useEffect(() => {
    if (editDimensionId) setEditNonce((n) => n + 1);
  }, [editDimensionId]);

  if (!session || !display) return null;

  // ---- pointer ---------------------------------------------------------------------------
  const uvOf = (event: React.PointerEvent | React.MouseEvent): Vec2 | null =>
    api.fromClient(event.clientX, event.clientY);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return; // camera buttons fall through to the viewport
    event.stopPropagation();
    const store = useSketchStore.getState();
    const s = store.session;
    if (!s) return;
    if (
      s.tool.kind !== 'select' &&
      s.isNew &&
      !s.planeLocked &&
      s.sketch.entities.length === 0 &&
      !toolInProgress(s.tool)
    ) {
      const face = api.pickPlanarFace(event.clientX, event.clientY);
      if (face && store.rebaseOnFace(face.bodyId, face.faceKey)) return;
    }
    const uv = uvOf(event);
    if (!uv) return;
    const current = s.dragPreview ?? s.sketch;
    const px = mmPerPxAt(api, uv);
    if (s.tool.kind !== 'select') {
      const from = segmentStart(current, s.tool);
      const snap = infer(current, uv, { mmPerPx: px, ...(from ? { from } : {}), gridStep: grid });
      void store.dispatch({ type: 'click', snap, hit: hitTest(current, uv, px), raw: uv });
      return;
    }
    const target = hitTest(current, uv, px);
    const m = entityMap(current);
    let pointIds: string[] = [];
    if (target?.kind === 'point') pointIds = [target.id];
    else if (target?.kind === 'curve') {
      const e = m.get(target.id);
      if (isCurve(e))
        pointIds =
          e.kind === 'circle'
            ? [e.center]
            : e.kind === 'arc'
              ? [e.center, e.start, e.end]
              : curvePointIds(e);
    }
    const starts = pointIds.map((id) => {
      const p = m.get(id);
      return (p?.kind === 'point' ? [p.x, p.y] : uv) as Vec2;
    });
    rootRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClient: [event.clientX, event.clientY],
      startUv: uv,
      pointIds,
      starts,
      hit: target,
      additive: event.shiftKey,
      moved: false,
      box: target === null,
    };
  };

  /** Box corners relative to the overlay (the same space as `api.toScreen`). */
  const boxFromDrag = (drag: DragGesture, clientX: number, clientY: number): SketchBox | null => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x0: drag.startClient[0] - rect.left,
      y0: drag.startClient[1] - rect.top,
      x1: clientX - rect.left,
      y1: clientY - rect.top,
      filter: boxRef.current?.filter ?? 'all',
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const uv = uvOf(event);
    const drag = dragRef.current;
    if (drag) {
      if (
        !drag.moved &&
        Math.hypot(event.clientX - drag.startClient[0], event.clientY - drag.startClient[1]) > 3
      ) {
        drag.moved = true;
        if (drag.pointIds.length > 0) {
          const store = useSketchStore.getState();
          if (drag.hit) store.select([drag.hit.id]);
          store.beginDrag(drag.pointIds);
        }
      }
      if (drag.moved && drag.box) setBox(boxFromDrag(drag, event.clientX, event.clientY));
      if (drag.moved && uv && drag.pointIds.length > 0) {
        const delta: Vec2 = [uv[0] - drag.startUv[0], uv[1] - drag.startUv[1]];
        useSketchStore
          .getState()
          .drag(drag.starts.map((p) => [p[0] + delta[0], p[1] + delta[1]] as Vec2));
      }
    }
    if (!chipEditing) setCursor(uv);
    const s = useSketchStore.getState().session;
    const current = s ? (s.dragPreview ?? s.sketch) : null;
    if (uv && current) {
      const h = hitTest(current, uv, mmPerPxAt(api, uv));
      setHoverId(h?.id ?? null);
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const store = useSketchStore.getState();
    if (drag.moved && drag.box) {
      const current = boxRef.current;
      setBox(null);
      const s = store.session;
      if (!current || !s) return;
      const ids = sketchBoxSelect(
        s.dragPreview ?? s.sketch,
        normalizeRect(current.x0, current.y0, current.x1, current.y1),
        boxModeFor(current.x0, current.x1),
        current.filter,
        api.toScreen,
      );
      // Shift adds (the session's additive select toggles, so skip what is selected already).
      if (drag.additive) {
        store.select(
          ids.filter((id) => !s.selection.includes(id)),
          { additive: true },
        );
      } else store.select(ids);
      return;
    }
    if (drag.moved && drag.pointIds.length > 0) {
      void store.endDrag();
      return;
    }
    if (drag.hit) store.select([drag.hit.id], { additive: drag.additive });
    else if (!drag.additive) store.clearSelection();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const s = useSketchStore.getState().session;
    if (s?.tool.kind === 'line') void useSketchStore.getState().dispatch({ type: 'finish' });
  };

  // ---- drawing -----------------------------------------------------------------------------
  const selection = new Set(session.selection);
  const determined = new Set(session.determined ?? []);
  const problemIds = new Set(session.problem?.ids ?? []);
  // Entities referenced by conflicting constraints/dimensions are drawn red.
  const conflictEntities = new Set<string>();
  for (const c of [...display.constraints, ...display.dimensions]) {
    if (!problemIds.has(c.id)) continue;
    for (const ref of c.refs) conflictEntities.add(ref);
  }
  const highlight = new Set(preview?.highlight ?? []);

  const curveClass = (id: string, construction: boolean) =>
    [
      styles.curve,
      determined.has(id) ? styles.determined : '',
      construction ? styles.construction : '',
      hoverId === id ? styles.hovered : '',
      conflictEntities.has(id) ? styles.conflict : '',
      selection.has(id) ? styles.selected : '',
    ].join(' ');

  const regionPaths = regions
    .map((r) => {
      const loops = [r.outer, ...r.holes].map((loop) => pathOf(loopPolygon(loop), api, true));
      return loops.every((l) => l !== null) ? { key: r.key, d: loops.join(' ') } : null;
    })
    .filter((p): p is { key: string; d: string } => p !== null);

  const curves = display.entities.filter(isCurve).map((e) => {
    const curve = entityCurve(map, e);
    const d = curve ? pathOf(sampleCurve(curve), api) : null;
    return d ? { id: e.id, construction: e.construction === true, d } : null;
  });

  const points = display.entities.flatMap((e) => {
    if (e.kind !== 'point') return [];
    const s = api.toScreen([e.x, e.y]);
    return s ? [{ id: e.id, x: s[0], y: s[1] }] : [];
  });

  // Constraint glyphs, stacked when several share an anchor.
  const slots = new Map<string, number>();
  // Line-type constraints are always shown; the rest (equal, point-on, symmetric, …) only
  // for selected/hovered geometry, the selected constraint or a reported problem — like
  // Shapr3D, which keeps a busy sketch readable.
  const glyphs = display.constraints.flatMap((c) => {
    if (c.kind === 'coincident') return [];
    const related =
      selection.has(c.id) ||
      problemIds.has(c.id) ||
      c.refs.some((r) => selection.has(r) || r === hoverId);
    if (!ALWAYS_SHOWN.has(c.kind) && !related) return [];
    // "Equal" marks each of its two curves.
    const parts = c.kind === 'equal' ? c.refs.map((ref) => ({ ...c, refs: [ref] })) : [c];
    return parts.flatMap((part) => {
      const anchor = constraintAnchor(display, part);
      const s = anchor ? api.toScreen(anchor) : null;
      if (!s) return [];
      const slotKey = `${Math.round(s[0] / 8)}:${Math.round(s[1] / 8)}`;
      const slot = slots.get(slotKey) ?? 0;
      slots.set(slotKey, slot + 1);
      return [
        {
          key: `${c.id}:${part.refs[0]}`,
          id: c.id,
          text: constraintInfo(c.kind).glyph,
          x: s[0] + 12 + slot * 18,
          y: s[1] - 12,
        },
      ];
    });
  });

  const offsetMm = 22 * mmPerPxAt(api, [0, 0]);
  const dimensions = display.dimensions.flatMap((d) => {
    const layout = dimensionLayout(display, d, offsetMm);
    if (!layout) return [];
    const anchor = api.toScreen(layout.anchor);
    if (!anchor) return [];
    const lines = layout.lines
      .map(([a, b]) => pathOf([a, b], api))
      .filter((l): l is string => l !== null);
    return [{ d, anchor, lines }];
  });

  const origin = api.toScreen([0, 0]);
  const axisLength = 28 * mmPerPxAt(api, [0, 0]);
  const axisU = api.toScreen([axisLength, 0]);
  const axisV = api.toScreen([0, axisLength]);

  const gridLines = sketchGrid(
    api,
    session.frame.normal,
    session.frame.origin,
    view.gridStep,
    view.gridVisible,
  );

  const snapScreen = inference ? api.toScreen(inference.pos) : null;
  const hintText = inference
    ? inference.hints
        .map((h) => HINT_TEXT[h])
        .filter(Boolean)
        .join(' · ')
    : '';

  const selectDecoration = (id: string, additive: boolean) =>
    useSketchStore.getState().select([id], { additive });

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ${tool?.kind === 'select' ? styles.selectTool : ''}`}
      data-sketch-overlay=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (!dragRef.current) setCursor(null);
      }}
      onDoubleClick={onDoubleClick}
      onContextMenu={(event) => event.preventDefault()}
    >
      {box ? (
        <SelectionBox
          x0={box.x0}
          y0={box.y0}
          x1={box.x1}
          y1={box.y1}
          mode={boxModeFor(box.x0, box.x1)}
          filterLabel={SKETCH_FILTER_CHIPS[box.filter].label}
          filters={SKETCH_BOX_FILTERS.map((f) => ({
            ...SKETCH_FILTER_CHIPS[f],
            active: f === box.filter,
          }))}
          hint="Tab cycles"
        />
      ) : null}
      <svg className={styles.svg} aria-hidden>
        {gridLines.map((g, i) => (
          <path
            key={`g${i}`}
            d={g.d}
            className={`${styles.grid} ${g.major ? styles.gridMajor : ''}`}
          />
        ))}
        {regionPaths.map((r) => (
          <path key={r.key} d={r.d} className={styles.region} />
        ))}
        {origin && axisU ? (
          <line
            x1={origin[0]}
            y1={origin[1]}
            x2={axisU[0]}
            y2={axisU[1]}
            className={styles.axisU}
          />
        ) : null}
        {origin && axisV ? (
          <line
            x1={origin[0]}
            y1={origin[1]}
            x2={axisV[0]}
            y2={axisV[1]}
            className={styles.axisV}
          />
        ) : null}
        {curves.map((c) =>
          c ? (
            <g key={c.id}>
              {highlight.has(c.id) ? <path d={c.d} className={styles.highlight} /> : null}
              <path d={c.d} className={curveClass(c.id, c.construction)} data-entity={c.id} />
            </g>
          ) : null,
        )}
        {dimensions.map(({ d, lines }) => (
          <g key={d.id}>
            {lines.map((l, i) => (
              <g key={i}>
                <path
                  d={l}
                  className={`${styles.dimLine} ${problemIds.has(d.id) ? styles.dimLineConflict : ''} ${selection.has(d.id) ? styles.dimLineSelected : ''}`}
                />
                <path
                  d={l}
                  className={styles.dimHit}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    selectDecoration(d.id, event.shiftKey);
                  }}
                />
              </g>
            ))}
          </g>
        ))}
        {points.map((p) => (
          <circle
            key={p.id}
            cx={p.x}
            cy={p.y}
            r={selection.has(p.id) || hoverId === p.id ? 4.5 : 3.5}
            className={`${styles.point} ${determined.has(p.id) ? styles.pointDetermined : ''} ${selection.has(p.id) ? styles.pointSelected : ''}`}
            data-point={p.id}
          />
        ))}
        {glyphs.map((g) => (
          <g
            key={g.key}
            className={`${styles.glyph} ${selection.has(g.id) ? styles.glyphSelected : ''} ${problemIds.has(g.id) ? styles.glyphConflict : ''}`}
            transform={`translate(${g.x.toFixed(1)} ${g.y.toFixed(1)})`}
            data-constraint={g.id}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              selectDecoration(g.id, event.shiftKey);
            }}
          >
            <rect x={-8} y={-8} width={16} height={16} rx={4} className={styles.glyphBox} />
            <text className={styles.glyphText}>{g.text}</text>
          </g>
        ))}
        {preview?.curves.map((c, i) => {
          const d = pathOf(c, api);
          return d ? <path key={`p${i}`} d={d} className={styles.preview} /> : null;
        })}
        {inference?.guides.map(([a, b], i) => {
          const d = pathOf([a, b], api);
          return d ? <path key={`guide${i}`} d={d} className={styles.guide} /> : null;
        })}
        {snapScreen ? (
          <circle cx={snapScreen[0]} cy={snapScreen[1]} r={4} className={styles.snap} />
        ) : null}
        {snapScreen && hintText ? (
          <text x={snapScreen[0] + 10} y={snapScreen[1] + 20} className={styles.hint}>
            {hintText}
          </text>
        ) : null}
      </svg>
      {dimensions.map(({ d, anchor }) => (
        <DimensionLabel
          key={d.id}
          label={`Dimension ${d.name}`}
          value={d.value}
          display={formatDimension(d)}
          editText={d.expression ?? String(Math.round(d.value * 1000) / 1000)}
          x={anchor[0]}
          y={anchor[1]}
          invalid={problemIds.has(d.id)}
          selected={selection.has(d.id)}
          editRequest={
            session.editDimensionId === d.id
              ? {
                  nonce: editNonce,
                  text: d.expression ?? String(Math.round(d.value * 1000) / 1000),
                }
              : null
          }
          onBeginEdit={() => undefined}
          onCancelEdit={() => useSketchStore.getState().closeDimensionEditor()}
          onCommit={() => undefined}
          onCommitText={(text) => void useSketchStore.getState().setDimension(d.id, text)}
        />
      ))}
      {preview && tool && toolInProgress(tool)
        ? preview.chips.map((chip) => {
            const at = api.toScreen(chip.at);
            if (!at) return null;
            return (
              <DimensionLabel
                key={chip.field}
                label={FIELD_LABEL[chip.field]}
                value={chip.value}
                display={
                  chip.field === 'diameter'
                    ? `Ø ${Math.round(chip.value * 100) / 100}`
                    : `${Math.round(chip.value * 100) / 100}`
                }
                x={at[0] + 16}
                y={at[1] - 16}
                editRequest={chipRequest && chipRequest.field === chip.field ? chipRequest : null}
                onBeginEdit={() => setChipEditing(true)}
                onCancelEdit={() => setChipEditing(false)}
                onCommit={(value) => {
                  const s = useSketchStore.getState().session;
                  if (!s || !inference) return;
                  void useSketchStore
                    .getState()
                    .dispatch({ type: 'value', field: chip.field, value, snap: inference });
                }}
              />
            );
          })
        : null}
    </div>
  );
}

/**
 * Grid lines on the sketch plane when it is not the viewport's own XY grid
 * (sketches on XZ/YZ, offset planes and body faces).
 */
function sketchGrid(
  api: SketchViewApi,
  normal: readonly number[],
  origin: readonly number[],
  step: number,
  visible: boolean,
): { d: string; major: boolean }[] {
  const onWorldGrid = Math.abs(Math.abs(normal[2]!) - 1) < 1e-9 && Math.abs(origin[2]!) < 1e-9;
  if (!visible || onWorldGrid || !(step > 0)) return [];
  const corners = [
    api.fromClient(0, 0),
    api.fromClient(api.width, 0),
    api.fromClient(0, api.height),
    api.fromClient(api.width, api.height),
  ];
  if (corners.some((c) => c === null)) return [];
  const us = corners.map((c) => c![0]);
  const vs = corners.map((c) => c![1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  let s = step;
  while ((u1 - u0) / s > 120 || (v1 - v0) / s > 120) s *= 10;
  const lines: { d: string; major: boolean }[] = [];
  for (let u = Math.ceil(u0 / s) * s; u <= u1; u += s) {
    const d = pathOf(
      [
        [u, v0],
        [u, v1],
      ],
      api,
    );
    if (d) lines.push({ d, major: Math.abs(Math.round(u / (s * 10)) * s * 10 - u) < s / 2 });
  }
  for (let v = Math.ceil(v0 / s) * s; v <= v1; v += s) {
    const d = pathOf(
      [
        [u0, v],
        [u1, v],
      ],
      api,
    );
    if (d) lines.push({ d, major: Math.abs(Math.round(v / (s * 10)) * s * 10 - v) < s / 2 });
  }
  return lines;
}

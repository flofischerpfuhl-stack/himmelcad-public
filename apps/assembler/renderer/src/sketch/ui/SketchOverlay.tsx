/**
 * Sketch mode drawing surface, layered over the 3D viewport while a sketch
 * session is open. Draws the sketch in screen space (SVG) from the sketch
 * frame projected with the live camera: detected profiles, curves coloured
 * by constraint state (blue under-constrained, green fully constrained,
 * red conflicting, orange selected, dashed construction, accent projected
 * geometry — amber when its source is lost), constraint badges and
 * dimension chips laid out without overlaps, the active tool's rubber band
 * and value chips, snap point, inference hints and guidelines.
 *
 * Input: left button draws/selects/drags (right/middle/wheel fall through
 * to the viewport camera). Keyboard: Delete, Enter, digits (open the tool's
 * value chip — digits typed while it opens are kept); Escape is a rung of
 * the shared escape ladder. Badges: click selects, the × on a selected
 * badge or a right-click deletes the constraint. Dimension chips: click
 * selects, double-click edits, Shift+drag moves the label.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { entityCurves, sampleCurve } from '../geometry.js';
import {
  hitTest,
  infer,
  type Inference,
  type InferenceHint,
  type SketchHit,
} from '../inference.js';
import { constraintAnchor, dimensionLayout, formatDimension, layoutForAnchor } from '../measure.js';
import { projectedIds } from '../projection.js';
import { detectRegions, loopPolygon } from '../regions.js';
import { useSketchStore, type ProjectionPick } from '../session.js';
import { DEFAULT_SKETCH_FONT, loadedSketchFont, textOutlineOf } from '../text/fonts.js';
import { parseOutline, placeContours } from '../text/outline.js';
import {
  segmentStart,
  toolInProgress,
  toolPreview,
  type SketchTool,
  type ValueField,
} from '../tools.js';
import {
  curvePointIds,
  entityMap,
  isCurve,
  pointPos,
  type SketchData,
  type SketchDimension,
  type Vec2,
} from '../types.js';
import { chipSize, layoutBadges, layoutChips, nextChipText, type Rect } from './declutter.js';
import { SketchDimensionChip } from './SketchDimensionChip.js';
import styles from './SketchOverlay.module.css';

/** Screen mapping of the sketch plane, provided by the viewport. */
export interface SketchViewApi {
  /** Sketch (u, v) → CSS pixels relative to the viewport host, `null` behind the camera. */
  toScreen: (uv: Vec2) => [number, number] | null;
  /** Client pixel → sketch (u, v) on the sketch plane, `null` when the ray misses it. */
  fromClient: (clientX: number, clientY: number) => Vec2 | null;
  /** The planar body face under a client pixel (to move a new sketch onto it). */
  pickPlanarFace: (clientX: number, clientY: number) => { bodyId: string; faceKey: string } | null;
  /** The body edge (preferred) or face under a client pixel (Project). */
  pickBodyItem?: (clientX: number, clientY: number) => ProjectionPick | null;
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
  count: 'Count',
  spacing: 'Spacing',
  angle: 'Angle',
  major: 'First radius',
  minor: 'Second radius',
  size: 'Size',
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

/** Glyph outlines of the text the Text tool is placing/editing (font loaded), sketch coordinates. */
function textToolPreview(sketch: SketchData, tool: SketchTool, cursor: Vec2 | null): Vec2[][] {
  if (tool.kind !== 'text') return [];
  const t = tool;
  const font = loadedSketchFont(DEFAULT_SKETCH_FONT);
  if (!font || t.text.trim() === '') return [];
  let anchor: Vec2 | null = t.anchor?.pos ?? null;
  if (t.editing) {
    const e = sketch.entities.find((x) => x.id === t.editing);
    anchor = e?.kind === 'text' ? pointPos(entityMap(sketch), e.anchor) : null;
  }
  anchor ??= cursor;
  if (!anchor) return [];
  const outline = textOutlineOf(font, t.text).outline;
  return placeContours(parseOutline(outline), anchor, t.height, t.angle).map((contour) =>
    sampleCurve({ kind: 'bezier', segs: contour }),
  );
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
  const evaluatedSketch = useAssemblerStore((s) =>
    session ? s.evaluation.sketches.find((sk) => sk.featureId === session.featureId) : undefined,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [chipEditing, setChipEditing] = useState(false);
  const [chipRequest, setChipRequest] = useState<{
    nonce: number;
    text: string;
    field: ValueField;
  } | null>(null);
  /** Digits typed while a value chip opens (before its field has focus) — kept, not lost. */
  const pendingChip = useRef<{ field: ValueField; text: string } | null>(null);
  /** Digits typed while a new dimension's field opens. */
  const [dimTypeahead, setDimTypeahead] = useState<string | null>(null);
  const [labelDrag, setLabelDrag] = useState<{
    id: string;
    offset: number;
    along: number;
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
  const projected = useMemo(() => (display ? projectedIds(display) : new Set<string>()), [display]);

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
  const preview =
    session && display && tool
      ? toolPreview(display, tool, inference, hit, { construction: session.construction })
      : null;

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
        if (s.tool.kind === 'text') void store.commitText();
        else if (toolInProgress(s.tool)) void store.dispatch({ type: 'finish' });
        else void store.finish();
        return;
      }
      if (/^[0-9.,-]$/.test(event.key)) {
        // A new dimension is opening its field: keep what is typed meanwhile.
        if (s.editDimensionId) {
          event.preventDefault();
          event.stopImmediatePropagation();
          setDimTypeahead((previous) => (previous ?? '') + event.key);
          return;
        }
        const chips = chipFieldsRef.current;
        if (chips.length === 0 || event.key === ',' || event.key === '-') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // Keys typed before the chip's field has focus extend the text it opens with.
        const next = nextChipText(pendingChip.current, event.key, chips[0]!);
        pendingChip.current = next;
        setChipRequest((previous) => ({ nonce: (previous?.nonce ?? 0) + 1, ...next }));
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
    pendingChip.current = null;
  }, [toolKind]);

  // A new dimension opens its value chip once its label is mounted.
  const [editNonce, setEditNonce] = useState(0);
  const editDimensionId = session?.editDimensionId ?? null;
  useEffect(() => {
    if (editDimensionId) setEditNonce((n) => n + 1);
    else setDimTypeahead(null);
  }, [editDimensionId]);

  const closeDimensionEditor = useCallback(() => {
    setDimTypeahead(null);
    useSketchStore.getState().closeDimensionEditor();
  }, []);

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
      s.tool.kind !== 'project' &&
      s.isNew &&
      !s.planeLocked &&
      s.sketch.entities.length === 0 &&
      !toolInProgress(s.tool)
    ) {
      const face = api.pickPlanarFace(event.clientX, event.clientY);
      if (face && store.rebaseOnFace(face.bodyId, face.faceKey)) return;
    }
    if (s.tool.kind === 'project') {
      const pick = api.pickBodyItem?.(event.clientX, event.clientY) ?? null;
      if (!pick) {
        useSketchStore.setState({
          session: { ...s, notice: 'Click an edge or a face of a body.' },
        });
        return;
      }
      void store.projectItem(pick).then((reason) => {
        const current = useSketchStore.getState().session;
        if (current) useSketchStore.setState({ session: { ...current, notice: reason } });
      });
      return;
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
      if (isCurve(e)) pointIds = curvePointIds(e);
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
    const store = useSketchStore.getState();
    const s = store.session;
    if (!s) return;
    if (s.tool.kind === 'line' || s.tool.kind === 'spline') {
      void store.dispatch({ type: 'finish' });
      return;
    }
    if (s.tool.kind === 'select') {
      const uv = uvOf(event);
      const target = uv ? hitTest(s.sketch, uv, mmPerPxAt(api, uv)) : null;
      const e = target ? s.sketch.entities.find((x) => x.id === target.id) : undefined;
      if (e?.kind === 'text') store.editText(e.id);
    }
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
  const frozenProjections = new Set(
    (evaluatedSketch?.projections ?? []).filter((p) => p.status !== 'ok').map((p) => p.id),
  );
  const frozenEntities = new Set(
    (display.projections ?? [])
      .filter((p) => frozenProjections.has(p.id))
      .flatMap((p) => p.entities),
  );

  const curveClass = (id: string, construction: boolean) =>
    [
      styles.curve,
      determined.has(id) ? styles.determined : '',
      construction ? styles.construction : '',
      projected.has(id) ? styles.projected : '',
      frozenEntities.has(id) ? styles.projectedFrozen : '',
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
    const parts = entityCurves(map, e)
      .map(({ curve }) => pathOf(sampleCurve(curve), api))
      .filter((d): d is string => d !== null);
    return parts.length > 0
      ? { id: e.id, construction: e.construction === true, d: parts.join(' ') }
      : null;
  });

  // Control polygons of control-point splines (and handles of selected fit splines).
  const controlPolygons = display.entities.flatMap((e) => {
    if (e.kind !== 'spline') return [];
    const related = selection.has(e.id) || e.points.some((p) => selection.has(p));
    if (e.mode === 'control') {
      const pts = e.points.map((p) => pointPos(map, p)).filter((p): p is Vec2 => p !== null);
      const d = pathOf(pts, api);
      return d ? [{ key: e.id, d }] : [];
    }
    if (!related || !e.handles) return [];
    const out: { key: string; d: string }[] = [];
    const [h0, h1] = e.handles;
    const first = pointPos(map, e.points[0]!);
    const last = pointPos(map, e.points[e.points.length - 1]!);
    const p0 = h0 ? pointPos(map, h0) : null;
    const p1 = h1 ? pointPos(map, h1) : null;
    const d0 = first && p0 ? pathOf([first, p0], api) : null;
    const d1 = last && p1 ? pathOf([last, p1], api) : null;
    if (d0) out.push({ key: `${e.id}:h0`, d: d0 });
    if (d1) out.push({ key: `${e.id}:h1`, d: d1 });
    return out;
  });
  const handleIds = new Set(
    display.entities.flatMap((e) =>
      e.kind === 'spline' && e.handles ? e.handles.filter((h): h is string => h !== null) : [],
    ),
  );

  const points = display.entities.flatMap((e) => {
    if (e.kind !== 'point') return [];
    const s = api.toScreen([e.x, e.y]);
    return s ? [{ id: e.id, x: s[0], y: s[1] }] : [];
  });

  // ---- dimension chips and constraint badges (de-cluttered) ------------------------------
  const offsetMm = 22 * mmPerPxAt(api, [0, 0]);
  const dimensionView = (d: SketchDimension): SketchDimension =>
    labelDrag && labelDrag.id === d.id
      ? { ...d, offset: labelDrag.offset, along: labelDrag.along }
      : d;
  const dimensions = display.dimensions.flatMap((raw) => {
    const d = dimensionView(raw);
    const layout = dimensionLayout(display, d, offsetMm);
    if (!layout) return [];
    const anchor = api.toScreen(layout.anchor);
    if (!anchor) return [];
    const lines = layout.lines
      .map(([a, b]) => pathOf([a, b], api))
      .filter((l): l is string => l !== null);
    // Push direction: the label's offset direction on screen (away from its geometry).
    const base = layout.lines[layout.lines.length - 1];
    let push: [number, number] = [0, -1];
    if (base) {
      const s0 = api.toScreen(base[0]);
      const s1 = api.toScreen(base[1]);
      if (s0 && s1) {
        const dx = s1[0] - s0[0];
        const dy = s1[1] - s0[1];
        const l = Math.hypot(dx, dy) || 1;
        push = [-dy / l, dx / l];
      }
    }
    const text = raw.driven ? `(${formatDimension(raw)})` : formatDimension(raw);
    return [
      {
        d: raw,
        anchor,
        lines,
        text,
        push,
        pinned: raw.along !== undefined || labelDrag?.id === raw.id,
      },
    ];
  });
  const chipPlaces = layoutChips(
    dimensions.map((x) => ({
      id: x.d.id,
      x: x.anchor[0],
      y: x.anchor[1],
      ...chipSize(x.text),
      push: x.push,
      pinned: x.pinned,
    })),
  );
  const chipRects: Rect[] = dimensions.map((x) => ({
    ...(chipPlaces.get(x.d.id) ?? { x: x.anchor[0], y: x.anchor[1] }),
    ...chipSize(x.text),
  }));

  // Line-type constraints are always shown; the rest (equal, point-on, symmetric, coincident, …)
  // only for selected/hovered geometry, the selected constraint or a reported problem — like
  // Shapr3D, which keeps a busy sketch readable.
  const badgeInputs = display.constraints.flatMap((c) => {
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
      return [{ key: `${c.id}:${part.refs[0]}`, id: c.id, kind: c.kind, x: s[0], y: s[1] }];
    });
  });
  const badgePlaces = layoutBadges(badgeInputs, chipRects);
  const glyphs = badgeInputs.map((b) => {
    const place = badgePlaces.get(b.key) ?? { x: b.x + 12, y: b.y - 12 };
    return { ...b, text: constraintInfo(b.kind).glyph, x: place.x, y: place.y };
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
  const removeConstraint = (id: string) => {
    const store = useSketchStore.getState();
    store.select([id]);
    void store.deleteSelection();
  };

  const textPreview = tool ? textToolPreview(display, tool, cursor) : [];

  /** Shift+drag of a dimension chip: screen delta → label layout in the sketch plane. */
  const moveLabel = (
    d: SketchDimension,
    anchorScreen: [number, number],
    dx: number,
    dy: number,
    done: boolean,
  ) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const uv = api.fromClient(rect.left + anchorScreen[0] + dx, rect.top + anchorScreen[1] + dy);
    if (!uv) return;
    const layout = layoutForAnchor(display, d, uv);
    if (!layout) return;
    if (done) {
      setLabelDrag(null);
      void useSketchStore.getState().moveDimensionLabel(d.id, layout);
    } else setLabelDrag({ id: d.id, ...layout });
  };

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
        {controlPolygons.map((c) => (
          <path key={c.key} d={c.d} className={styles.controlPolygon} />
        ))}
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
                  className={`${styles.dimLine} ${d.driven ? styles.dimLineDriven : ''} ${problemIds.has(d.id) ? styles.dimLineConflict : ''} ${selection.has(d.id) ? styles.dimLineSelected : ''}`}
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
            r={selection.has(p.id) || hoverId === p.id ? 4.5 : handleIds.has(p.id) ? 3 : 3.5}
            className={`${styles.point} ${handleIds.has(p.id) ? styles.pointHandle : ''} ${determined.has(p.id) ? styles.pointDetermined : ''} ${selection.has(p.id) ? styles.pointSelected : ''}`}
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
            onContextMenu={(event) => {
              // Right-click on a badge deletes that constraint (one undo step).
              event.preventDefault();
              event.stopPropagation();
              removeConstraint(g.id);
            }}
          >
            <rect x={-8} y={-8} width={16} height={16} rx={4} className={styles.glyphBox} />
            <text className={styles.glyphText}>{g.text}</text>
          </g>
        ))}
        {glyphs
          .filter((g) => selection.has(g.id) && session.selection.length === 1)
          .slice(0, 1)
          .map((g) => (
            <g
              key={`del-${g.key}`}
              className={styles.glyphDelete}
              transform={`translate(${(g.x + 14).toFixed(1)} ${(g.y - 10).toFixed(1)})`}
              data-constraint-delete={g.id}
              role="button"
              aria-label={`Delete ${constraintInfo(g.kind).label} constraint`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                removeConstraint(g.id);
              }}
            >
              <circle r={7} className={styles.glyphDeleteBox} />
              <path d="M-3 -3L3 3M3 -3L-3 3" className={styles.glyphDeleteMark} />
            </g>
          ))}
        {preview?.curves.map((c, i) => {
          const d = pathOf(c, api);
          return d ? <path key={`p${i}`} d={d} className={styles.preview} /> : null;
        })}
        {textPreview.map((c, i) => {
          const d = pathOf(c, api, true);
          return d ? <path key={`t${i}`} d={d} className={styles.preview} /> : null;
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
      {dimensions.map(({ d, anchor, text }) => {
        const place = chipPlaces.get(d.id) ?? { x: anchor[0], y: anchor[1] };
        const editText = d.expression ?? String(Math.round(d.value * 1000) / 1000);
        const typing = session.editDimensionId === d.id ? dimTypeahead : null;
        return (
          <SketchDimensionChip
            key={d.id}
            name={d.name}
            display={text.replace(/^\((.*)\)$/, '$1')}
            editText={typing ?? editText}
            driven={d.driven === true}
            selected={selection.has(d.id)}
            invalid={problemIds.has(d.id)}
            x={place.x}
            y={place.y}
            editRequest={
              session.editDimensionId === d.id ? editNonce + (typing?.length ?? 0) * 1000 : null
            }
            onSelect={(additive) => selectDecoration(d.id, additive)}
            onCommitText={(value) => void useSketchStore.getState().setDimension(d.id, value)}
            onEditClosed={closeDimensionEditor}
            onMove={(dx, dy, done) => moveLabel(d, [place.x, place.y], dx, dy, done)}
          />
        );
      })}
      {preview && tool && toolInProgress(tool)
        ? preview.chips.map((chip, index) => {
            const at = api.toScreen(chip.at);
            if (!at) return null;
            const angle = chip.field === 'angle';
            const count = chip.field === 'count';
            return (
              <DimensionLabel
                key={chip.field}
                label={FIELD_LABEL[chip.field]}
                value={chip.value}
                unit={angle ? '°' : count ? '' : 'mm'}
                display={
                  chip.field === 'diameter'
                    ? `Ø ${Math.round(chip.value * 100) / 100}`
                    : count
                      ? `× ${Math.round(chip.value)}`
                      : angle
                        ? `${Math.round(chip.value * 100) / 100}°`
                        : `${Math.round(chip.value * 100) / 100}`
                }
                x={at[0] + 16}
                y={at[1] - 16 + index * 26}
                editRequest={chipRequest && chipRequest.field === chip.field ? chipRequest : null}
                onBeginEdit={() => setChipEditing(true)}
                onCancelEdit={() => {
                  setChipEditing(false);
                  pendingChip.current = null;
                }}
                onCommit={(value) => {
                  pendingChip.current = null;
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

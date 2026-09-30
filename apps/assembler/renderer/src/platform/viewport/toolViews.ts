/**
 * The tool-handle provider of the viewport (assembler/MODULES.md §3
 * `viewportTools`): what the running tool shows and how its handles react,
 * contributed by the module that owns the tool session
 * (`ToolSessionMap`/`registerToolKind` in `commands/store.ts`). The
 * viewport draws and hit-tests the handles, runs the drags and renders the
 * value chips; it never names a tool. The core's generic feature tool gets
 * its view from the drafts (`featureToolView.ts`).
 *
 * A module registers providers through its UI part:
 * `defineModuleUi({ viewportTools: [{ kinds: ['extrude'], view, … }] })`.
 */
import type { AssemblerState, SelectionItem } from '../../foundation/commands/store.js';
import type {
  Body,
  EvaluatedSketch,
  EvaluationResult,
} from '../../foundation/geometry-kernel/types.js';
import type { Vec3 } from './math.js';
import type { PickTarget, ToolHandleKind } from './picking.js';
import type { AngleHandleState } from './scene.js';
import type { AxisHandle } from './section.js';

/** A value chip (dimension label) at a world point. */
export interface ToolChip {
  handle: ToolHandleKind;
  label: string;
  prefix?: string;
  unit: 'mm' | 'deg' | 'count';
  value: number;
  /** World anchor of the chip. */
  at: Vec3;
}

/** The running tool's handles: axis arrows, angle arcs/rings, value chips, guides, gizmo centre. */
export interface ToolHandleSet {
  axis: AxisHandle[];
  angles: Omit<AngleHandleState, 'hovered'>[];
  chips: ToolChip[];
  guides: { lines: [Vec3, Vec3][]; planes: [Vec3, Vec3, Vec3, Vec3][] } | null;
  pivot: Vec3 | null;
}

export const EMPTY_TOOL_HANDLES: ToolHandleSet = {
  axis: [],
  angles: [],
  chips: [],
  guides: null,
  pivot: null,
};

/** A dimension label the viewport renders for the tool (screen position from `at`). */
export interface ToolLabel {
  key: string;
  label: string;
  prefix?: string;
  unit?: 'mm' | 'deg' | 'count';
  value: number;
  at: Vec3;
  /** Shown in the error style (the current parameters fail). */
  invalid?: boolean;
  /** Typing a number while the tool waits for a value opens this label (at most one per tool). */
  takesTyping?: boolean;
  /** A typed value; default: the handle's value (`applyHandleValue`, no drag snapping). */
  commit?: (value: number) => void;
  /** The handle whose value a default commit sets. */
  handle?: ToolHandleKind;
}

/** Everything the viewport shows for the running tool (all optional). */
export interface ToolView {
  /** Bodies drawn instead of the evaluated ones (Move/Rotate): the result, its new ids and ghosts. */
  bodies?(bodies: readonly Body[]): { bodies: Body[]; newIds: string[]; ghosts: Body[] };
  /** Sketches drawn instead of the evaluated ones (a profile moved with the gizmo). */
  sketches?(sketches: readonly EvaluatedSketch[]): EvaluatedSketch[];
  /** Sketches drawn even when consumed (the profile being extruded). */
  shownSketchIds?: readonly string[];
  /** The body of an extrude-style preview (translucent, accent outline). */
  extrudePreviewBodyId?: string | null;
  /** Bodies of a preview drawn opaque with accent edges. */
  previewAccentBodyIds?: string[];
  /** Faces created by the provisional feature (their keys start with this) get an accent tint. */
  previewFaceKeyPrefix?: string | null;
  /** Committed bodies drawn as faint outlines (consumed tool bodies, the old place of moved bodies). */
  ghostBodies?: Body[];
  /** Bodies the tool creates (translucent, preview accent). */
  previewNewBodyIds?: string[];
  handles?: ToolHandleSet;
  /** Extrude-style distance arrow. */
  arrow?: { origin: Vec3; normal: Vec3; distance: number } | null;
  /** Move gizmo (translation arrows and plane tiles; its rings are angle handles). */
  gizmo?: {
    origin: Vec3;
    delta: { dx: number; dy: number; dz: number };
    axes?: [Vec3, Vec3, Vec3];
    hiddenAxes?: (0 | 1 | 2)[];
    tiles: (0 | 1 | 2)[];
  } | null;
  /** Construction planes/axes the tool references (highlighted). */
  datumIds?: readonly string[];
  /** Straight sketch lines become pickable (the tool takes an axis or a line). */
  pickSketchLines?: boolean;
  /** Typing a number opens a value label (`negative`: `-` starts one too). */
  typedValue?: { negative: boolean } | null;
  /** Value labels (dimension chips) of the tool. */
  labels?: ToolLabel[];
}

export interface ToolViewInput {
  state: AssemblerState;
  /** The tool's kernel preview, else `null`. */
  preview: EvaluationResult | null;
}

/** A running handle drag; `move` gets every pointer move. */
export interface ToolDrag {
  move(input: ToolPointer): void;
  /** Hide the gizmo's arrows and rings while dragging (the gizmo centre is being placed). */
  hidesGizmo?: boolean;
}

export interface ToolPointer {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  ray: { origin: Vec3; direction: Vec3 } | null;
  pickAt(clientX: number, clientY: number): PickTarget | null;
  rayAt(clientX: number, clientY: number): { origin: Vec3; direction: Vec3 } | null;
}

export interface ToolClick {
  state: AssemblerState;
  pick: PickTarget | null;
  /** The selection item the click stands for (a double-click selects whole bodies). */
  item: SelectionItem | null;
  isDouble: boolean;
}

export interface ViewportToolProvider {
  /** Tool session kinds (`ToolSessionMap` keys) this provider serves. */
  kinds: readonly string[];
  view(input: ToolViewInput): ToolView;
  /** A press on one of the tool's own pick targets (arrow, gizmo, centre) starts a drag. */
  beginDrag?(pick: PickTarget, pointer: ToolPointer, state: AssemblerState): ToolDrag | null;
  /** Writes a dragged or typed handle value; `false` if the handle is not the provider's. */
  applyHandleValue?(handle: ToolHandleKind, value: number, snap: boolean): boolean;
  /** A click while the tool runs; `true` if handled (else the click selects as usual). */
  click?(click: ToolClick): boolean;
}

const providers = new Map<string, ViewportToolProvider>();

export function registerViewportTool(provider: ViewportToolProvider): void {
  for (const kind of provider.kinds) {
    if (providers.has(kind)) throw new Error(`Viewport tool "${kind}" is registered twice`);
    providers.set(kind, provider);
  }
}

/** The provider of a running tool kind, or `undefined`. */
export function viewportToolFor(kind: string | undefined): ViewportToolProvider | undefined {
  return kind === undefined ? undefined : providers.get(kind);
}

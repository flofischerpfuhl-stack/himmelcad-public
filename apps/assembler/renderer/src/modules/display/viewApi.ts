/**
 * Visual feedback for agents (`hcasm.agent-api@1`, assembler/AGENT-API.md
 * "View renders"): `view.render` draws the model from a named view or an
 * azimuth/elevation into a PNG — isolated bodies, highlighted bodies/faces/
 * edges, a section, a display mode and overlays such as the printability
 * findings — and `view.inspect` bundles standard views with a JSON manifest
 * of the bodies.
 *
 * Both are queries: they never move the user's camera or change the view
 * state. In the app the offscreen GPU renderer of the mounted viewport draws
 * them (`viewportUi.ts` `renderViewportImage`, with scene overrides); in the
 * headless CLI, tests and wherever no viewport is mounted the software
 * rasterizer (`platform/viewport/softRender.ts`) does, so both transports
 * answer the same request.
 */
import type { ApiContext, Json, MethodSpec } from '../../foundation/commands/api/contract.js';
import { describeBody } from '../../foundation/commands/api/describe.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import {
  API_ORDER,
  apiMethodHandler,
  type ApiContribution,
  type ApiHandler,
} from '../../foundation/commands/api/registry.js';
import type { JsonSchema } from '../../foundation/commands/api/validate.js';
import type { SelectionItem } from '../../foundation/commands/store.js';
import type { Body, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import {
  cameraBasis,
  presetPose,
  type Bounds,
  type CameraPose,
  type CameraPresetName,
} from '../../platform/viewport/camera.js';
import type { FlatBatch } from '../../platform/viewport/gl.js';
import { expandBody } from '../../platform/viewport/geometry.js';
import type { Vec3 } from '../../platform/viewport/math.js';
import { encodeRgbaPng } from '../../platform/viewport/png.js';
import type { SceneInput } from '../../platform/viewport/scene.js';
import { sectionClip } from '../../platform/viewport/section.js';
import {
  ACCENT,
  meshBounds,
  softRender,
  type Rgb,
  type SoftBackground,
  type SoftRenderBody,
  type SoftRenderMode,
} from '../../platform/viewport/softRender.js';
import { currentViewportSize, renderViewportImage } from '../../platform/viewport/viewportUi.js';

// ---- limits -------------------------------------------------------------------------------

/** Largest image side of one render, px. */
export const MAX_RENDER_SIDE = 2048;
/** Pixel budget of one `view.inspect` bundle (all views together). */
export const MAX_INSPECT_PIXELS = 4 * 1024 * 1024;
export const MAX_INSPECT_VIEWS = 8;
/** Findings listed in a result (the image shows all of them). */
const MAX_LISTED_FINDINGS = 24;

// ---- schema -------------------------------------------------------------------------------

export const VIEW_NAMES = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

const str: JsonSchema = { type: 'string', minLength: 1 };
const vec3: JsonSchema = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const VIEW_SCHEMA: JsonSchema = {
  oneOf: [
    { enum: [...VIEW_NAMES] },
    obj(
      {
        azimuth: {
          type: 'number',
          description:
            'Degrees; direction from the model towards the eye, from +X towards +Y (front = -90).',
        },
        elevation: {
          type: 'number',
          minimum: -90,
          maximum: 90,
          description: 'Degrees above the XY plane.',
        },
      },
      ['azimuth', 'elevation'],
    ),
  ],
  description:
    'A named view (iso, front = looking along +Y, back, left, right, top = looking down -Z, bottom) or {azimuth, elevation} in degrees.',
};

const COLOR_SCHEMA: JsonSchema = {
  oneOf: [
    { enum: ['red', 'amber', 'green', 'blue', 'violet', 'accent'] },
    { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
  ],
};

const SHARED_PARAMS: Record<string, JsonSchema> = {
  bodyIds: {
    type: 'array',
    items: str,
    minItems: 1,
    description: 'Isolate: only these bodies are drawn and framed (default: every body).',
  },
  section: {
    oneOf: [
      obj(
        {
          axis: { enum: ['x', 'y', 'z'] },
          offset: { type: 'number', description: 'Plane position along the axis, mm (default 0).' },
          flip: { type: 'boolean', description: 'Keep the positive side instead.' },
        },
        ['axis'],
      ),
      obj({ origin: vec3, normal: vec3, flip: { type: 'boolean' } }, ['origin', 'normal']),
    ],
    description:
      'Section cut: material on the positive side of the plane (axis or normal) is removed, unless `flip`.',
  },
  displayMode: {
    enum: ['shaded', 'shadedEdges', 'wireframe', 'xray'],
    default: 'shadedEdges',
  },
  overlay: {
    type: 'array',
    items: { enum: ['printFindings'] },
    description:
      '`printFindings`: runs print.analyze and colours the faces of its findings (errors red, warnings amber, info blue); the result lists them.',
  },
  printSettings: {
    type: 'object',
    description: 'Settings for the printFindings overlay (PrintSettings of print.analyze).',
  },
  background: { enum: ['light', 'dark', 'transparent'], default: 'light' },
  renderer: {
    enum: ['auto', 'gpu', 'software'],
    default: 'auto',
    description:
      '`auto`: the app’s GPU renderer when its 3D view is open, else the software renderer (headless).',
  },
  scope: {
    enum: ['auto', 'committed', 'staged'],
    default: 'auto',
    description: "`auto`: the open transaction's staged state if any, else the committed document.",
  },
};

const RENDER_PARAMS: JsonSchema = obj({
  view: VIEW_SCHEMA,
  projection: { enum: ['orthographic', 'perspective'], default: 'orthographic' },
  width: { type: 'integer', minimum: 64, maximum: MAX_RENDER_SIDE, default: 768 },
  height: { type: 'integer', minimum: 64, maximum: MAX_RENDER_SIDE, default: 576 },
  margin: {
    type: 'number',
    minimum: 0,
    maximum: 0.45,
    default: 0.06,
    description: 'Free border around the framed bodies, as a fraction of the image.',
  },
  highlight: obj({
    bodyIds: { type: 'array', items: str },
    faces: { type: 'array', items: obj({ bodyId: str, key: str }, ['bodyId', 'key']) },
    edges: { type: 'array', items: obj({ bodyId: str, key: str }, ['bodyId', 'key']) },
  }),
  tint: {
    type: 'array',
    items: obj({ bodyId: str, faceKeys: { type: 'array', items: str }, color: COLOR_SCHEMA }, [
      'bodyId',
      'color',
    ]),
    description:
      'Colour faces (or a whole body without faceKeys), e.g. to mark what a step changes.',
  },
  axes: { type: 'boolean', default: true, description: 'Axis triad (X red, Y green, Z blue).' },
  ...SHARED_PARAMS,
  path: {
    ...str,
    description: 'Headless: write the PNG to this file instead of returning base64.',
  },
});

const INSPECT_PARAMS: JsonSchema = obj({
  views: {
    type: 'array',
    items: VIEW_SCHEMA,
    minItems: 1,
    maxItems: MAX_INSPECT_VIEWS,
    description: 'Default: iso, front, top, right.',
  },
  size: {
    type: 'integer',
    minimum: 64,
    maximum: 1024,
    default: 384,
    description: 'Side of each square image, px.',
  },
  ...SHARED_PARAMS,
});

export const VIEW_METHODS: Record<string, MethodSpec> = {
  'view.render': {
    kind: 'query',
    capability: 'document.read',
    summary:
      "Renders the model to a PNG (named view or azimuth/elevation, orthographic or perspective, isolate/highlight/tint, section, display mode, printability overlay). Never moves the user's camera.",
    params: RENDER_PARAMS,
    result:
      '{mediaType: "image/png", width, height, byteLength, data (base64) | path, renderer: "gpu" | "software", view: {name?, azimuth, elevation, projection}, bodies: [{id, name}], bounds: {min, max} | null, findings?: {count, bySeverity, listed: [{id, kind, severity, bodyId, faceKeys, message}]}, notes: [string]}',
  },
  'view.inspect': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Standard views of the model as PNGs plus a JSON manifest (bodies with bounding boxes, volumes and validity, feature errors, optional printability findings) — one call to look at a part from all sides.',
    params: INSPECT_PARAMS,
    result:
      '{images: [{view, width, height, mediaType, byteLength, data}], renderer, manifest: {projectName, revision, units: "mm", bodies: [{id, name, valid, volume, area, bbox, faceCount, edgeCount}], totals: {bodies, volume}, errors, warnings, findings?}}',
  },
};

// ---- request model ------------------------------------------------------------------------

export type ViewSpec = ViewName | { azimuth: number; elevation: number };

const NAMED_COLORS: Record<string, Rgb> = {
  red: [0.86, 0.15, 0.15],
  amber: [0.96, 0.62, 0.04],
  green: [0.13, 0.77, 0.37],
  blue: [0.23, 0.51, 0.96],
  violet: [0.66, 0.33, 0.97],
  accent: ACCENT,
};
const SEVERITY_COLORS: Record<string, { color: Rgb; amount: number }> = {
  error: { color: NAMED_COLORS.red!, amount: 0.78 },
  warning: { color: NAMED_COLORS.amber!, amount: 0.72 },
  info: { color: NAMED_COLORS.blue!, amount: 0.5 },
};

function colorOf(value: unknown): Rgb {
  if (typeof value === 'string' && NAMED_COLORS[value]) return NAMED_COLORS[value]!;
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)) {
    const n = parseInt(value.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  return ACCENT;
}

/** Yaw/pitch (radians) of a view. */
export function viewAngles(view: ViewSpec): { yaw: number; pitch: number } {
  if (typeof view === 'string') {
    const pose = presetPose(view as CameraPresetName, {
      target: [0, 0, 0],
      distance: 1,
      yaw: 0,
      pitch: 0,
    });
    return { yaw: pose.yaw, pitch: pose.pitch };
  }
  return { yaw: (view.azimuth * Math.PI) / 180, pitch: (view.elevation * Math.PI) / 180 };
}

/**
 * A camera that frames `bounds` from `view` with `margin` (fraction of the
 * image) left free: orthographic views fit the projected box exactly,
 * perspective views fit its bounding sphere.
 */
export function framePose(
  view: ViewSpec,
  projection: 'orthographic' | 'perspective',
  bounds: Bounds | null,
  aspect: number,
  margin = 0.06,
): CameraPose {
  const { yaw, pitch } = viewAngles(view);
  const box = bounds ?? { min: [-50, -50, -50], max: [50, 50, 50] };
  const center: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  const tanHalf = Math.tan(((45 / 2) * Math.PI) / 180);
  const free = Math.max(0.1, 1 - 2 * margin);
  if (projection === 'orthographic') {
    const probe: CameraPose = { target: center, distance: 1, yaw, pitch, fov: 0 };
    const { right, up } = cameraBasis(probe);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const x of [box.min[0], box.max[0]])
      for (const y of [box.min[1], box.max[1]])
        for (const z of [box.min[2], box.max[2]]) {
          const d: Vec3 = [x - center[0], y - center[1], z - center[2]];
          const sx = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
          const sy = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
          minX = Math.min(minX, sx);
          maxX = Math.max(maxX, sx);
          minY = Math.min(minY, sy);
          maxY = Math.max(maxY, sy);
        }
    // Centre the projected box, then size the view height to fit both directions.
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const target: Vec3 = [
      center[0] + right[0] * cx + up[0] * cy,
      center[1] + right[1] * cx + up[1] * cy,
      center[2] + right[2] * cx + up[2] * cy,
    ];
    const heightNeeded = Math.max(maxY - minY, (maxX - minX) / Math.max(1e-6, aspect), 1e-3) / free;
    return { target, distance: heightNeeded / (2 * tanHalf), yaw, pitch, fov: 0, roll: 0 };
  }
  const radius = Math.max(
    1e-3,
    Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2,
  );
  const halfFov = Math.min(Math.atan(tanHalf), Math.atan(tanHalf * aspect));
  return {
    target: center,
    distance: radius / Math.sin(halfFov) / free,
    yaw,
    pitch,
    fov: 45,
    roll: 0,
  };
}

function viewJson(view: ViewSpec, projection: string): Json {
  const { yaw, pitch } = viewAngles(view);
  const round = (r: number) => Math.round(((r * 180) / Math.PI) * 1000) / 1000 || 0;
  return {
    ...(typeof view === 'string' ? { name: view } : {}),
    azimuth: round(yaw),
    elevation: round(pitch),
    projection,
  };
}

interface Prepared {
  evaluation: EvaluationResult;
  bodies: Body[];
  bounds: Bounds | null;
  clip: { normal: Vec3; offset: number } | null;
  section: SceneInput['section'] | null;
  /** Per body id: face tints, accent edges, body tint. */
  marks: Map<string, Pick<SoftRenderBody, 'tint' | 'faceTints' | 'accentEdges'>>;
  selection: SelectionItem[];
  findings: Json | null;
  notes: string[];
}

function faceIndex(body: Body, key: string): number {
  const index = body.faces.findIndex((f) => f.key === key || f.aliases.includes(key));
  if (index < 0) {
    throw new ApiError('referenceNotFound', `No face "${key}" on ${body.id}`, {
      hint: 'faces.list returns the face keys of a body.',
      details: { candidates: body.faces.slice(0, 12).map((f) => f.key) },
    });
  }
  return index;
}

function edgeIndex(body: Body, key: string): number {
  const index = body.edges.findIndex((e) => e.key === key);
  if (index < 0) {
    throw new ApiError('referenceNotFound', `No edge "${key}" on ${body.id}`, {
      hint: 'edges.list returns the edge keys of a body.',
      details: { candidates: body.edges.slice(0, 12).map((e) => e.key) },
    });
  }
  return index;
}

async function prepare(ctx: ApiContext, p: Json): Promise<Prepared> {
  const evaluation = await ctx.readEvaluation(p);
  const ids = Array.isArray(p.bodyIds) ? (p.bodyIds as string[]) : null;
  for (const id of ids ?? []) {
    if (!evaluation.bodies.some((b) => b.id === id)) {
      throw new ApiError('notFound', `No body "${id}"`, {
        hint: 'bodies.list returns the body ids.',
        details: { candidates: evaluation.bodies.map((b) => ({ id: b.id, name: b.name })) },
      });
    }
  }
  const bodies = ids ? evaluation.bodies.filter((b) => ids.includes(b.id)) : [...evaluation.bodies];
  const notes: string[] = [];
  if (bodies.length === 0) notes.push('There are no bodies to draw yet.');
  const marks = new Map<string, Pick<SoftRenderBody, 'tint' | 'faceTints' | 'accentEdges'>>();
  const markOf = (bodyId: string) => {
    let mark = marks.get(bodyId);
    if (!mark) {
      mark = {};
      marks.set(bodyId, mark);
    }
    return mark;
  };
  const tintFace = (body: Body, index: number, tint: { color: Rgb; amount: number }) => {
    const mark = markOf(body.id);
    const map = new Map(mark.faceTints ?? []);
    map.set(index, tint);
    mark.faceTints = map;
  };
  const byId = (bodyId: string): Body => {
    const body = evaluation.bodies.find((b) => b.id === bodyId);
    if (!body) {
      throw new ApiError('notFound', `No body "${bodyId}"`, {
        details: { candidates: evaluation.bodies.map((b) => ({ id: b.id, name: b.name })) },
      });
    }
    return body;
  };
  const selection: SelectionItem[] = [];

  // Findings first, so explicit tints and highlights draw over them.
  let findings: Json | null = null;
  const overlays = Array.isArray(p.overlay) ? (p.overlay as string[]) : [];
  if (overlays.includes('printFindings')) {
    const analyze: ApiHandler | undefined = apiMethodHandler('print.analyze');
    if (!analyze) throw new ApiError('unsupported', 'Printability analysis is not available');
    const report = (await analyze(
      ctx,
      {
        ...(ids ? { bodyIds: ids } : {}),
        ...(p.printSettings && typeof p.printSettings === 'object'
          ? { settings: p.printSettings }
          : {}),
        ...(typeof p.scope === 'string' ? { scope: p.scope } : {}),
      },
      'print.analyze',
    )) as {
      findings?: {
        id: string;
        kind: string;
        severity: string;
        bodyId: string;
        faceKeys: string[];
        message: string;
      }[];
    };
    const list = report.findings ?? [];
    const bySeverity: Record<string, number> = {};
    for (const finding of list) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
      const body = bodies.find((b) => b.id === finding.bodyId);
      if (!body) continue;
      const tint = SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS.info!;
      if (finding.faceKeys.length === 0) {
        markOf(body.id).tint = { color: tint.color, amount: 0.22 };
      }
      for (const key of finding.faceKeys) {
        const index = body.faces.findIndex((f) => f.key === key || f.aliases.includes(key));
        if (index >= 0) tintFace(body, index, tint);
      }
    }
    findings = {
      count: list.length,
      bySeverity,
      listed: list.slice(0, MAX_LISTED_FINDINGS).map((f) => ({
        id: f.id,
        kind: f.kind,
        severity: f.severity,
        bodyId: f.bodyId,
        faceKeys: f.faceKeys.slice(0, 6),
        message: f.message,
      })),
    };
  }

  for (const raw of Array.isArray(p.tint) ? (p.tint as Json[]) : []) {
    const body = byId(String(raw.bodyId));
    const color = colorOf(raw.color);
    const keys = Array.isArray(raw.faceKeys) ? (raw.faceKeys as string[]) : [];
    if (keys.length === 0) markOf(body.id).tint = { color, amount: 0.65 };
    for (const key of keys) tintFace(body, faceIndex(body, key), { color, amount: 0.75 });
  }

  const highlight = (p.highlight ?? {}) as Json;
  for (const bodyId of Array.isArray(highlight.bodyIds) ? (highlight.bodyIds as string[]) : []) {
    const body = byId(bodyId);
    markOf(body.id).tint = { color: ACCENT, amount: 0.45 };
    selection.push({ kind: 'body', bodyId: body.id });
  }
  for (const ref of Array.isArray(highlight.faces) ? (highlight.faces as Json[]) : []) {
    const body = byId(String(ref.bodyId));
    const index = faceIndex(body, String(ref.key));
    tintFace(body, index, { color: ACCENT, amount: 0.6 });
    selection.push({ kind: 'face', bodyId: body.id, faceKey: body.faces[index]!.key });
  }
  for (const ref of Array.isArray(highlight.edges) ? (highlight.edges as Json[]) : []) {
    const body = byId(String(ref.bodyId));
    const index = edgeIndex(body, String(ref.key));
    const mark = markOf(body.id);
    mark.accentEdges = [...(mark.accentEdges ?? []), index];
    selection.push({ kind: 'edge', bodyId: body.id, edgeKey: body.edges[index]!.key });
  }

  const bounds = boundsOf(bodies);
  let clip: Prepared['clip'] = null;
  let section: Prepared['section'] = null;
  if (p.section && typeof p.section === 'object') {
    const s = p.section as Json;
    const flipped = s.flip === true;
    if (typeof s.axis === 'string') {
      const axis = s.axis.toUpperCase() as 'X' | 'Y' | 'Z';
      const offset = typeof s.offset === 'number' ? s.offset : 0;
      clip = sectionClip({ axis, offset, flipped });
      section = { enabled: true, axis, offset, flipped, bounds: sceneBounds(bounds), plane: null };
    } else {
      const normal = normalize(s.normal as Vec3);
      const origin = s.origin as Vec3;
      if (!normal)
        throw new ApiError('invalidParams', 'section.normal: must not be the zero vector');
      const plane = {
        normal: [normal[0], normal[1], normal[2]] as [number, number, number],
        origin: [origin[0], origin[1], origin[2]] as [number, number, number],
        label: 'Agent section',
      };
      clip = sectionClip({ axis: 'Z', offset: 0, flipped, plane });
      section = {
        enabled: true,
        axis: 'Z',
        offset: 0,
        flipped,
        bounds: sceneBounds(bounds),
        plane,
      };
    }
  }
  return { evaluation, bodies, bounds, clip, section, marks, selection, findings, notes };
}

function boundsOf(bodies: readonly Body[]): Bounds | null {
  if (bodies.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const body of bodies) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, body.min[k]!);
      max[k] = Math.max(max[k]!, body.max[k]!);
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : (meshBounds(bodies) ?? null);
}

/** The scene's (mutable) bounds type from camera bounds. */
function sceneBounds(
  bounds: Bounds | null,
): { min: [number, number, number]; max: [number, number, number] } | null {
  return bounds
    ? {
        min: [bounds.min[0], bounds.min[1], bounds.min[2]],
        max: [bounds.max[0], bounds.max[1], bounds.max[2]],
      }
    : null;
}

function normalize(v: Vec3): Vec3 | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-12 ? null : [v[0] / l, v[1] / l, v[2] / l];
}

/** Whether the app's GPU renderer can draw this request. */
function gpuAvailable(ctx: ApiContext, choice: string): boolean {
  if (choice === 'software') return false;
  const usable = ctx.host.server === 'app' && currentViewportSize() !== null;
  if (choice === 'gpu' && !usable) {
    throw new ApiError('unsupported', 'The GPU renderer needs the app with its 3D view open', {
      hint: 'Use renderer "auto" or "software".',
    });
  }
  return usable;
}

interface Shot {
  bytes: Uint8Array;
  renderer: 'gpu' | 'software';
}

async function shoot(
  prepared: Prepared,
  options: {
    view: ViewSpec;
    projection: 'orthographic' | 'perspective';
    width: number;
    height: number;
    margin: number;
    mode: SoftRenderMode;
    background: SoftBackground;
    axes: boolean;
    gpu: boolean;
  },
): Promise<Shot> {
  const pose = framePose(
    options.view,
    options.projection,
    prepared.bounds,
    options.width / options.height,
    options.margin,
  );
  if (options.gpu) {
    const ids = new Set(prepared.bodies.map((b) => b.id));
    const scene: Partial<SceneInput> = {
      pose,
      bodies: prepared.evaluation.bodies,
      sketches: [],
      hiddenBodyIds: prepared.evaluation.bodies.filter((b) => !ids.has(b.id)).map((b) => b.id),
      isolatedBodyIds: null,
      displayMode:
        options.mode === 'xray' ? 'xray' : options.mode === 'wireframe' ? 'wireframe' : 'shaded',
      hiddenEdgesVisible: false,
      selection: prepared.selection,
      section: prepared.section ?? {
        enabled: false,
        axis: 'Z',
        offset: 0,
        flipped: false,
        bounds: sceneBounds(prepared.bounds),
      },
      extraOverlays: tintBatches(prepared),
      measureLines: [],
      datums: [],
      errorHighlight: null,
      axesVisible: options.axes,
      movePreview: null,
      extrudePreviewBodyId: null,
      sketchPreview: null,
      ghostBodies: [],
      previewAccentBodyIds: [],
      previewNewBodyIds: [],
      previewFaceKeyPrefix: null,
    };
    const image = await renderViewportImage({
      width: options.width,
      height: options.height,
      transparent: options.background === 'transparent',
      grid: false,
      edges: options.mode !== 'shaded',
      scene,
    });
    return { bytes: new Uint8Array(await image.png.arrayBuffer()), renderer: 'gpu' };
  }
  const pixels = softRender({
    width: options.width,
    height: options.height,
    pose,
    mode: options.mode,
    background: options.background,
    clip: prepared.clip,
    axes: options.axes,
    bodies: prepared.bodies.map((body) => ({
      id: body.id,
      color: body.color,
      mesh: body.mesh,
      edges: body.edges,
      ...(prepared.marks.get(body.id) ?? {}),
    })),
  });
  return {
    bytes: await encodeRgbaPng(pixels, options.width, options.height),
    renderer: 'software',
  };
}

/** GL batches of the tinted faces (the GPU path's version of the software tints). */
function tintBatches(prepared: Prepared): FlatBatch[] {
  const batches: FlatBatch[] = [];
  for (const body of prepared.bodies) {
    const mark = prepared.marks.get(body.id);
    if (!mark?.faceTints && !mark?.tint) continue;
    const expanded = expandBody(body).positions;
    const triangles: number[] = [];
    const colors: Rgb[] = [];
    body.faces.forEach((face, index) => {
      const tint = mark.faceTints?.get(index) ?? mark.tint;
      if (!tint) return;
      for (let t = face.triangleStart; t < face.triangleStart + face.triangleCount; t += 1) {
        triangles.push(t);
        colors.push(tint.color);
      }
    });
    if (triangles.length === 0) continue;
    const positions = new Float32Array(triangles.length * 9);
    const rgba = new Float32Array(triangles.length * 12);
    triangles.forEach((t, i) => {
      positions.set(expanded.subarray(t * 9, t * 9 + 9), i * 9);
      const c = colors[i]!;
      for (let k = 0; k < 3; k += 1) rgba.set([c[0], c[1], c[2], 0.72], i * 12 + k * 4);
    });
    batches.push({ positions, colors: rgba, mode: 'triangles', depthTest: true });
  }
  return batches;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ---- handlers -----------------------------------------------------------------------------

const render: ApiHandler = async (ctx, p) => {
  const width = typeof p.width === 'number' ? p.width : 768;
  const height = typeof p.height === 'number' ? p.height : 576;
  const projection = p.projection === 'perspective' ? 'perspective' : 'orthographic';
  const view = (p.view as ViewSpec | undefined) ?? 'iso';
  const prepared = await prepare(ctx, p);
  const gpu = gpuAvailable(ctx, typeof p.renderer === 'string' ? p.renderer : 'auto');
  const shot = await shoot(prepared, {
    view,
    projection,
    width,
    height,
    margin: typeof p.margin === 'number' ? p.margin : 0.06,
    mode: (p.displayMode as SoftRenderMode | undefined) ?? 'shadedEdges',
    background: (p.background as SoftBackground | undefined) ?? 'light',
    axes: p.axes !== false,
    gpu,
  });
  if (shot.renderer === 'gpu' && p.background === 'dark') {
    prepared.notes.push('The GPU renderer draws the app theme’s background.');
  }
  return {
    ...(await ctx.deliver(shot.bytes, 'image/png', p.path)),
    width,
    height,
    renderer: shot.renderer,
    view: viewJson(view, projection),
    bodies: prepared.bodies.map((b) => ({ id: b.id, name: b.name })),
    bounds: prepared.bounds
      ? { min: [...prepared.bounds.min], max: [...prepared.bounds.max] }
      : null,
    ...(prepared.findings ? { findings: prepared.findings } : {}),
    notes: prepared.notes,
  };
};

const DEFAULT_INSPECT_VIEWS: ViewSpec[] = ['iso', 'front', 'top', 'right'];

const inspect: ApiHandler = async (ctx, p) => {
  const views = Array.isArray(p.views) ? (p.views as ViewSpec[]) : DEFAULT_INSPECT_VIEWS;
  const size = typeof p.size === 'number' ? p.size : 384;
  if (views.length * size * size > MAX_INSPECT_PIXELS) {
    throw new ApiError(
      'invalidParams',
      `${views.length} views of ${size} px exceed the bundle budget of ${MAX_INSPECT_PIXELS} pixels`,
      { hint: 'Ask for fewer views or a smaller size.' },
    );
  }
  const prepared = await prepare(ctx, p);
  const gpu = gpuAvailable(ctx, typeof p.renderer === 'string' ? p.renderer : 'auto');
  const images: Json[] = [];
  let renderer: 'gpu' | 'software' = 'software';
  for (const view of views) {
    const projection = view === 'iso' ? 'perspective' : 'orthographic';
    const shot = await shoot(prepared, {
      view,
      projection,
      width: size,
      height: size,
      margin: 0.08,
      mode: (p.displayMode as SoftRenderMode | undefined) ?? 'shadedEdges',
      background: (p.background as SoftBackground | undefined) ?? 'light',
      axes: true,
      gpu,
    });
    renderer = shot.renderer;
    images.push({
      view: viewJson(view, projection),
      width: size,
      height: size,
      mediaType: 'image/png',
      byteLength: shot.bytes.byteLength,
      data: toBase64(shot.bytes),
    });
  }
  const state = ctx.state();
  const evaluation = prepared.evaluation;
  return {
    images,
    renderer,
    manifest: {
      projectName: state.projectName,
      revision: ctx.revision(),
      units: 'mm',
      bodies: prepared.bodies.map(describeBody),
      totals: {
        bodies: prepared.bodies.length,
        volume: Math.round(prepared.bodies.reduce((s, b) => s + b.volume, 0) * 1000) / 1000,
      },
      errors: { ...evaluation.errors },
      warnings: { ...evaluation.warnings },
      ...(prepared.findings ? { findings: prepared.findings } : {}),
      notes: prepared.notes,
    },
  };
};

const HANDLERS: Record<string, ApiHandler> = {
  'view.render': render,
  'view.inspect': inspect,
};

/** The display module's view methods (after the canvas block). */
export const VIEW_API: ApiContribution = {
  methods: [
    {
      order: API_ORDER.methods.view,
      methods: Object.fromEntries(
        Object.entries(VIEW_METHODS).map(([name, spec]) => [
          name,
          { spec, handler: HANDLERS[name]! },
        ]),
      ),
    },
  ],
};

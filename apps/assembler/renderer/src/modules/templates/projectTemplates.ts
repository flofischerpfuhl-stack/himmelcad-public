/**
 * Project templates of the Home screen: small, print-ready parts built by
 * the **agent API** (`interface/agent-api/session.ts`, `hcasm.agent-api@1`) — the same
 * commands an agent or the Python layer sends — so a template is a real,
 * editable History (sketches with named dimensions, features, parameters),
 * never a mesh or a canned file. The same builders run headless in the
 * acceptance suite (`test/acceptance/`), which checks their volumes against
 * hand calculations.
 *
 * Every builder only uses `call(method, params)`; it assumes an empty
 * document and leaves the parts it made. Millimetres, Z up. The module
 * registers them (`module.ts`); the shell reads the registry
 * (`foundation/commands/projectTemplates.ts`).
 */
import type { ApiCall, ProjectTemplate } from '../../foundation/commands/projectTemplates.js';

type Json = Record<string, unknown>;

interface Descriptor {
  key: string;
  centroid: [number, number, number];
  midpoint: [number, number, number];
  normal: [number, number, number] | null;
  direction: [number, number, number] | null;
  radius: number | null;
}

interface SketchResult {
  featureId: string;
  shapes?: { dimensions: Record<string, string> }[];
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Small typed helpers over the raw calls, kept here so every step stays one visible command. */
function api(call: ApiCall) {
  const json = async <T = Json>(method: string, params: Json = {}) =>
    (await call(method, params)) as T;
  return {
    param: (name: string, value: number, unit: 'mm' | 'deg' | '' = 'mm') =>
      json('parameter.create', { name, unit, value }),
    sketch: (plane: string | Json, profiles: Json[] = []) =>
      json<SketchResult>('feature.create', {
        kind: 'sketch',
        params: {
          plane: typeof plane === 'string' ? { kind: 'plane', plane, offset: 0 } : plane,
          ...(profiles.length > 0 ? { profiles } : {}),
        },
      }),
    /** Drives a sketch dimension by a formula over parameters (`"width + 10"`). */
    drive: (featureId: string, dimension: string, expression: string) =>
      json('sketch.setDimension', { featureId, dimension, expression }),
    extrude: (sketchId: string, params: Json) =>
      json<{ featureId: string }>('feature.create', {
        kind: 'extrude',
        params: { profile: { kind: 'sketch', featureId: sketchId }, ...params },
      }),
    create: (kind: string, params: Json, name?: string) =>
      json<{ featureId: string }>('feature.create', { kind, params, ...(name ? { name } : {}) }),
    faces: (bodyId: string, select: string) => json<Descriptor[]>('faces.list', { bodyId, select }),
    edges: (bodyId: string, select: string) => json<Descriptor[]>('edges.list', { bodyId, select }),
    json,
  };
}

/** A rectangle with its corner at (x, y) in sketch coordinates. */
const rect = (x: number, y: number, width: number, height: number): Json => ({
  kind: 'rectangle',
  x,
  y,
  width,
  height,
});
const circle = (cx: number, cy: number, radius: number): Json => ({
  kind: 'circle',
  cx,
  cy,
  radius,
});

/**
 * Enclosure 80 × 60 × 30 with R4 corners, shelled to `wall` (top open), four
 * Ø7 screw bosses with Ø2.5 pilot holes, and a lid beside it: `wall` thick,
 * a locating lip `clearance` smaller than the opening all round (R1.8
 * corners to clear the inner R2 rounds) and four `screw_clear` holes over
 * the bosses. Driven by parameters (`width`, `depth`, `height`, `wall`,
 * `clearance`, `screw_clear`).
 */
async function buildEnclosure(call: ApiCall): Promise<void> {
  const a = api(call);
  await a.param('width', 80);
  await a.param('depth', 60);
  await a.param('height', 30);
  await a.param('wall', 2);
  await a.param('clearance', 0.2);
  await a.param('screw_clear', 3.4);

  // Box: a dimensioned rectangle driven by the parameters, extruded `height`.
  const base = await a.sketch('XY', [rect(0, 0, 80, 60)]);
  const baseDims = base.shapes![0]!.dimensions;
  await a.drive(base.featureId, baseDims.width!, 'width');
  await a.drive(base.featureId, baseDims.height!, 'depth');
  const box = await a.extrude(base.featureId, {
    distanceExpression: 'height',
    resultBodyName: 'Enclosure',
  });
  const enclosure = `body:${box.featureId}`;
  await a.create('fillet', { edges: [{ bodyId: enclosure, select: '|Z' }], radius: 4 });
  await a.create('shell', {
    faces: [{ bodyId: enclosure, select: '>Z' }],
    thicknessExpression: 'wall',
  });

  // Screw bosses standing on the floor, 4 mm below the rim (room for the lid's lip).
  const floor = await a.sketch({ kind: 'face', face: { bodyId: enclosure, select: '+Z and <Z' } }, [
    circle(8, 8, 3.5),
    circle(72, 8, 3.5),
    circle(8, 52, 3.5),
    circle(72, 52, 3.5),
  ]);
  await a.extrude(floor.featureId, {
    distanceExpression: 'height - wall - 4',
    operation: 'join',
    targetBodyId: enclosure,
  });
  // Pilot holes 20 mm deep from the boss tops.
  const bossTop = (await a.faces(enclosure, '+Z'))
    .filter((f) => near(f.centroid[2], 26))
    .sort((p, q) => p.centroid[0] - q.centroid[0] || p.centroid[1] - q.centroid[1])[0]!;
  const pilots = await a.sketch({ kind: 'face', face: { bodyId: enclosure, key: bossTop.key } }, [
    circle(8, 8, 1.25),
    circle(72, 8, 1.25),
    circle(8, 52, 1.25),
    circle(72, 52, 1.25),
  ]);
  await a.extrude(pilots.featureId, { distance: -20, operation: 'cut', targetBodyId: enclosure });

  // Lid beside the box.
  const lidSketch = await a.sketch('XY', [rect(90, 0, 80, 60)]);
  const lidDims = lidSketch.shapes![0]!.dimensions;
  await a.drive(lidSketch.featureId, lidDims.x!, 'width + 10');
  await a.drive(lidSketch.featureId, lidDims.width!, 'width');
  await a.drive(lidSketch.featureId, lidDims.height!, 'depth');
  const lidPlate = await a.extrude(lidSketch.featureId, {
    distanceExpression: 'wall',
    resultBodyName: 'Lid',
  });
  const lid = `body:${lidPlate.featureId}`;
  await a.create('fillet', { edges: [{ bodyId: lid, select: '|Z' }], radius: 4 });
  // Locating lip: the opening minus `clearance` on every side.
  const lip = await a.sketch({ kind: 'face', face: { bodyId: lid, select: '>Z' } }, [
    rect(92.2, 2.2, 75.6, 55.6),
  ]);
  const lipDims = lip.shapes![0]!.dimensions;
  await a.drive(lip.featureId, lipDims.x!, 'width + 10 + wall + clearance');
  await a.drive(lip.featureId, lipDims.y!, 'wall + clearance');
  await a.drive(lip.featureId, lipDims.width!, 'width - 2 * (wall + clearance)');
  await a.drive(lip.featureId, lipDims.height!, 'depth - 2 * (wall + clearance)');
  await a.extrude(lip.featureId, { distance: 3, operation: 'join', targetBodyId: lid });
  await a.create('fillet', { edges: [{ bodyId: lid, select: '|Z and >Z' }], radius: 1.8 });
  // Screw clearance holes through lid and lip, over the bosses.
  await a.create('hole', {
    face: { bodyId: lid, select: '<Z' },
    placements: [
      { kind: 'point', u: 98, v: 8 },
      { kind: 'point', u: 162, v: 8 },
      { kind: 'point', u: 98, v: 52 },
      { kind: 'point', u: 162, v: 52 },
    ],
    diameterExpression: 'screw_clear',
    thread: 'M3',
  });
  await a.create('setAppearance', { bodyId: enclosure, color: '#5B7FA6' });
  await a.create('setAppearance', { bodyId: lid, color: '#D9A441' });
}

/**
 * Wall holder: an L-bracket, 60 × 30 × 5 base with a 40 mm upright, R4
 * inner round, a 20 × 6 slot in the base, two Ø5 screw holes in the upright
 * and R3 front corners.
 */
async function buildBracket(call: ApiCall): Promise<void> {
  const a = api(call);
  const base = await a.sketch('XY', [rect(0, 0, 60, 30)]);
  const plate = await a.extrude(base.featureId, { distance: 5, resultBodyName: 'Bracket' });
  const bracket = `body:${plate.featureId}`;
  const upright = await a.sketch({ kind: 'face', face: { bodyId: bracket, select: '>Z' } }, [
    rect(0, 25, 60, 5),
  ]);
  await a.extrude(upright.featureId, { distance: 40, operation: 'join', targetBodyId: bracket });
  const inner = (await a.edges(bracket, '|X')).filter(
    (e) => near(e.midpoint[1], 25) && near(e.midpoint[2], 5),
  );
  await a.create('fillet', {
    edges: inner.map((e) => ({ bodyId: bracket, key: e.key })),
    radius: 4,
  });
  // The slot: a real slot entity (centre distance 14, width 6).
  const slotSketch = await a.sketch({
    kind: 'face',
    face: { bodyId: bracket, select: '+Z and <Z' },
  });
  await a.json('sketch.addSlot', {
    featureId: slotSketch.featureId,
    start: [23, 12],
    end: [37, 12],
    width: 6,
  });
  await a.extrude(slotSketch.featureId, { distance: -5, operation: 'cut', targetBodyId: bracket });
  const front = (await a.faces(bracket, '-Y')).find((f) => near(f.centroid[1], 25))!;
  await a.create('hole', {
    face: { bodyId: bracket, key: front.key },
    placements: [
      { kind: 'point', u: 15, v: 30 },
      { kind: 'point', u: 45, v: 30 },
    ],
    diameter: 5,
  });
  await a.create('fillet', { edges: [{ bodyId: bracket, select: '|Z and <Y' }], radius: 3 });
}

/**
 * Snap-in clip for a Ø10 cable: Ø14 ring, 5 mm opening, 24 × 5 screw tab
 * with two Ø3.5 holes, R1.5 tab corners; 8 mm tall.
 */
async function buildCableClip(call: ApiCall): Promise<void> {
  const a = api(call);
  const ring = await a.sketch('XY', [circle(0, 0, 7)]);
  const clipExtrude = await a.extrude(ring.featureId, {
    distance: 8,
    resultBodyName: 'Cable clip',
  });
  const clip = `body:${clipExtrude.featureId}`;
  const tab = await a.sketch('XY', [rect(-12, -11, 24, 5)]);
  await a.extrude(tab.featureId, { distance: 8, operation: 'join', targetBodyId: clip });
  const bore = await a.sketch({ kind: 'face', face: { bodyId: clip, select: '>Z' } }, [
    circle(0, 0, 5),
  ]);
  await a.extrude(bore.featureId, { distance: -8, operation: 'cut', targetBodyId: clip });
  const opening = await a.sketch({ kind: 'face', face: { bodyId: clip, select: '>Z' } }, [
    rect(-2.5, 3, 5, 5),
  ]);
  await a.extrude(opening.featureId, { distance: -8, operation: 'cut', targetBodyId: clip });
  await a.create('hole', {
    face: { bodyId: clip, select: '-Y and <Y' },
    placements: [
      { kind: 'point', u: -8, v: 4 },
      { kind: 'point', u: 8, v: 4 },
    ],
    diameter: 3.5,
    extent: { kind: 'blind', depth: 5 },
  });
  await a.create('fillet', { edges: [{ bodyId: clip, select: '|Z and <Y' }], radius: 1.5 });
}

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'An empty project.',
    build: async () => undefined,
  },
  {
    id: 'enclosure',
    name: 'Enclosure with lid',
    description: 'Shelled box, screw bosses and a lid with a locating lip. Parametric.',
    build: buildEnclosure,
  },
  {
    id: 'bracket',
    name: 'Bracket',
    description: 'L-bracket with a slot, screw holes and rounded edges.',
    build: buildBracket,
  },
  {
    id: 'cableClip',
    name: 'Cable clip',
    description: 'Snap-in clip for a 10 mm cable with a screw tab.',
    build: buildCableClip,
  },
];

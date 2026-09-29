/**
 * Incremental evaluation (`kernel/evalCache.ts`): an evaluation that starts
 * from cached checkpoints gives exactly the result of a full replay (names,
 * keys, volumes, errors, warnings), edits and previews only evaluate what
 * changed, memory stays bounded under eviction, and results are
 * deterministic across evaluator instances.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import init from 'replicad-opencascadejs';

import { createEvaluator, type KernelEvaluator } from '../../renderer/src/kernel/evaluator.js';
import type { EvaluationResult } from '../../renderer/src/kernel/types.js';
import type { Feature } from '../../renderer/src/model/document.js';
import {
  demoBracket,
  edge,
  extrude,
  faceRef,
  fillet,
  ninePartBench,
  sketch,
  type BenchPart,
} from '../bench/parts.js';

type OpenCascade = Awaited<ReturnType<typeof init>>;
let ocPromise: Promise<OpenCascade> | null = null;

/** One OCCT instance for the file; every test makes its own evaluators (own caches). */
function occt(): Promise<OpenCascade> {
  ocPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    return init({ locateFile: () => require.resolve('replicad-opencascadejs/wasm') });
  })();
  return ocPromise;
}

async function fresh(
  options: Parameters<typeof createEvaluator>[1] = {},
): Promise<KernelEvaluator> {
  return createEvaluator(await occt(), options);
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Everything a user or agent can observe about a result, except timings and mesh ids. */
function digest(result: EvaluationResult): unknown {
  return {
    errors: result.errors,
    warnings: result.warnings,
    sketches: result.sketches.map((s) => ({
      id: s.featureId,
      profiles: s.profiles.map((p) => p.key),
    })),
    bodies: result.bodies.map((b) => ({
      id: b.id,
      name: b.name,
      color: b.color,
      createdBy: b.createdBy,
      valid: b.valid,
      volume: round(b.volume),
      min: b.min.map(round),
      max: b.max.map(round),
      faces: b.faces.map((f) => [f.key, ...f.aliases].join(',')),
      edges: b.edges.map((e) => e.key),
      triangles: b.mesh.indices.length / 3 > 0,
    })),
  };
}

/** A small part with a fillet, a shell and a pattern (history-named operations). */
const shelledPart: BenchPart = (() => {
  const doc = (height: number, spacing: number): Feature[] => [
    sketch('s', 'XY', 0, { kind: 'rectangle', x: 0, y: 0, width: 40, height: 30 }),
    extrude('b', 's', height),
    fillet('f', [edge('body:b', 'b:side:0:l1', 'b:side:0:l2', [40, 0, height / 2])], 4),
    {
      id: 'sh',
      name: 'Shell 1',
      suppressed: false,
      kind: 'shell',
      bodyId: 'body:b',
      faces: [faceRef('body:b', 'b:end:0', [20, 15, height])],
      thickness: 2,
    },
    sketch('pin-s', 'XY', 0, { kind: 'circle', cx: 50, cy: 5, radius: 2 }),
    extrude('pin', 'pin-s', 8),
    {
      id: 'pat',
      name: 'Pattern 1',
      suppressed: false,
      kind: 'pattern',
      bodyIds: ['body:pin'],
      pattern: { kind: 'linear', direction: { kind: 'world', axis: 'Y' }, count: 3, spacing },
    },
  ];
  return {
    name: 'shelled part',
    document: () => doc(20, 10),
    editSecond: (v) => doc(20 + 0.5 * (v + 1), 10),
    editLast: (v) => doc(20, 10 + 0.5 * (v + 1)),
    preview: (v) => ({
      ...extrude('__preview_extrude__', 'pin-s', 1 + v),
      profile: { kind: 'face', face: faceRef('body:pin', 'pin:end:0', [50, 5, 8]) },
      operation: 'join',
    }),
  };
})();

for (const part of [demoBracket, ninePartBench, shelledPart]) {
  void test(`${part.name}: incremental re-evaluation equals a full replay`, async () => {
    const warm = await fresh();
    const base = await warm.evaluate(part.document());
    assert.deepEqual(base.errors, {}, 'base document evaluates');
    const n = part.document().length;
    const steps: [string, Feature[], (r: EvaluationResult) => void][] = [
      [
        'edit of the last feature',
        part.editLast(1),
        (r) => assert.equal(r.stats.evaluatedFeatures, 1),
      ],
      [
        'edit of feature #2',
        part.editSecond(1),
        (r) => assert.equal(r.stats.evaluatedFeatures, n - 1),
      ],
      [
        'back to the base document',
        part.document(),
        (r) => {
          assert.equal(r.stats.evaluatedFeatures, 0, 'a known document is not evaluated again');
          assert.equal(r.stats.reusedBodies, r.bodies.length, 'and its meshes are reused');
        },
      ],
      [
        'another last-feature edit',
        part.editLast(2),
        (r) => assert.equal(r.stats.evaluatedFeatures, 1),
      ],
    ];
    for (const [label, features, check] of steps) {
      const incremental = await warm.evaluate(features);
      const full = await (await fresh()).evaluate(features);
      assert.deepEqual(digest(incremental), digest(full), `${part.name}: ${label}`);
      check(incremental);
    }
  });
}

void test('previews evaluate only the provisional feature and are not kept in the cache', async () => {
  const evaluator = await fresh();
  await evaluator.evaluate(shelledPart.document());
  const before = evaluator.cacheInfo();
  for (let v = 0; v < 3; v += 1) {
    const features = [...shelledPart.document(), shelledPart.preview(v)];
    const preview = await evaluator.evaluate(features, { quality: 'preview' });
    assert.equal(preview.stats.evaluatedFeatures, 1);
    assert.deepEqual(preview.errors, {});
    const full = await (await fresh()).evaluate(features, { quality: 'preview' });
    assert.deepEqual(digest(preview), digest(full));
  }
  const after = evaluator.cacheInfo();
  assert.equal(after.entries, before.entries, 'no checkpoint for provisional features');
  assert.equal(after.shapes, before.shapes);
});

void test('preview quality is coarser than final; unchanged bodies keep their final mesh', async () => {
  const evaluator = await fresh();
  const final = await evaluator.evaluate(ninePartBench.document());
  const coarse = await (await fresh()).evaluate(ninePartBench.document(), { quality: 'preview' });
  assert.ok(coarse.stats.triangles < final.stats.triangles, 'preview meshes have fewer triangles');
  // A preview on the warm evaluator reuses the committed (final) meshes of untouched bodies.
  const preview = await evaluator.evaluate(
    [...ninePartBench.document(), ninePartBench.preview(1)],
    { quality: 'preview' },
  );
  assert.equal(preview.stats.tessellatedBodies, 1, 'only the previewed body is tessellated');
  const shaft = final.bodies.find((b) => b.id === 'body:shaft')!;
  const shaftAgain = preview.bodies.find((b) => b.id === 'body:shaft')!;
  assert.equal(shaftAgain.meshId, shaft.meshId, 'same mesh (identity) for the unchanged body');
});

void test('memory is bounded: eviction frees shapes and results stay exact', async () => {
  const evaluator = await fresh({ cacheBudgetBytes: 1 });
  const n = shelledPart.document().length;
  for (let v = 0; v < 6; v += 1) {
    const features = v % 2 ? shelledPart.editSecond(v) : shelledPart.editLast(v);
    const result = await evaluator.evaluate(features);
    const info = evaluator.cacheInfo();
    // Only the document just evaluated stays (its checkpoints are protected).
    assert.ok(info.entries <= n, `entries ${info.entries} <= ${n}`);
    assert.deepEqual(digest(result), digest(await (await fresh()).evaluate(features)));
  }
  evaluator.clearCache();
  assert.equal(evaluator.cacheInfo().entries, 0);
  assert.equal(evaluator.cacheInfo().shapes, 0);
  // Still usable after everything was freed.
  const again = await evaluator.evaluate(shelledPart.document());
  assert.deepEqual(again.errors, {});
});

void test('memory: our caches stay bounded; the heap grows only by small leaks inside OCCT itself', async (t) => {
  const evaluator = await fresh({
    cacheBudgetBytes: 4 * 1024 * 1024,
    meshBudgetBytes: 4 * 1024 * 1024,
  });
  const heap: number[] = [];
  const edits = 120;
  for (let i = 0; i < edits; i += 1) {
    const features = i % 2 ? demoBracket.editSecond(i) : demoBracket.editLast(i);
    await evaluator.evaluate(features);
    await evaluator.evaluate([...features, demoBracket.preview(i)], { quality: 'preview' });
    if (i % 20 === 19) heap.push(evaluator.cacheInfo().heapBytes);
    const info = evaluator.cacheInfo();
    assert.ok(info.bytes <= 5 * 1024 * 1024, `checkpoint bytes bounded (${info.bytes})`);
    assert.ok(info.faceMeshes <= 2 * info.faces + 256, `face caches bounded (${info.faceMeshes})`);
  }
  t.diagnostic(
    `wasm heap every 20 edits (MB): ${heap.map((h) => (h / 1048576).toFixed(1)).join(', ')}`,
  );
  // wasm memory never shrinks and grows in steps. Before the arena/leak fixes the demo
  // session grew ~3.5 MB per edit; what is left is OCCT's own leakage inside its
  // algorithms (40–260 KB per boolean, ~16 KB per BRepCheck'd face, a few KB per prism
  // or wire), which the adapters handle by recycling the kernel (RECYCLE_HEAP_BYTES).
  const perEdit = (heap[heap.length - 1]! - heap[0]!) / (edits - 20);
  assert.ok(perEdit < 1024 * 1024, `heap grew ${(perEdit / 1024).toFixed(0)} KB per edit`);
});
void test('deterministic: the same document gives the same names and keys in every evaluator', async () => {
  const a = await (await fresh()).evaluate(demoBracket.document());
  const b = await (await fresh()).evaluate(demoBracket.document());
  assert.deepEqual(digest(a), digest(b));
  // Pinned keys of the demo bracket (Node and the browser worker run the same wasm;
  // the Electron check compares the app's keys with these). Coplanar faces merged
  // by the upright's join keep the earliest feature's key, the other one as alias.
  const body = a.bodies[0]!;
  assert.deepEqual(body.faces.map((f) => [f.key, ...f.aliases].join(',')).sort(), [
    'feature-extrude-1:end:0',
    'feature-extrude-1:side:0:l1',
    'feature-extrude-1:side:0:l2,feature-extrude-2:side:0:l2',
    'feature-extrude-1:side:0:l3,feature-extrude-2:side:0:l3',
    'feature-extrude-1:side:0:l4,feature-extrude-2:side:0:l4',
    'feature-extrude-1:start:0',
    'feature-extrude-2:end:0',
    'feature-extrude-2:side:0:l1',
    'feature-extrude-5:side:0:c1',
    'feature-fillet-3:round:0',
  ]);
  assert.equal(body.edges.length, 24);
});

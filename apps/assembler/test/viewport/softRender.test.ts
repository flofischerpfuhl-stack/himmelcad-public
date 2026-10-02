/**
 * The software renderer and PNG encoder behind `view.render` headless:
 * a body lands where the camera frames it, backgrounds and highlights have
 * their colours, a section removes the cut side, and the PNG decodes back
 * to the same pixels.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

import type { BodyMesh } from '../../renderer/src/foundation/geometry-kernel/types.js';
import { framePose } from '../../renderer/src/modules/display/viewApi.js';
import { encodeRgbaPng, pngSize } from '../../renderer/src/platform/viewport/png.js';
import {
  ACCENT,
  softRender,
  type SoftRenderBody,
} from '../../renderer/src/platform/viewport/softRender.js';

/** An axis-aligned box mesh (one face per side, outward normals). */
function boxMesh(min: [number, number, number], max: [number, number, number]): BodyMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces: { n: [number, number, number]; c: [number, number, number][] }[] = [
    {
      n: [0, 0, 1],
      c: [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
    },
    {
      n: [0, 0, -1],
      c: [
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
      ],
    },
    {
      n: [0, -1, 0],
      c: [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
    },
    {
      n: [0, 1, 0],
      c: [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
    },
    {
      n: [-1, 0, 0],
      c: [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
    },
    {
      n: [1, 0, 0],
      c: [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
    },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const triangleFaces: number[] = [];
  faces.forEach((face, f) => {
    const base = positions.length / 3;
    for (const corner of face.c) {
      positions.push(...corner);
      normals.push(...face.n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    triangleFaces.push(f, f);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    triangleFaces: new Uint32Array(triangleFaces),
  };
}

const bounds = { min: [-10, -10, 0] as const, max: [10, 10, 20] as const };
const body = (extra: Partial<SoftRenderBody> = {}): SoftRenderBody => ({
  id: 'b',
  color: '#3366cc',
  mesh: boxMesh([-10, -10, 0], [10, 10, 20]),
  edges: [],
  ...extra,
});

function pixel(pixels: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
}

void test('a framed box fills the middle; the background and the transparent mode keep their colours', () => {
  const pose = framePose('front', 'orthographic', bounds, 1, 0.1);
  const pixels = softRender({
    width: 100,
    height: 100,
    pose,
    bodies: [body()],
    mode: 'shaded',
    background: 'light',
    axes: false,
  });
  const center = pixel(pixels, 100, 50, 50);
  assert.ok(center[2]! > center[0]!, `blue body in the middle, got ${center.join(',')}`);
  assert.deepEqual(pixel(pixels, 100, 2, 2), [244, 245, 247, 255]);
  // Margin 0.1: the box spans about 80 % of the image height.
  const column = Array.from({ length: 100 }, (_, y) => pixel(pixels, 100, 50, y));
  const covered = column.filter((p) => p[0] !== 244).length;
  assert.ok(covered > 70 && covered < 90, `covered ${covered} rows`);

  const clear = softRender({
    width: 40,
    height: 40,
    pose,
    bodies: [],
    mode: 'shaded',
    background: 'transparent',
    axes: false,
  });
  assert.equal(pixel(clear, 40, 20, 20)[3], 0);
});

void test('highlights tint the body; a section removes the cut side', () => {
  const pose = framePose('front', 'orthographic', bounds, 1, 0.1);
  const tinted = softRender({
    width: 64,
    height: 64,
    pose,
    bodies: [body({ color: '#808080', tint: { color: ACCENT, amount: 1 } })],
    mode: 'shaded',
    background: 'light',
    axes: false,
  });
  const p = pixel(tinted, 64, 32, 32);
  assert.ok(p[2]! > p[0]! + 40, `accent blue, got ${p.join(',')}`);

  // Keep z ≤ 10 (the top half is cut away): the upper image half shows background.
  const cut = softRender({
    width: 64,
    height: 64,
    pose,
    bodies: [body()],
    mode: 'shaded',
    background: 'light',
    clip: { normal: [0, 0, 1], offset: 10 },
    axes: false,
  });
  assert.deepEqual(pixel(cut, 64, 32, 14), [244, 245, 247, 255]);
  assert.notDeepEqual(pixel(cut, 64, 32, 48), [244, 245, 247, 255]);
});

void test('renders are deterministic and encode to a PNG that decodes to the same pixels', async () => {
  const pose = framePose('iso', 'perspective', bounds, 4 / 3, 0.06);
  const options = {
    width: 80,
    height: 60,
    pose,
    bodies: [body()],
    mode: 'shadedEdges' as const,
    background: 'light' as const,
  };
  const a = softRender(options);
  const b = softRender(options);
  assert.deepEqual(a, b);
  const png = await encodeRgbaPng(a, 80, 60);
  assert.deepEqual(pngSize(png), { width: 80, height: 60 });
  // Decode: IDAT → inflate → undo the Sub filter.
  let offset = 8;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset).getUint32(0);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 80 * 4;
  const decoded = new Uint8Array(80 * 60 * 4);
  for (let y = 0; y < 60; y += 1) {
    assert.equal(raw[y * (stride + 1)], 1, 'Sub filter');
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? decoded[y * stride + x - 4]! : 0;
      decoded[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + left) & 0xff;
    }
  }
  assert.deepEqual(decoded, a);
});

void test('framePose keeps the whole box in an orthographic view for any aspect', () => {
  for (const aspect of [0.5, 1, 2]) {
    const pose = framePose('iso', 'orthographic', bounds, aspect, 0);
    assert.equal(pose.fov, 0);
    assert.ok(pose.distance > 0);
  }
  const named = framePose({ azimuth: 0, elevation: 90 }, 'orthographic', bounds, 1);
  assert.ok(Math.abs(named.pitch - Math.PI / 2) < 1e-9);
});

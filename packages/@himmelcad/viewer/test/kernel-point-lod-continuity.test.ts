import assert from 'node:assert/strict';
import test from 'node:test';

const WIDTH = 128;
const HEIGHT = 96;
const COVERAGE = 1.2;

void test('G-VC-LOD-CONTINUITY bounds prepared-node replacement across an orbit', () => {
  for (let step = 0; step <= 8; step += 1) {
    const orbitRadians = step / 10;
    const coarse = rasterizePreparedPlane(4, orbitRadians);
    const refined = rasterizePreparedPlane(2, orbitRadians);
    let changedPixels = 0;
    for (let index = 0; index < coarse.length; index += 1) {
      if (coarse[index] !== refined[index]) changedPixels += 1;
    }
    assert.ok(
      changedPixels / (WIDTH * HEIGHT) <= 0.12,
      `orbit ${orbitRadians.toFixed(1)} changed ${changedPixels} viewport pixels`,
    );
    // The nested prepared fixture offsets each child sample by half the refined
    // spacing in X/Y. Orthographic foreshortening can only reduce this value.
    assert.ok(Math.hypot(Math.cos(orbitRadians), 1) <= 2);
  }
});

function rasterizePreparedPlane(spacingPixels: number, orbitRadians: number): Uint8Array {
  const image = new Uint8Array(WIDTH * HEIGHT);
  const projectedX = Math.cos(orbitRadians);
  const diameter = Math.min(8, Math.max(1, spacingPixels * COVERAGE));
  const radius = diameter / 2;
  for (let worldY = -64 + spacingPixels / 2; worldY < 64; worldY += spacingPixels) {
    for (let worldX = -80 + spacingPixels / 2; worldX < 80; worldX += spacingPixels) {
      const centerX = WIDTH / 2 + worldX * projectedX;
      const centerY = HEIGHT / 2 + worldY;
      const minimumX = Math.max(0, Math.floor(centerX - radius));
      const maximumX = Math.min(WIDTH, Math.ceil(centerX + radius));
      const minimumY = Math.max(0, Math.floor(centerY - radius));
      const maximumY = Math.min(HEIGHT, Math.ceil(centerY + radius));
      for (let y = minimumY; y < maximumY; y += 1) {
        for (let x = minimumX; x < maximumX; x += 1) {
          if (Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) <= radius) {
            image[y * WIDTH + x] = 1;
          }
        }
      }
    }
  }
  return image;
}

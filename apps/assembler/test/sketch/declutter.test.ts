/** Label de-cluttering of dense sketches and the chip keystroke buffer (pure). */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chipSize,
  layoutBadges,
  layoutChips,
  nextChipText,
} from '../../renderer/src/modules/sketching/ui/declutter.js';

function overlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
}

void test('stacked dimension chips are pushed apart along their normal; pinned chips stay', () => {
  const size = chipSize('12.5');
  const chips = [0, 1, 2, 3].map((i) => ({
    id: `d${i}`,
    x: 100 + i,
    y: 100,
    ...size,
    push: [0, -1] as [number, number],
  }));
  const placed = layoutChips([...chips, { ...chips[0]!, id: 'pin', pinned: true }]);
  assert.deepEqual(placed.get('pin'), { x: 100, y: 100 });
  const rects = [...placed.values()].map((p) => ({ ...p, ...size }));
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      assert.equal(overlap(rects[i]!, rects[j]!), false, `chips ${i} and ${j} overlap`);
    }
  }
});

void test('constraint badges avoid chips and each other around their anchor', () => {
  const chip = { x: 112, y: 88, w: 40, h: 20 };
  const badges = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, x: 100, y: 100 }));
  const placed = layoutBadges(badges, [chip]);
  const rects = [...placed.values()].map((p) => ({ ...p, w: 16, h: 16 }));
  for (const r of rects) assert.equal(overlap(r, chip), false);
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1)
      assert.equal(overlap(rects[i]!, rects[j]!), false);
    assert.ok(Math.hypot(rects[i]!.x - 100, rects[i]!.y - 100) <= 47, 'stays near its anchor');
  }
});

void test('digits typed while a chip opens extend its text instead of restarting it', () => {
  let pending: { field: 'length' | 'width'; text: string } | null = null;
  for (const key of ['1', '2', '.', '5']) pending = nextChipText(pending, key, 'length');
  assert.deepEqual(pending, { field: 'length', text: '12.5' });
  // A new chip after closing starts fresh with the tool's first field.
  assert.deepEqual(nextChipText(null, '7', 'width'), { field: 'width', text: '7' });
});

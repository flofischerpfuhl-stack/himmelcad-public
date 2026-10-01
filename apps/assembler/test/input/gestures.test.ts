/**
 * Touch gesture recognizer (`platform/input/gestures.ts`) with synthetic
 * touch sequences: taps, double taps, long press (menu, box), one-finger
 * orbit, two-finger pan/pinch/twist, two- and three-finger taps, the
 * three-finger swipe, cancellation and inertia.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  angleDelta,
  inertiaStep,
  TouchGestureRecognizer,
  type GestureEvent,
} from '../../renderer/src/platform/input/gestures.js';

function types(events: GestureEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Runs a script of touches and returns every event. */
function run(
  recognizer: TouchGestureRecognizer,
  script: (
    | ['down', number, number, number, number]
    | ['move', number, number, number, number]
    | ['up', number, number]
    | ['poll', number]
  )[],
): GestureEvent[] {
  const out: GestureEvent[] = [];
  for (const step of script) {
    if (step[0] === 'down')
      out.push(...recognizer.down({ id: step[1], x: step[2], y: step[3], t: step[4] }));
    else if (step[0] === 'move')
      out.push(...recognizer.move({ id: step[1], x: step[2], y: step[3], t: step[4] }));
    else if (step[0] === 'up') out.push(...recognizer.up(step[1], step[2]));
    else out.push(...recognizer.poll(step[1]));
  }
  return out;
}

void test('a tap; two quick taps at the same spot are a double tap; a far tap starts over', () => {
  const r = new TouchGestureRecognizer();
  const first = run(r, [
    ['down', 1, 100, 100, 0],
    ['move', 1, 103, 101, 40],
    ['up', 1, 90],
  ]);
  assert.deepEqual(first, [{ type: 'tap', x: 103, y: 101, count: 1 }]);
  const second = run(r, [
    ['down', 2, 108, 104, 250],
    ['up', 2, 300],
  ]);
  assert.deepEqual(second, [{ type: 'tap', x: 108, y: 104, count: 2 }]);
  // A third tap is a single tap again (the double consumed the pair).
  assert.deepEqual(
    types(
      run(r, [
        ['down', 3, 108, 104, 400],
        ['up', 3, 450],
      ]),
    ),
    ['tap'],
  );
  assert.equal(
    (
      run(r, [
        ['down', 4, 400, 400, 500],
        ['up', 4, 520],
      ])[0] as { count: number }
    ).count,
    1,
  );
  // Too slow for a double tap.
  const late = run(r, [
    ['down', 5, 400, 400, 1200],
    ['up', 5, 1220],
  ]);
  assert.equal((late[0] as { count: number }).count, 1);
});

void test('one finger orbits from where it went down; release reports the flick velocity', () => {
  const r = new TouchGestureRecognizer();
  const events = run(r, [
    ['down', 1, 0, 0, 0],
    ['move', 1, 5, 0, 10], // inside the slop
    ['move', 1, 20, 0, 20],
    ['move', 1, 40, 10, 30],
    ['up', 1, 35],
  ]);
  assert.deepEqual(types(events), ['orbitStart', 'orbit', 'orbit', 'orbitEnd']);
  assert.deepEqual(events[1], { type: 'orbit', dx: 20, dy: 0 });
  assert.deepEqual(events[2], { type: 'orbit', dx: 20, dy: 10 });
  const end = events[3] as { vx: number; vy: number };
  assert.ok(end.vx > 1 && end.vy > 0, `flick velocity ${end.vx}, ${end.vy}`);
  // A finger that stops before lifting does not glide.
  const r2 = new TouchGestureRecognizer();
  const still = run(r2, [
    ['down', 1, 0, 0, 0],
    ['move', 1, 30, 0, 20],
    ['up', 1, 400],
  ]);
  assert.deepEqual(still[still.length - 1], { type: 'orbitEnd', vx: 0, vy: 0 });
});

void test('with drawing fingers one-finger drags do nothing (the surface draws)', () => {
  const r = new TouchGestureRecognizer({ oneFinger: 'none' });
  const events = run(r, [
    ['down', 1, 0, 0, 0],
    ['move', 1, 50, 0, 20],
    ['up', 1, 40],
  ]);
  assert.deepEqual(events, []);
});

void test('long press: feedback, release = context menu, drag = box', () => {
  const r = new TouchGestureRecognizer();
  assert.deepEqual(
    run(r, [
      ['down', 1, 10, 10, 0],
      ['poll', 300],
    ]),
    [],
  );
  assert.equal(r.nextPollIn(300), 200);
  const held = run(r, [
    ['poll', 510],
    ['up', 1, 700],
  ]);
  assert.deepEqual(types(held), ['longPress', 'contextMenu']);
  const box = run(r, [
    ['down', 2, 10, 10, 1000],
    ['poll', 1600],
    ['move', 2, 60, 40, 1700],
    ['move', 2, 90, 80, 1750],
    ['up', 2, 1800],
  ]);
  assert.deepEqual(types(box), ['longPress', 'boxStart', 'boxMove', 'boxMove', 'boxEnd']);
  assert.deepEqual(box[box.length - 1], { type: 'boxEnd', x0: 10, y0: 10, x: 90, y: 80 });
  // A long press never counts as the first tap of a double tap.
  const r3 = new TouchGestureRecognizer();
  run(r3, [
    ['down', 1, 0, 0, 0],
    ['poll', 600],
    ['up', 1, 610],
  ]);
  assert.equal(
    (
      run(r3, [
        ['down', 2, 0, 0, 700],
        ['up', 2, 720],
      ])[0] as { count: number }
    ).count,
    1,
  );
});

void test('two fingers: pan with the centroid, pinch ratio, twist after its dead zone', () => {
  const r = new TouchGestureRecognizer({ twistDeg: 10 });
  run(r, [
    ['down', 1, 100, 100, 0],
    ['down', 2, 200, 100, 20],
  ]);
  // Spread from 100 to 200 px, centroid moves right by 25.
  // The first transform event carries the motion since the fingers went down (no lost slop).
  const pinch = run(r, [
    ['move', 2, 300, 100, 40],
    ['move', 1, 50, 100, 60],
  ]);
  assert.deepEqual(types(pinch), ['transformStart', 'transform', 'transform']);
  const t1 = pinch[1] as Extract<GestureEvent, { type: 'transform' }>;
  const t2 = pinch[2] as Extract<GestureEvent, { type: 'transform' }>;
  assert.ok(Math.abs(t1.scale * t2.scale - 250 / 100) < 1e-9, 'pinch ratio over both moves');
  assert.equal(t1.rotation + t2.rotation, 0);
  // Rotate the pair by 6° (inside the dead zone), then to 25°: rolls by 15° (25 − 10).
  const centre = { x: 175, y: 100 };
  const rotateTo = (deg: number, t: number): GestureEvent[] => {
    const rad = (deg * Math.PI) / 180;
    const half = 125;
    return [
      ...r.move({
        id: 1,
        x: centre.x - half * Math.cos(rad),
        y: centre.y + half * Math.sin(rad),
        t,
      }),
      ...r.move({
        id: 2,
        x: centre.x + half * Math.cos(rad),
        y: centre.y - half * Math.sin(rad),
        t: t + 1,
      }),
    ];
  };
  const small = rotateTo(6, 100);
  assert.equal(
    small.reduce((s, e) => s + (e.type === 'transform' ? e.rotation : 0), 0),
    0,
    'inside the dead zone',
  );
  const big = rotateTo(25, 120);
  const rolled = big.reduce((s, e) => s + (e.type === 'transform' ? e.rotation : 0), 0);
  assert.ok(Math.abs(rolled - 15) < 1e-6, `rolled ${rolled}`);
  const end = r.up(1, 140);
  assert.deepEqual(types(end), ['transformEnd']);
  // The remaining finger does nothing until it lifts.
  assert.deepEqual(r.move({ id: 2, x: 0, y: 0, t: 150 }), []);
  assert.deepEqual(r.up(2, 160), []);
  assert.equal(r.mode, 'idle');
});

void test('a quick still two-finger tap (undo) and three-finger tap (redo); slow ones are nothing', () => {
  const r = new TouchGestureRecognizer();
  const two = run(r, [
    ['down', 1, 100, 100, 0],
    ['down', 2, 160, 100, 30],
    ['up', 1, 120],
    ['up', 2, 140],
  ]);
  assert.deepEqual(two, [{ type: 'twoFingerTap', x: 130, y: 100 }]);
  const three = run(r, [
    ['down', 1, 100, 100, 1000],
    ['down', 2, 150, 100, 1020],
    ['down', 3, 200, 100, 1040],
    ['up', 1, 1150],
    ['up', 2, 1160],
    ['up', 3, 1180],
  ]);
  assert.deepEqual(types(three), ['threeFingerTap']);
  const slow = run(r, [
    ['down', 1, 100, 100, 2000],
    ['down', 2, 160, 100, 2020],
    ['up', 1, 2600],
    ['up', 2, 2610],
  ]);
  assert.deepEqual(slow, []);
});

void test('three-finger swipe left / right', () => {
  const r = new TouchGestureRecognizer();
  const left = run(r, [
    ['down', 1, 300, 100, 0],
    ['down', 2, 340, 110, 10],
    ['down', 3, 380, 100, 20],
    ['move', 1, 220, 100, 60],
    ['move', 2, 260, 110, 60],
    ['move', 3, 300, 100, 60],
  ]);
  assert.deepEqual(left, [{ type: 'threeFingerSwipe', direction: 'left' }]);
  // Lifting afterwards does nothing more.
  assert.deepEqual(
    run(r, [
      ['up', 1, 100],
      ['up', 2, 100],
      ['up', 3, 110],
    ]),
    [],
  );
  const right = run(r, [
    ['down', 1, 100, 100, 1000],
    ['down', 2, 140, 110, 1010],
    ['down', 3, 180, 100, 1020],
    ['move', 1, 200, 100, 1060],
    ['move', 2, 240, 110, 1060],
    ['move', 3, 260, 100, 1060],
  ]);
  assert.deepEqual(right, [{ type: 'threeFingerSwipe', direction: 'right' }]);
});

void test('a second finger during orbit hands over to the transform; during a box it is ignored; cancel ends cleanly', () => {
  const r = new TouchGestureRecognizer();
  const events = run(r, [
    ['down', 1, 0, 0, 0],
    ['move', 1, 30, 0, 10],
    ['down', 2, 100, 0, 20],
  ]);
  assert.deepEqual(types(events), ['orbitStart', 'orbit', 'orbitEnd', 'transformStart']);
  // Shapr3D: while the box is held, another finger taps a filter chip; the box goes on.
  const boxR = new TouchGestureRecognizer();
  const box = run(boxR, [
    ['down', 1, 0, 0, 0],
    ['poll', 600],
    ['move', 1, 40, 40, 700],
    ['down', 2, 100, 0, 720],
    ['up', 2, 760],
    ['move', 1, 60, 50, 780],
    ['up', 1, 800],
  ]);
  assert.deepEqual(types(box), ['longPress', 'boxStart', 'boxMove', 'boxMove', 'boxEnd']);
  assert.equal(boxR.mode, 'idle');
  const c = new TouchGestureRecognizer();
  run(c, [
    ['down', 1, 0, 0, 0],
    ['move', 1, 30, 0, 10],
  ]);
  assert.deepEqual(c.cancel(1), [{ type: 'orbitEnd', vx: 0, vy: 0 }]);
  assert.equal(c.mode, 'idle');
  // cancelAll (a pen went down) ignores the fingers until they lift.
  const p = new TouchGestureRecognizer();
  run(p, [
    ['down', 1, 0, 0, 0],
    ['move', 1, 30, 0, 10],
  ]);
  assert.deepEqual(types(p.cancelAll()), ['orbitEnd']);
  assert.deepEqual(p.move({ id: 1, x: 60, y: 0, t: 20 }), []);
  assert.deepEqual(p.up(1, 30), []);
});

void test('angle delta wraps and inertia decays to a stop', () => {
  assert.equal(angleDelta(170, -170), -20);
  assert.equal(angleDelta(-170, 170), 20);
  let state: { vx: number; vy: number } | null = { vx: 1, vy: 0 };
  let travelled = 0;
  let frames = 0;
  while (state && frames < 1000) {
    const step = inertiaStep(state, 16);
    travelled += step.dx;
    state = step.next;
    frames += 1;
  }
  assert.ok(frames < 200, `stops after ${frames} frames`);
  // The analytic glide distance of v0 · halfLife / ln 2 (≈ 173 px), minus the cut-off tail.
  assert.ok(travelled > 150 && travelled < 175, `glides ${travelled} px`);
});

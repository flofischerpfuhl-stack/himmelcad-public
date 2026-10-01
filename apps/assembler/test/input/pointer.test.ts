/**
 * Pointer model, palm rejection, the touch/pen preferences, the tablet
 * layout decisions and the number keypad's editing logic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drawingRole,
  fingersDraw,
  PenPresence,
  pointerKind,
  samplePointer,
} from '../../renderer/src/platform/input/pointer.js';
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
} from '../../renderer/src/platform/input/preferences.js';
import {
  effectiveToolbarLabels,
  layoutAttributes,
  resolveKeypad,
  resolveTabletLayout,
} from '../../renderer/src/platform/input/tabletLayout.js';
import { applyKeypadKey, keypadTargetOf } from '../../renderer/src/platform/widgets/keypad.js';
import {
  NAVIGATION_PRESETS,
  penNavigation,
  resolveDrag,
} from '../../renderer/src/platform/input/navigation.js';

const event = (over: Partial<Parameters<typeof samplePointer>[0]>) => ({
  pointerId: 1,
  pointerType: 'mouse',
  clientX: 10,
  clientY: 20,
  button: 0,
  buttons: 1,
  ...over,
});

void test('pointer kinds and samples: pressure, tilt, barrel button, eraser', () => {
  assert.equal(pointerKind('touch'), 'touch');
  assert.equal(pointerKind('pen'), 'pen');
  assert.equal(pointerKind(''), 'mouse');
  const pen = samplePointer(
    event({ pointerType: 'pen', pressure: 0.7, tiltX: 30, tiltY: -10, buttons: 3, timeStamp: 5 }),
  );
  assert.equal(pen.kind, 'pen');
  assert.equal(pen.pressure, 0.7);
  assert.equal(pen.tiltX, 30);
  assert.equal(pen.barrel, true);
  assert.equal(pen.eraser, false);
  assert.equal(pen.t, 5);
  assert.equal(samplePointer(event({ pointerType: 'pen', button: 5, buttons: 32 })).eraser, true);
  const mouse = samplePointer(event({ tiltX: 30, buttons: 2 }));
  assert.equal(mouse.tiltX, 0, 'tilt only for pens');
  assert.equal(mouse.barrel, false);
  const finger = samplePointer(event({ pointerType: 'touch', width: 40, height: 38 }));
  assert.equal(finger.width, 40);
});

void test('drawing role: pen and mouse draw; fingers per setting; a second finger navigates', () => {
  assert.equal(fingersDraw('auto', false), true);
  assert.equal(fingersDraw('auto', true), false);
  assert.equal(fingersDraw('pen', false), false);
  assert.equal(fingersDraw('touch', true), true);
  const role = (
    kind: 'mouse' | 'pen' | 'touch',
    fingerDrawing: 'auto' | 'pen' | 'touch',
    penSeen: boolean,
    otherTouches = 0,
  ) => drawingRole(kind, { fingerDrawing, penSeen, otherTouches });
  assert.equal(role('mouse', 'pen', true), 'draw');
  assert.equal(role('pen', 'pen', true), 'draw');
  assert.equal(role('touch', 'auto', false), 'draw');
  assert.equal(role('touch', 'auto', true), 'navigate');
  assert.equal(role('touch', 'pen', false), 'navigate');
  assert.equal(role('touch', 'touch', true), 'draw');
  assert.equal(role('touch', 'touch', true, 1), 'navigate');
});

void test('palm rejection: pen contact, recent pen, palm-sized contact; off means off', () => {
  const p = new PenPresence({ recentPenMs: 500, palmSizePx: 60 });
  const finger = (id: number, t: number, size = 20) => ({ id, t, width: size, height: size });
  // No pen yet: fingers are fingers, even large ones.
  assert.equal(p.touchDown(finger(1, 0, 80), true), false);
  assert.equal(p.notePen('move', 1000), true, 'first pen');
  assert.equal(p.notePen('down', 1010), false);
  assert.equal(p.touchDown(finger(2, 3000), true), true, 'pen touching the screen');
  assert.equal(p.isRejected(2), true);
  p.notePen('up', 3100);
  assert.equal(p.touchDown(finger(3, 3300), true), true, 'shortly after the pen');
  assert.equal(p.touchDown(finger(4, 4000), true), false, 'a finger later');
  assert.equal(p.touchDown(finger(5, 4000, 90), true), true, 'a palm-sized contact');
  assert.equal(p.touchDown(finger(6, 3300), false), false, 'palm rejection off');
  p.touchUp(2);
  assert.equal(p.isRejected(2), false);
});

void test('preferences: touch and pen settings default, parse and validate', () => {
  const defaults = parsePreferences(null);
  assert.equal(defaults.tabletLayout, 'auto');
  assert.equal(defaults.handedness, 'right');
  assert.equal(defaults.fingerDrawing, 'auto');
  assert.equal(defaults.penShapes, true);
  assert.equal(defaults.penSeen, false);
  const stored = parsePreferences(
    JSON.stringify({
      tabletLayout: 'on',
      handedness: 'left',
      fingerDrawing: 'pen',
      penShapes: false,
      scribbleErase: false,
      palmRejection: false,
      numericKeypad: 'off',
      touchInertia: false,
      twistRoll: false,
      touchUndoGestures: false,
      penSeen: true,
    }),
  );
  assert.deepEqual(
    {
      tabletLayout: stored.tabletLayout,
      handedness: stored.handedness,
      fingerDrawing: stored.fingerDrawing,
      penShapes: stored.penShapes,
      scribbleErase: stored.scribbleErase,
      palmRejection: stored.palmRejection,
      numericKeypad: stored.numericKeypad,
      touchInertia: stored.touchInertia,
      twistRoll: stored.twistRoll,
      touchUndoGestures: stored.touchUndoGestures,
      penSeen: stored.penSeen,
    },
    {
      tabletLayout: 'on',
      handedness: 'left',
      fingerDrawing: 'pen',
      penShapes: false,
      scribbleErase: false,
      palmRejection: false,
      numericKeypad: 'off',
      touchInertia: false,
      twistRoll: false,
      touchUndoGestures: false,
      penSeen: true,
    },
  );
  const bad = parsePreferences(
    JSON.stringify({ tabletLayout: 'yes', handedness: 3, fingerDrawing: 'nose' }),
  );
  assert.equal(bad.tabletLayout, DEFAULT_PREFERENCES.tabletLayout);
  assert.equal(bad.handedness, 'right');
  assert.equal(bad.fingerDrawing, 'auto');
});

void test('tablet layout: auto follows a primary touch screen; keypad and labels follow the layout', () => {
  assert.equal(resolveTabletLayout('auto', { touch: 'primary' }), true);
  assert.equal(resolveTabletLayout('auto', { touch: 'secondary' }), false);
  assert.equal(resolveTabletLayout('on', { touch: 'none' }), true);
  assert.equal(resolveTabletLayout('off', { touch: 'primary' }), false);
  assert.equal(resolveKeypad('auto', true), true);
  assert.equal(resolveKeypad('auto', false), false);
  assert.equal(resolveKeypad('on', false), true);
  assert.equal(resolveKeypad('off', true), false);
  assert.equal(effectiveToolbarLabels('hover', true), 'always');
  assert.equal(effectiveToolbarLabels('icons', true), 'icons');
  assert.equal(effectiveToolbarLabels('hover', false), 'hover');
  assert.deepEqual(layoutAttributes(true, 'left'), { 'data-hc-touch': '', 'data-hc-hand': 'left' });
  assert.deepEqual(layoutAttributes(false, 'right'), {
    'data-hc-touch': null,
    'data-hc-hand': null,
  });
});

void test('keypad: typing, backspace, sign, units, clear; which fields get it', () => {
  let f = { value: '12', start: 2, end: 2 };
  f = applyKeypadKey(f, { kind: 'insert', text: '.5' });
  assert.deepEqual(f, { value: '12.5', start: 4, end: 4 });
  f = applyKeypadKey(f, { kind: 'backspace' });
  assert.equal(f.value, '12.');
  f = applyKeypadKey(f, { kind: 'sign' });
  assert.deepEqual(f, { value: '-12.', start: 4, end: 4 });
  f = applyKeypadKey(f, { kind: 'sign' });
  assert.equal(f.value, '12.');
  f = applyKeypadKey(f, { kind: 'unit', unit: 'mm' });
  assert.equal(f.value, '12. mm');
  f = applyKeypadKey(f, { kind: 'unit', unit: 'in' });
  assert.equal(f.value, '12. in');
  f = applyKeypadKey(f, { kind: 'unit', unit: '°' });
  assert.equal(f.value, '12.°');
  // A selection (the field opens with its value selected) is replaced by the first key.
  assert.deepEqual(
    applyKeypadKey({ value: '40 mm', start: 0, end: 5 }, { kind: 'insert', text: '3' }),
    {
      value: '3',
      start: 1,
      end: 1,
    },
  );
  assert.deepEqual(
    applyKeypadKey({ value: 'd1', start: 2, end: 2 }, { kind: 'insert', text: ' / ' }),
    {
      value: 'd1 / ',
      start: 5,
      end: 5,
    },
  );
  assert.deepEqual(applyKeypadKey({ value: '5', start: 0, end: 0 }, { kind: 'backspace' }), {
    value: '5',
    start: 0,
    end: 0,
  });
  assert.equal(applyKeypadKey({ value: '42', start: 1, end: 1 }, { kind: 'clear' }).value, '');

  const attrs = (
    keypad: string | null,
    inputMode: string | null,
    units: string | null = null,
    type = 'text',
  ) => ({
    keypad,
    units,
    inputMode,
    type,
  });
  assert.deepEqual(keypadTargetOf(attrs('expression', null, 'mm in')), {
    mode: 'expression',
    units: ['mm', 'in'],
  });
  assert.deepEqual(keypadTargetOf(attrs(null, 'decimal')), { mode: 'number', units: [] });
  assert.equal(keypadTargetOf(attrs(null, null)), null, 'a name field');
  assert.equal(keypadTargetOf(attrs('off', 'decimal')), null);
  assert.equal(keypadTargetOf(attrs('number', null, null, 'checkbox')), null);
});

void test('Windows pen modifiers navigate; the mouse bindings of every preset are unchanged', () => {
  const none = { shift: false, ctrl: false, alt: false };
  assert.equal(penNavigation(none), null);
  assert.equal(penNavigation({ ...none, shift: true }), 'orbit');
  assert.equal(penNavigation({ ...none, ctrl: true }), 'pan');
  assert.equal(penNavigation({ ...none, alt: true }), 'zoom');
  assert.equal(penNavigation({ shift: true, ctrl: true, alt: false }), null, 'two modifiers: none');
  // Mouse regression: left = select (Shift/Ctrl add), the camera buttons per preset.
  const shapr3d = NAVIGATION_PRESETS.find((p) => p.id === 'shapr3d')!;
  assert.equal(resolveDrag(shapr3d, 0, none), 'select');
  assert.equal(resolveDrag(shapr3d, 0, { ...none, shift: true }), 'select');
  assert.equal(resolveDrag(shapr3d, 2, none), 'orbit');
  assert.equal(resolveDrag(shapr3d, 2, { ...none, shift: true }), 'pan');
  assert.equal(resolveDrag(shapr3d, 1, none), 'pan');
});

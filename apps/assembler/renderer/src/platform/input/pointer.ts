/**
 * Unified pointer model (assembler/TOUCH.md): what kind of device a pointer
 * event comes from (mouse, finger, pen), its pen data (pressure, tilt,
 * barrel button, eraser end) and contact size, plus the policy that decides
 * what a pointer does in a drawing surface ({@link drawingRole}) and the pen
 * presence that palm rejection reads ({@link PenPresence}).
 *
 * Pure and DOM-free (a {@link PointerLike} is any object with the
 * `PointerEvent` fields used here), so tests feed synthetic samples and the
 * web product can reuse it unchanged.
 */

export type PointerKind = 'mouse' | 'touch' | 'pen';

/** The `PointerEvent` fields the model reads (a DOM event satisfies it). */
export interface PointerLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  width?: number;
  height?: number;
  timeStamp?: number;
}

export interface PointerSample {
  id: number;
  kind: PointerKind;
  x: number;
  y: number;
  /** Milliseconds (the event's time stamp). */
  t: number;
  /** 0…1; mice report 0.5 while a button is down, 0 otherwise. */
  pressure: number;
  /** Pen tilt in degrees (−90…90), 0 for mouse and touch. */
  tiltX: number;
  tiltY: number;
  /** Contact size in CSS px (fingers and palms; 1 when the device does not report it). */
  width: number;
  height: number;
  /** The pen's barrel (side) button is held (`buttons & 2`, Pointer Events). */
  barrel: boolean;
  /** The pen's eraser end is in use (`button === 5` / `buttons & 32`). */
  eraser: boolean;
}

/** Normalises a pointer type string (`''` from synthetic events counts as mouse). */
export function pointerKind(pointerType: string): PointerKind {
  return pointerType === 'touch' ? 'touch' : pointerType === 'pen' ? 'pen' : 'mouse';
}

export function samplePointer(event: PointerLike, now?: number): PointerSample {
  const kind = pointerKind(event.pointerType);
  const pen = kind === 'pen';
  return {
    id: event.pointerId,
    kind,
    x: event.clientX,
    y: event.clientY,
    t: now ?? event.timeStamp ?? 0,
    pressure: Number.isFinite(event.pressure) ? (event.pressure as number) : 0,
    tiltX: pen && Number.isFinite(event.tiltX) ? (event.tiltX as number) : 0,
    tiltY: pen && Number.isFinite(event.tiltY) ? (event.tiltY as number) : 0,
    width: Number.isFinite(event.width) ? (event.width as number) : 1,
    height: Number.isFinite(event.height) ? (event.height as number) : 1,
    barrel: pen && (event.buttons & 2) !== 0,
    eraser: pen && (event.button === 5 || (event.buttons & 32) !== 0),
  };
}

// ---- what a pointer does in a drawing surface (sketch mode) -----------------------------------

/**
 * Settings › Touch and pen › "Finger in sketches": `auto` — fingers draw
 * until a pen has been used on this device, then only the pen draws;
 * `pen` — only the pen (and the mouse) draws, fingers navigate and select;
 * `touch` — fingers draw too (two fingers still navigate).
 */
export type FingerDrawing = 'auto' | 'pen' | 'touch';

/** `draw`: the surface handles the pointer; `navigate`: the camera (viewport) gets it. */
export type DrawingRole = 'draw' | 'navigate';

export function fingersDraw(setting: FingerDrawing, penSeen: boolean): boolean {
  return setting === 'touch' || (setting === 'auto' && !penSeen);
}

/**
 * What a pointer going down does in a drawing surface. Mouse and pen always
 * draw (the camera buttons of the mouse are filtered by the caller); a
 * finger draws only when fingers draw and no other finger is down — a
 * second finger always starts navigation.
 */
export function drawingRole(
  kind: PointerKind,
  options: { fingerDrawing: FingerDrawing; penSeen: boolean; otherTouches: number },
): DrawingRole {
  if (kind !== 'touch') return 'draw';
  if (options.otherTouches > 0) return 'navigate';
  return fingersDraw(options.fingerDrawing, options.penSeen) ? 'draw' : 'navigate';
}

// ---- pen presence and palm rejection -----------------------------------------------------------

export interface PalmRejectionOptions {
  /** A touch starting this long after the pen was last seen (hover or contact) is a resting palm, ms. */
  recentPenMs: number;
  /** A touch contact larger than this (width or height, CSS px) is a palm once a pen was used. */
  palmSizePx: number;
}

export const DEFAULT_PALM_REJECTION: PalmRejectionOptions = {
  recentPenMs: 600,
  palmSizePx: 60,
};

/**
 * Tracks the pen (in range, in contact, last seen) and decides whether a
 * new touch is a palm. Rules, only while palm rejection is on:
 * - while the pen touches the screen every new touch is rejected;
 * - shortly after the pen was seen (hovering or lifted) a new touch is rejected;
 * - once a pen was used, a touch with a palm-sized contact is rejected.
 * A rejected touch stays rejected until it lifts.
 */
export class PenPresence {
  private penDown = false;
  private lastPenAt = -Infinity;
  private seen = false;
  private readonly rejected = new Set<number>();

  constructor(private options: PalmRejectionOptions = DEFAULT_PALM_REJECTION) {}

  /** A pen event (`down`, `move` = hover or drag, `up`/`leave`). Returns `true` the first time a pen is seen. */
  notePen(phase: 'down' | 'move' | 'up' | 'leave', t: number): boolean {
    const first = !this.seen;
    this.seen = true;
    this.lastPenAt = Math.max(this.lastPenAt, t);
    if (phase === 'down') this.penDown = true;
    else if (phase === 'up' || phase === 'leave') this.penDown = false;
    return first;
  }

  get penSeen(): boolean {
    return this.seen;
  }

  get penInContact(): boolean {
    return this.penDown;
  }

  /** Marks a pen as used before (the persisted "pen seen" flag). */
  assumePenSeen(): void {
    this.seen = true;
  }

  /** Whether a touch going down now is a palm (and remembers the decision for its id). */
  touchDown(
    sample: Pick<PointerSample, 'id' | 't' | 'width' | 'height'>,
    enabled: boolean,
  ): boolean {
    if (!enabled) return false;
    const palm =
      this.penDown ||
      sample.t - this.lastPenAt < this.options.recentPenMs ||
      (this.seen && Math.max(sample.width, sample.height) > this.options.palmSizePx);
    if (palm) this.rejected.add(sample.id);
    return palm;
  }

  /** Whether events of this touch id are ignored (rejected on down). */
  isRejected(id: number): boolean {
    return this.rejected.has(id);
  }

  touchUp(id: number): void {
    this.rejected.delete(id);
  }

  setOptions(options: PalmRejectionOptions): void {
    this.options = options;
  }
}

/** The app-wide pen presence (fed by `installPenTracking`, read by the viewport and drawing surfaces). */
export const penPresence = new PenPresence();

let tracking = false;
let onFirstPen: (() => void) | null = null;

/**
 * Listens (capture phase, passive) to every pen event of the window so pen
 * presence is known wherever the pen is — over the canvas, a panel or the
 * sketch overlay. Idempotent. `firstPen` runs once when a pen is seen for
 * the first time in this window.
 */
export function installPenTracking(target: Window, firstPen?: () => void): void {
  if (firstPen) onFirstPen = firstPen;
  if (tracking) return;
  tracking = true;
  const note =
    (phase: 'down' | 'move' | 'up') =>
    (event: PointerEvent): void => {
      if (event.pointerType !== 'pen') return;
      const first = penPresence.notePen(phase, event.timeStamp);
      if (first) onFirstPen?.();
    };
  const options = { capture: true, passive: true } as const;
  target.addEventListener('pointerdown', note('down'), options);
  target.addEventListener('pointermove', note('move'), options);
  target.addEventListener('pointerup', note('up'), options);
  target.addEventListener('pointercancel', note('up'), options);
}

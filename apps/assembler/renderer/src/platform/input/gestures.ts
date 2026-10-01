/**
 * Touch gesture recognizer (assembler/TOUCH.md "Gestures"): turns raw finger
 * contacts into navigation and command gestures, Shapr3D's iPad model —
 *
 * - one finger: tap (taps add up), double tap, drag = orbit (or nothing when
 *   fingers draw), long press = context menu, long press + drag = box;
 * - two fingers: pan + pinch zoom + twist (roll, after a dead zone), and a
 *   quick two-finger tap (undo);
 * - three fingers: a quick tap (redo) or a horizontal swipe (undo/redo).
 *
 * Pure: the caller feeds `down`/`move`/`up`/`cancel` with time stamps and
 * calls `poll` from a timer for the long press; every call returns the
 * gestures it recognised. Tests drive it with synthetic or recorded touches.
 */

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
  /** Milliseconds. */
  t: number;
}

export interface GestureOptions {
  /** Movement that turns a press into a drag, CSS px. */
  slopPx: number;
  longPressMs: number;
  /** Two taps closer in time and space are a double tap. */
  doubleTapMs: number;
  doubleTapSlopPx: number;
  /** A multi-finger tap: all fingers up within this time of the first going down, ms. */
  multiTapMs: number;
  /** Horizontal travel of a three-finger swipe, CSS px. */
  swipePx: number;
  /** Twist (degrees) before two fingers start rolling the view; `Infinity` = never. */
  twistDeg: number;
  /** One-finger drags orbit (`orbit`) or do nothing (`none`, the finger draws elsewhere). */
  oneFinger: 'orbit' | 'none';
}

export const DEFAULT_GESTURE_OPTIONS: GestureOptions = {
  slopPx: 10,
  longPressMs: 500,
  doubleTapMs: 350,
  doubleTapSlopPx: 30,
  multiTapMs: 300,
  swipePx: 60,
  twistDeg: 12,
  oneFinger: 'orbit',
};

export type GestureEvent =
  | { type: 'tap'; x: number; y: number; count: 1 | 2 }
  /** The finger was held still: feedback only; releasing it opens the context menu. */
  | { type: 'longPress'; x: number; y: number }
  | { type: 'contextMenu'; x: number; y: number }
  | { type: 'boxStart'; x0: number; y0: number; x: number; y: number }
  | { type: 'boxMove'; x0: number; y0: number; x: number; y: number }
  | { type: 'boxEnd'; x0: number; y0: number; x: number; y: number }
  | { type: 'boxCancel' }
  | { type: 'orbitStart'; x: number; y: number }
  | { type: 'orbit'; dx: number; dy: number }
  /** Velocity in px/ms at release (inertia). */
  | { type: 'orbitEnd'; vx: number; vy: number }
  | { type: 'transformStart'; cx: number; cy: number }
  /** `scale` = new finger spread / previous spread; `rotation` in degrees (counter-clockwise on screen positive). */
  | {
      type: 'transform';
      cx: number;
      cy: number;
      dx: number;
      dy: number;
      scale: number;
      rotation: number;
    }
  | { type: 'transformEnd'; vx: number; vy: number }
  | { type: 'twoFingerTap'; x: number; y: number }
  | { type: 'threeFingerTap'; x: number; y: number }
  | { type: 'threeFingerSwipe'; direction: 'left' | 'right' };

interface Contact {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

type Phase =
  | { kind: 'idle' }
  | {
      kind: 'one';
      id: number;
      startT: number;
      mode: 'pending' | 'held' | 'orbit' | 'box' | 'still';
    }
  | {
      kind: 'multi';
      startT: number;
      fingers: number;
      mode: 'pending' | 'transform';
      /** Spread/angle/centroid at the previous move (transform deltas). */
      prev: { cx: number; cy: number; dist: number; angle: number } | null;
      twist: number;
      rolling: boolean;
      /** Where a multi-finger tap is reported (centroid of the fingers as they went down). */
      tapAt: { x: number; y: number };
    }
  /** The gesture is over (or cancelled); wait until every finger is up. */
  | { kind: 'done' };

/** Recent movement samples for release velocity. */
interface VelocitySample {
  x: number;
  y: number;
  t: number;
}

const VELOCITY_WINDOW_MS = 80;

export class TouchGestureRecognizer {
  private readonly contacts = new Map<number, Contact>();
  private phase: Phase = { kind: 'idle' };
  private lastTap: { x: number; y: number; t: number } | null = null;
  private velocity: VelocitySample[] = [];
  private options: GestureOptions;

  constructor(options: Partial<GestureOptions> = {}) {
    this.options = { ...DEFAULT_GESTURE_OPTIONS, ...options };
  }

  setOptions(options: Partial<GestureOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** Number of fingers down (rejected palms excluded: the caller never feeds them). */
  get touchCount(): number {
    return this.contacts.size;
  }

  /** `true` while a gesture runs (a finger is down). */
  get active(): boolean {
    return this.contacts.size > 0;
  }

  /** The running phase, e.g. `one:orbit`, `multi:transform`, `idle` (diagnostics and tests). */
  get mode(): string {
    const p = this.phase;
    return p.kind === 'one' || p.kind === 'multi' ? `${p.kind}:${p.mode}` : p.kind;
  }

  down(p: TouchPoint): GestureEvent[] {
    const out: GestureEvent[] = [];
    this.contacts.set(p.id, { x: p.x, y: p.y, startX: p.x, startY: p.y });
    const phase = this.phase;
    if (phase.kind === 'idle') {
      this.phase = { kind: 'one', id: p.id, startT: p.t, mode: 'pending' };
      this.velocity = [{ x: p.x, y: p.y, t: p.t }];
      return out;
    }
    if (phase.kind === 'done') return out;
    if (phase.kind === 'one') {
      // During a box another finger only taps the box's filter chips (Shapr3D): the box stays.
      if (phase.mode === 'box') return out;
      // A second finger: navigation (or a two-finger tap) takes over.
      if (phase.mode === 'orbit') out.push({ type: 'orbitEnd', vx: 0, vy: 0 });
      const quick = phase.mode === 'pending' || phase.mode === 'held';
      this.phase = {
        kind: 'multi',
        startT: quick ? phase.startT : p.t,
        fingers: this.contacts.size,
        mode: 'pending',
        prev: null,
        twist: 0,
        rolling: false,
        tapAt: this.startCentroid(),
      };
      if (!quick) this.startTransform(out, false);
      return out;
    }
    // A further finger joins a multi-finger gesture.
    phase.fingers = Math.max(phase.fingers, this.contacts.size);
    if (phase.mode === 'transform') phase.prev = this.spread();
    else phase.tapAt = this.startCentroid();
    return out;
  }

  move(p: TouchPoint): GestureEvent[] {
    const out: GestureEvent[] = [];
    const contact = this.contacts.get(p.id);
    if (!contact) return out;
    const lastX = contact.x;
    const lastY = contact.y;
    contact.x = p.x;
    contact.y = p.y;
    const phase = this.phase;
    const { slopPx } = this.options;
    if (phase.kind === 'one' && phase.id === p.id) {
      const moved = Math.hypot(p.x - contact.startX, p.y - contact.startY) > slopPx;
      this.pushVelocity(p.x, p.y, p.t);
      if (phase.mode === 'pending' && moved) {
        if (this.options.oneFinger === 'orbit') {
          phase.mode = 'orbit';
          out.push({ type: 'orbitStart', x: contact.startX, y: contact.startY });
          // The drag starts where the finger went down: no jump, no lost slop.
          out.push({ type: 'orbit', dx: p.x - contact.startX, dy: p.y - contact.startY });
        } else {
          phase.mode = 'still';
        }
        return out;
      }
      if (phase.mode === 'held' && moved) {
        phase.mode = 'box';
        const box = { x0: contact.startX, y0: contact.startY, x: p.x, y: p.y };
        out.push({ type: 'boxStart', ...box }, { type: 'boxMove', ...box });
        return out;
      }
      if (phase.mode === 'orbit') out.push({ type: 'orbit', dx: p.x - lastX, dy: p.y - lastY });
      else if (phase.mode === 'box') {
        out.push({ type: 'boxMove', x0: contact.startX, y0: contact.startY, x: p.x, y: p.y });
      }
      return out;
    }
    if (phase.kind !== 'multi') return out;
    // A finger of a multi-finger press already lifted: the rest only finish the tap.
    if (this.contacts.size < Math.min(phase.fingers, 2)) return out;
    if (phase.mode === 'pending') {
      const centroid = this.centroid();
      const startCentroid = this.startCentroid();
      const travel = Math.max(
        ...[...this.contacts.values()].map((c) => Math.hypot(c.x - c.startX, c.y - c.startY)),
      );
      if (phase.fingers >= 3) {
        const dx = centroid.x - startCentroid.x;
        const dy = centroid.y - startCentroid.y;
        if (Math.abs(dx) >= this.options.swipePx && Math.abs(dx) > 2 * Math.abs(dy)) {
          out.push({ type: 'threeFingerSwipe', direction: dx < 0 ? 'left' : 'right' });
          this.phase = { kind: 'done' };
        } else if (travel > 3 * slopPx && Math.abs(dy) > Math.abs(dx)) {
          // Three fingers moving vertically: not a gesture we know; end it quietly.
          this.phase = { kind: 'done' };
        }
        return out;
      }
      if (travel <= slopPx) return out;
      // From where the fingers went down: the first transform has the slop's motion too.
      this.startTransform(out, true);
    }
    // Transform: centroid pan, spread zoom, twist roll.
    const next = this.spread();
    const prev = phase.prev ?? next;
    phase.prev = next;
    this.pushVelocity(next.cx, next.cy, p.t);
    let rotation = angleDelta(next.angle, prev.angle);
    if (!phase.rolling) {
      phase.twist += rotation;
      if (Math.abs(phase.twist) >= this.options.twistDeg) {
        phase.rolling = true;
        // Start rolling from the dead zone's edge (no jump).
        rotation = phase.twist - Math.sign(phase.twist) * this.options.twistDeg;
      } else rotation = 0;
    }
    out.push({
      type: 'transform',
      cx: next.cx,
      cy: next.cy,
      dx: next.cx - prev.cx,
      dy: next.cy - prev.cy,
      scale: prev.dist > 0 && next.dist > 0 ? next.dist / prev.dist : 1,
      rotation,
    });
    return out;
  }

  up(id: number, t: number): GestureEvent[] {
    const out: GestureEvent[] = [];
    const contact = this.contacts.get(id);
    if (!contact) return out;
    const phase = this.phase;
    if (phase.kind === 'one' && phase.id === id) {
      this.contacts.delete(id);
      // A finger that tapped a box filter may still be down: wait for it.
      this.phase = this.contacts.size > 0 ? { kind: 'done' } : { kind: 'idle' };
      switch (phase.mode) {
        case 'pending': {
          const last = this.lastTap;
          const double =
            last !== null &&
            t - last.t <= this.options.doubleTapMs &&
            Math.hypot(contact.x - last.x, contact.y - last.y) <= this.options.doubleTapSlopPx;
          this.lastTap = double ? null : { x: contact.x, y: contact.y, t };
          out.push({ type: 'tap', x: contact.x, y: contact.y, count: double ? 2 : 1 });
          break;
        }
        case 'held':
          out.push({ type: 'contextMenu', x: contact.x, y: contact.y });
          break;
        case 'orbit': {
          const v = this.releaseVelocity(t);
          out.push({ type: 'orbitEnd', vx: v.x, vy: v.y });
          break;
        }
        case 'box':
          out.push({
            type: 'boxEnd',
            x0: contact.startX,
            y0: contact.startY,
            x: contact.x,
            y: contact.y,
          });
          break;
        case 'still':
          break;
      }
      return out;
    }
    if (phase.kind === 'multi') {
      if (phase.mode === 'transform') {
        // Lifting a finger ends the transform; the rest of the fingers do nothing.
        const v = this.releaseVelocity(t);
        out.push({ type: 'transformEnd', vx: v.x, vy: v.y });
        this.phase = { kind: 'done' };
      } else if (this.contacts.size === 1) {
        // The last finger of a multi-finger press: a tap when quick and still.
        const quick = t - phase.startT <= this.options.multiTapMs * (phase.fingers >= 3 ? 1.5 : 1);
        const { x, y } = phase.tapAt;
        if (quick && phase.fingers === 2) out.push({ type: 'twoFingerTap', x, y });
        else if (quick && phase.fingers >= 3) out.push({ type: 'threeFingerTap', x, y });
      }
    }
    this.contacts.delete(id);
    if (this.contacts.size === 0) this.phase = { kind: 'idle' };
    return out;
  }

  /** The system took the pointer away (scrolling, an OS gesture, a palm decision). */
  cancel(id: number): GestureEvent[] {
    const out: GestureEvent[] = [];
    if (!this.contacts.has(id)) return out;
    out.push(...this.endRunning());
    this.contacts.delete(id);
    this.phase = this.contacts.size === 0 ? { kind: 'idle' } : { kind: 'done' };
    return out;
  }

  /** Ends whatever runs (e.g. a pen went down: the touch was a palm) and ignores the fingers until they lift. */
  cancelAll(): GestureEvent[] {
    const out = this.endRunning();
    this.phase = this.contacts.size === 0 ? { kind: 'idle' } : { kind: 'done' };
    return out;
  }

  /** Long-press timer: call with the current time while a finger is down. */
  poll(t: number): GestureEvent[] {
    const phase = this.phase;
    if (phase.kind !== 'one' || phase.mode !== 'pending') return [];
    if (t - phase.startT < this.options.longPressMs) return [];
    const contact = this.contacts.get(phase.id);
    if (!contact) return [];
    phase.mode = 'held';
    // A long press is not the first tap of a double tap.
    this.lastTap = null;
    return [{ type: 'longPress', x: contact.x, y: contact.y }];
  }

  /** Milliseconds until the next `poll` matters (the long press), `null` when none is due. */
  nextPollIn(t: number): number | null {
    const phase = this.phase;
    if (phase.kind !== 'one' || phase.mode !== 'pending') return null;
    return Math.max(0, this.options.longPressMs - (t - phase.startT));
  }

  private endRunning(): GestureEvent[] {
    const phase = this.phase;
    if (phase.kind === 'one') {
      if (phase.mode === 'box') return [{ type: 'boxCancel' }];
      if (phase.mode === 'orbit') return [{ type: 'orbitEnd', vx: 0, vy: 0 }];
    }
    if (phase.kind === 'multi' && phase.mode === 'transform') {
      return [{ type: 'transformEnd', vx: 0, vy: 0 }];
    }
    return [];
  }

  private startTransform(out: GestureEvent[], fromStart: boolean): void {
    const phase = this.phase;
    if (phase.kind !== 'multi') return;
    phase.mode = 'transform';
    const s = this.spread(fromStart);
    phase.prev = s;
    this.velocity = [];
    out.push({ type: 'transformStart', cx: s.cx, cy: s.cy });
  }

  private centroid(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const c of this.contacts.values()) {
      x += c.x;
      y += c.y;
    }
    const n = Math.max(1, this.contacts.size);
    return { x: x / n, y: y / n };
  }

  private startCentroid(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const c of this.contacts.values()) {
      x += c.startX;
      y += c.startY;
    }
    const n = Math.max(1, this.contacts.size);
    return { x: x / n, y: y / n };
  }

  /** Centroid, spread and angle of the first two fingers (transform). */
  private spread(atStart = false): { cx: number; cy: number; dist: number; angle: number } {
    const [ca, cb] = [...this.contacts.values()];
    if (!ca || !cb) {
      const c = this.centroid();
      return { cx: c.x, cy: c.y, dist: 0, angle: 0 };
    }
    const a = atStart ? { x: ca.startX, y: ca.startY } : ca;
    const b = atStart ? { x: cb.startX, y: cb.startY } : cb;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      // Screen y points down: negate so counter-clockwise on screen is positive.
      angle: (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI,
    };
  }

  private pushVelocity(x: number, y: number, t: number): void {
    this.velocity.push({ x, y, t });
    while (this.velocity.length > 2 && t - this.velocity[0]!.t > VELOCITY_WINDOW_MS) {
      this.velocity.shift();
    }
  }

  private releaseVelocity(t: number): { x: number; y: number } {
    const samples = this.velocity;
    this.velocity = [];
    const last = samples[samples.length - 1];
    const first = samples[0];
    // A finger that stopped before lifting has no velocity.
    if (!first || !last || t - last.t > VELOCITY_WINDOW_MS) return { x: 0, y: 0 };
    const dt = last.t - first.t;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }
}

/** Signed smallest difference `a − b` of two angles in degrees. */
export function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

// ---- inertia ------------------------------------------------------------------------------------

export interface InertiaState {
  vx: number;
  vy: number;
}

/** Below this speed (px/ms) a glide stops. */
export const INERTIA_STOP = 0.02;
/** Velocity half-life of a glide, ms. */
export const INERTIA_HALF_LIFE_MS = 120;
/** Flicks slower than this (px/ms) do not glide. */
export const INERTIA_MIN_START = 0.25;

/**
 * One inertia step of `dt` ms: the distance to move and the decayed
 * velocity (`null` once it is too slow to matter).
 */
export function inertiaStep(
  state: InertiaState,
  dt: number,
): { dx: number; dy: number; next: InertiaState | null } {
  const decay = Math.pow(0.5, dt / INERTIA_HALF_LIFE_MS);
  // Distance travelled while decaying exponentially over dt.
  const k = (INERTIA_HALF_LIFE_MS / Math.LN2) * (1 - decay);
  const dx = state.vx * k;
  const dy = state.vy * k;
  const next = { vx: state.vx * decay, vy: state.vy * decay };
  return {
    dx,
    dy,
    next: Math.hypot(next.vx, next.vy) < INERTIA_STOP ? null : next,
  };
}

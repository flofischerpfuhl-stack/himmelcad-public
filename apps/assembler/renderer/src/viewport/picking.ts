/**
 * Pure id <-> RGBA encoding for the offscreen picking framebuffer, plus the
 * scene-side lookup table that maps a picking id back to a
 * `SelectionItem`-shaped target. `0` is reserved for "nothing" (the
 * framebuffer is cleared to it); real ids start at `1`.
 *
 * Faces and edges are identified by their kernel naming keys (see
 * `kernel/naming.ts`), never by mesh or triangle indices, so a pick stays
 * meaningful across re-evaluations.
 */

export type PickTarget =
  | { kind: 'body'; bodyId: string }
  | { kind: 'face'; bodyId: string; faceKey: string }
  | { kind: 'edge'; bodyId: string; edgeKey: string }
  | { kind: 'sketchProfile'; featureId: string }
  | { kind: 'extrudeHandle' }
  | { kind: 'moveHandle'; axis: 0 | 1 | 2 };

export const NO_PICK_ID = 0;

/** Encodes a 1-based picking id into normalized RGBA (0..1) for `gl_FragColor`. */
export function encodePickId(id: number): [number, number, number, number] {
  const clamped = Math.max(0, Math.min(0xffffffff, Math.round(id)));
  const r = clamped & 0xff;
  const g = (clamped >>> 8) & 0xff;
  const b = (clamped >>> 16) & 0xff;
  const a = (clamped >>> 24) & 0xff;
  return [r / 255, g / 255, b / 255, a / 255];
}

/** Decodes a `Uint8ClampedArray`/`Uint8Array`-style RGBA byte quad back into a picking id. */
export function decodePickId(bytes: { 0: number; 1: number; 2: number; 3: number }): number {
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

/**
 * Builds a dense id table: `table[id - 1]` gives the {@link PickTarget}.
 * Order defines priority only insofar as callers assign ids from this list
 * in order — the viewport draws edges after faces so an edge "wins" within
 * its screen-space tolerance regardless of numeric id order.
 */
export class PickTable {
  private targets: PickTarget[] = [];

  add(target: PickTarget): number {
    this.targets.push(target);
    return this.targets.length; // 1-based id
  }

  resolve(id: number): PickTarget | null {
    if (id <= 0 || id > this.targets.length) return null;
    return this.targets[id - 1] ?? null;
  }

  clear(): void {
    this.targets = [];
  }
}

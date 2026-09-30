/**
 * Label de-cluttering for dense sketches (pure, unit tested): dimension
 * value chips are nudged along their dimension line's normal until they
 * no longer overlap earlier chips, then constraint badges take the nearest
 * free slot around their anchor (never on top of a chip or another badge).
 * Screen pixels.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Rect, b: Rect, gap = 2): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + gap * 2
  );
}

/** Approximate chip size for its text (12 px monospace, 6 px padding). */
export function chipSize(text: string): { w: number; h: number } {
  return { w: 7.3 * text.length + 14, h: 20 };
}

export interface ChipInput {
  id: string;
  /** Preferred centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Screen direction to push along when crowded (unit; the dimension line's normal). */
  push: [number, number];
  /** Moved by the user (Shift+drag): stays exactly where it is. */
  pinned?: boolean;
}

/** Chip centres after resolving overlaps (in input order; pinned chips first claim space). */
export function layoutChips(chips: readonly ChipInput[]): Map<string, { x: number; y: number }> {
  const placed: Rect[] = [];
  const out = new Map<string, { x: number; y: number }>();
  const order = [...chips].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  for (const chip of order) {
    let best = { x: chip.x, y: chip.y };
    if (!chip.pinned) {
      const step = chip.h + 4;
      for (let k = 0; k <= 8; k += 1) {
        // 0, +1, -1, +2, -2, … steps along the push direction.
        const n = k === 0 ? 0 : Math.ceil(k / 2) * (k % 2 === 1 ? 1 : -1);
        const candidate = {
          x: chip.x + chip.push[0] * step * n,
          y: chip.y + chip.push[1] * step * n,
        };
        const rect = { ...candidate, w: chip.w, h: chip.h };
        if (!placed.some((p) => overlaps(p, rect))) {
          best = candidate;
          break;
        }
      }
    }
    placed.push({ ...best, w: chip.w, h: chip.h });
    out.set(chip.id, best);
  }
  return out;
}

export interface BadgeInput {
  key: string;
  /** Anchor on the geometry. */
  x: number;
  y: number;
}

const BADGE = 16;

/**
 * Badge centres: the first free slot on rings around the anchor (starting
 * up-right, like Shapr3D's glyphs), avoiding chips and earlier badges.
 */
export function layoutBadges(
  badges: readonly BadgeInput[],
  obstacles: readonly Rect[],
): Map<string, { x: number; y: number }> {
  const placed: Rect[] = [...obstacles];
  const out = new Map<string, { x: number; y: number }>();
  const directions: [number, number][] = [
    [1, -1],
    [1, 0],
    [0, -1],
    [1, 1],
    [-1, -1],
    [0, 1],
    [-1, 0],
    [-1, 1],
  ];
  for (const badge of badges) {
    let chosen: { x: number; y: number } | null = null;
    for (const ring of [14, 30, 46]) {
      for (const [dx, dy] of directions) {
        const len = Math.hypot(dx, dy);
        const candidate = { x: badge.x + (dx / len) * ring, y: badge.y + (dy / len) * ring };
        const rect = { ...candidate, w: BADGE, h: BADGE };
        if (!placed.some((p) => overlaps(p, rect, 1))) {
          chosen = candidate;
          break;
        }
      }
      if (chosen) break;
    }
    chosen ??= { x: badge.x + 12, y: badge.y - 12 };
    placed.push({ ...chosen, w: BADGE, h: BADGE });
    out.set(badge.key, chosen);
  }
  return out;
}

/**
 * Keystrokes typed while a value chip is opening (its field mounts and
 * focuses a frame later) — the known "lost keystrokes" limit: the first
 * digit picks the chip, every further digit before the field has focus
 * extends the text it opens with instead of restarting it.
 */
export function nextChipText<F extends string>(
  pending: { field: F; text: string } | null,
  key: string,
  firstField: F,
): { field: F; text: string } {
  return pending
    ? { field: pending.field, text: pending.text + key }
    : { field: firstField, text: key };
}

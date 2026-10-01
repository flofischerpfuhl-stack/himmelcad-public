/**
 * Fonts for sketch text. Only fonts whose license allows embedding and
 * redistribution are offered (recorded in `LICENSES/THIRD_PARTY.md`):
 * Inter (SIL OFL 1.1, `@fontsource/inter`, Latin subset). The bytes come
 * from a host-provided loader — `fetch` of the bundled asset in the app
 * (`main.tsx`), the file from `node_modules` in Node (headless CLI, tests)
 * — and are parsed with opentype.js (MIT). Only text *creation/editing*
 * needs a font: a stored text keeps its outline (`SketchText.outline`), so
 * documents evaluate without it.
 */
import * as opentypeModule from 'opentype.js';

import { formatOutline, type OutlineCommand } from './outline.js';

export interface SketchFontInfo {
  id: string;
  label: string;
  /** File name of the font in `@fontsource/inter/files/` (the loader maps ids to bytes). */
  file: string;
}

export const SKETCH_FONTS: readonly SketchFontInfo[] = [
  { id: 'inter', label: 'Inter', file: 'inter-latin-400-normal.woff' },
];

export const DEFAULT_SKETCH_FONT = 'inter';

/** Minimal slice of the opentype.js API used here. */
interface OpenTypePath {
  commands: {
    type: string;
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }[];
}
interface OpenTypeGlyph {
  index: number;
}
export interface OpenTypeFont {
  unitsPerEm: number;
  tables: { os2?: { sCapHeight?: number } };
  getPath(text: string, x: number, y: number, fontSize: number): OpenTypePath;
  charToGlyph(char: string): OpenTypeGlyph;
  getAdvanceWidth(text: string, fontSize: number): number;
}
interface OpenTypeModule {
  parse(buffer: ArrayBuffer): OpenTypeFont;
}

const opentype: OpenTypeModule =
  (opentypeModule as unknown as { default?: OpenTypeModule }).default ??
  (opentypeModule as unknown as OpenTypeModule);

export type FontBytesLoader = (font: SketchFontInfo) => Promise<ArrayBuffer>;

let loader: FontBytesLoader | null = null;
const cache = new Map<string, Promise<OpenTypeFont>>();
const loaded = new Map<string, OpenTypeFont>();

/** Installs how font bytes are fetched (app: bundled asset URL; Node: the file). */
export function setFontLoader(next: FontBytesLoader | null): void {
  loader = next;
  cache.clear();
  loaded.clear();
}

export function fontInfo(id: string): SketchFontInfo | null {
  return SKETCH_FONTS.find((f) => f.id === id) ?? null;
}

/** Loads and parses a font (cached). Rejects for unknown fonts or without a loader. */
export function loadSketchFont(id: string): Promise<OpenTypeFont> {
  const info = fontInfo(id);
  if (!info) return Promise.reject(new Error(`Unknown font "${id}"`));
  let pending = cache.get(id);
  if (!pending) {
    if (!loader) return Promise.reject(new Error('No font loader is installed'));
    pending = loader(info).then((bytes) => {
      const font = opentype.parse(bytes);
      loaded.set(id, font);
      return font;
    });
    pending.catch(() => cache.delete(id));
    cache.set(id, pending);
  }
  return pending;
}

/** The parsed font if it finished loading, else `null` (for synchronous previews). */
export function loadedSketchFont(id: string): OpenTypeFont | null {
  return loaded.get(id) ?? null;
}

export interface TextOutline {
  /** Stored outline path data (1 = cap height, baseline start at the origin, v up). */
  outline: string;
  /** Advance width of the whole text in cap heights. */
  width: number;
  /** Characters the font has no glyph for (drawn as the font's missing-glyph box). */
  missing: string[];
}

/** Outline of `text` in `font`, normalized to the cap height. Line breaks become spaces. */
export function textOutlineOf(font: OpenTypeFont, text: string): TextOutline {
  const line = text.replace(/[\r\n\t]+/g, ' ');
  const size = font.unitsPerEm;
  const cap = font.tables.os2?.sCapHeight || size * 0.7;
  const path = font.getPath(line, 0, 0, size);
  const n = (v: number | undefined) => (v ?? 0) / cap;
  const commands: OutlineCommand[] = [];
  for (const c of path.commands) {
    if (c.type === 'M' || c.type === 'L') commands.push({ type: c.type, x: n(c.x), y: -n(c.y) });
    else if (c.type === 'Q') {
      commands.push({ type: 'Q', x1: n(c.x1), y1: -n(c.y1), x: n(c.x), y: -n(c.y) });
    } else if (c.type === 'C') {
      commands.push({
        type: 'C',
        x1: n(c.x1),
        y1: -n(c.y1),
        x2: n(c.x2),
        y2: -n(c.y2),
        x: n(c.x),
        y: -n(c.y),
      });
    } else if (c.type === 'Z') commands.push({ type: 'Z' });
  }
  const missing = [
    ...new Set([...line].filter((ch) => ch !== ' ' && font.charToGlyph(ch).index === 0)),
  ];
  return {
    outline: formatOutline(commands),
    width: font.getAdvanceWidth(line, size) / cap,
    missing,
  };
}

/** Loads the font and returns the outline of `text`. */
export async function textOutline(fontId: string, text: string): Promise<TextOutline> {
  return textOutlineOf(await loadSketchFont(fontId), text);
}

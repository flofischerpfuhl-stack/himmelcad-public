/**
 * Fonts for sketch text. Bundled fonts are only those whose license allows
 * embedding and redistribution (recorded in `LICENSES/THIRD_PARTY.md`):
 * Inter (SIL OFL 1.1, `@fontsource/inter`, Latin subset). Their bytes come
 * from a host-provided loader — `fetch` of the bundled asset in the app
 * (`main.tsx`), the file from `node_modules` in Node (headless CLI, tests).
 *
 * The desktop app can also offer the **fonts installed on the computer**
 * (Shapr3D "installed font", Block 8): a host installs a
 * {@link SystemFontProvider} (the renderer's Local Font Access API,
 * `modules/sketching/ui/localFonts.ts`); nothing is bundled or copied —
 * only the chosen font's bytes are read, when text is placed. Their ids are
 * `system:<PostScript name>`. Headless and tests have no provider, so they
 * stay deterministic with the bundled font; a stored text keeps its outline
 * (`SketchText.outline`), so documents evaluate everywhere without the font.
 *
 * Parsing uses opentype.js (MIT); font collections (`.ttc`) are split into
 * their fonts first ({@link parseFontBytes}).
 */
import * as opentypeModule from 'opentype.js';

import { formatOutline, type OutlineCommand } from './outline.js';

export interface SketchFontInfo {
  id: string;
  label: string;
  /** Bundled with the app, or installed on this computer. */
  source: 'bundled' | 'system';
  /** Bundled: file name in `@fontsource/inter/files/` (the loader maps ids to bytes). */
  file?: string;
  /** System: family and style (for grouping in menus). */
  family?: string;
  style?: string;
}

export const SKETCH_FONTS: readonly SketchFontInfo[] = [
  { id: 'inter', label: 'Inter', source: 'bundled', file: 'inter-latin-400-normal.woff' },
];

export const DEFAULT_SKETCH_FONT = 'inter';

/** Prefix of installed-font ids. */
export const SYSTEM_FONT_PREFIX = 'system:';

/** Horizontal text alignment at the anchor (Shapr3D text "alignment"). */
export type TextAlign = 'left' | 'center' | 'right';

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
  names?: { postScriptName?: Record<string, string> };
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

/** Installed fonts of the computer (desktop app only). */
export interface SystemFontProvider {
  /** The installed fonts (may need a user gesture the first time; rejects when not allowed). */
  list(): Promise<SketchFontInfo[]>;
  /** The bytes of an installed font (its file; a collection is split by {@link parseFontBytes}). */
  bytes(font: SketchFontInfo): Promise<ArrayBuffer>;
}

let loader: FontBytesLoader | null = null;
let systemProvider: SystemFontProvider | null = null;
const systemFonts = new Map<string, SketchFontInfo>();
let systemList: Promise<SketchFontInfo[]> | null = null;
const cache = new Map<string, Promise<OpenTypeFont>>();
const loaded = new Map<string, OpenTypeFont>();

/** Installs how font bytes are fetched (app: bundled asset URL; Node: the file). */
export function setFontLoader(next: FontBytesLoader | null): void {
  loader = next;
  cache.clear();
  loaded.clear();
}

/** Installs (or removes) the provider of installed fonts. */
export function setSystemFontProvider(next: SystemFontProvider | null): void {
  systemProvider = next;
  systemList = null;
  systemFonts.clear();
  for (const id of [...cache.keys()]) if (id.startsWith(SYSTEM_FONT_PREFIX)) cache.delete(id);
  for (const id of [...loaded.keys()]) if (id.startsWith(SYSTEM_FONT_PREFIX)) loaded.delete(id);
}

/** Whether installed fonts can be offered here (the desktop app). */
export function systemFontsAvailable(): boolean {
  return systemProvider !== null;
}

/**
 * The bundled fonts, then the installed ones (sorted by label) when a
 * provider is installed and allows it; a failed listing yields the bundled
 * fonts only and is retried on the next call.
 */
export async function listSketchFonts(): Promise<SketchFontInfo[]> {
  if (!systemProvider) return [...SKETCH_FONTS];
  if (!systemList) {
    systemList = systemProvider.list().then((fonts) => {
      const sorted = [...fonts].sort((a, b) => a.label.localeCompare(b.label));
      for (const f of sorted) systemFonts.set(f.id, f);
      return sorted;
    });
    systemList.catch(() => {
      systemList = null;
    });
  }
  try {
    return [...SKETCH_FONTS, ...(await systemList)];
  } catch {
    return [...SKETCH_FONTS];
  }
}

/** The fonts known right now (bundled + already listed installed ones), synchronously. */
export function knownSketchFonts(): SketchFontInfo[] {
  return [...SKETCH_FONTS, ...systemFonts.values()];
}

export function fontInfo(id: string): SketchFontInfo | null {
  const bundled = SKETCH_FONTS.find((f) => f.id === id);
  if (bundled) return bundled;
  const system = systemFonts.get(id);
  if (system) return system;
  if (id.startsWith(SYSTEM_FONT_PREFIX) && id.length > SYSTEM_FONT_PREFIX.length) {
    // An installed font named by a document (its outline is stored; the font may be absent here).
    return { id, label: id.slice(SYSTEM_FONT_PREFIX.length), source: 'system' };
  }
  return null;
}

/** Display name of a font id (also for fonts not installed here). */
export function fontLabel(id: string): string {
  return fontInfo(id)?.label ?? id;
}

/** Upper bound for one font file read from the system (a collection of CJK fonts can be large). */
const MAX_FONT_BYTES = 96 * 1024 * 1024;

/** Loads and parses a font (cached). Rejects for unknown fonts or without a loader/provider. */
export function loadSketchFont(id: string): Promise<OpenTypeFont> {
  const info = fontInfo(id);
  if (!info) return Promise.reject(new Error(`Unknown font "${id}"`));
  let pending = cache.get(id);
  if (!pending) {
    if (info.source === 'system') {
      const provider = systemProvider;
      if (!provider) {
        return Promise.reject(
          new Error(
            `The font "${info.label}" is not available here (installed fonts need the desktop app)`,
          ),
        );
      }
      const postScript = id.slice(SYSTEM_FONT_PREFIX.length);
      pending = provider.bytes(info).then((bytes) => {
        if (bytes.byteLength > MAX_FONT_BYTES) {
          throw new Error(`The font file of "${info.label}" is too large to read`);
        }
        const font = parseFontBytes(bytes, postScript);
        loaded.set(id, font);
        return font;
      });
    } else {
      if (!loader) return Promise.reject(new Error('No font loader is installed'));
      pending = loader(info).then((bytes) => {
        const font = parseFontBytes(bytes);
        loaded.set(id, font);
        return font;
      });
    }
    pending.catch(() => cache.delete(id));
    cache.set(id, pending);
  }
  return pending;
}

/** The parsed font if it finished loading, else `null` (for synchronous previews). */
export function loadedSketchFont(id: string): OpenTypeFont | null {
  return loaded.get(id) ?? null;
}

/**
 * Parses font bytes (TTF/OTF/WOFF). A font collection (`ttcf`, e.g.
 * `cambria.ttc`) is split into its fonts — each gets its own table
 * directory in front of the collection's bytes, the table offsets moved
 * accordingly — and the one whose PostScript name is `postScript` (else the
 * first) is returned.
 */
export function parseFontBytes(bytes: ArrayBuffer, postScript?: string): OpenTypeFont {
  const view = new DataView(bytes);
  if (bytes.byteLength < 12 || view.getUint32(0) !== 0x74746366 /* 'ttcf' */) {
    return opentype.parse(bytes);
  }
  const numFonts = view.getUint32(8);
  if (numFonts < 1 || numFonts > 1024 || 12 + 4 * numFonts > bytes.byteLength) {
    throw new Error('Damaged font collection');
  }
  let first: OpenTypeFont | null = null;
  for (let i = 0; i < numFonts; i += 1) {
    const font = opentype.parse(collectionMember(bytes, view.getUint32(12 + 4 * i)));
    first ??= font;
    const names = font.names?.postScriptName ?? {};
    if (!postScript || Object.values(names).includes(postScript)) return font;
  }
  return first!;
}

/** One font of a collection as a standalone sfnt buffer (directory + the whole collection). */
function collectionMember(bytes: ArrayBuffer, offset: number): ArrayBuffer {
  const view = new DataView(bytes);
  if (offset + 12 > bytes.byteLength) throw new Error('Damaged font collection');
  const numTables = view.getUint16(offset + 4);
  const dirSize = 12 + 16 * numTables;
  if (offset + dirSize > bytes.byteLength) throw new Error('Damaged font collection');
  const out = new Uint8Array(dirSize + bytes.byteLength);
  out.set(new Uint8Array(bytes, offset, dirSize), 0);
  out.set(new Uint8Array(bytes), dirSize);
  const outView = new DataView(out.buffer);
  for (let t = 0; t < numTables; t += 1) {
    const at = 12 + 16 * t + 8;
    outView.setUint32(at, view.getUint32(offset + 12 + 16 * t + 8) + dirSize);
  }
  return out.buffer;
}

export interface TextOutline {
  /** Stored outline path data (1 = cap height, the anchor at the origin, v up). */
  outline: string;
  /** Advance width of the whole text in cap heights. */
  width: number;
  /** Characters the font has no glyph for (drawn as the font's missing-glyph box). */
  missing: string[];
}

/**
 * Outline of `text` in `font`, normalized to the cap height. Line breaks
 * become spaces. `align` puts the anchor at the start (left), middle or end
 * (right) of the baseline: the outline is shifted, so evaluation never needs
 * to know the alignment.
 */
export function textOutlineOf(
  font: OpenTypeFont,
  text: string,
  align: TextAlign = 'left',
): TextOutline {
  const line = text.replace(/[\r\n\t]+/g, ' ');
  const size = font.unitsPerEm;
  const cap = font.tables.os2?.sCapHeight || size * 0.7;
  const width = font.getAdvanceWidth(line, size) / cap;
  const shift = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
  const path = font.getPath(line, 0, 0, size);
  const n = (v: number | undefined) => (v ?? 0) / cap;
  const x = (v: number | undefined) => n(v) + shift;
  const commands: OutlineCommand[] = [];
  for (const c of path.commands) {
    if (c.type === 'M' || c.type === 'L') commands.push({ type: c.type, x: x(c.x), y: -n(c.y) });
    else if (c.type === 'Q') {
      commands.push({ type: 'Q', x1: x(c.x1), y1: -n(c.y1), x: x(c.x), y: -n(c.y) });
    } else if (c.type === 'C') {
      commands.push({
        type: 'C',
        x1: x(c.x1),
        y1: -n(c.y1),
        x2: x(c.x2),
        y2: -n(c.y2),
        x: x(c.x),
        y: -n(c.y),
      });
    } else if (c.type === 'Z') commands.push({ type: 'Z' });
  }
  const missing = [
    ...new Set([...line].filter((ch) => ch !== ' ' && font.charToGlyph(ch).index === 0)),
  ];
  return { outline: formatOutline(commands), width, missing };
}

/** Loads the font and returns the outline of `text`. */
export async function textOutline(
  fontId: string,
  text: string,
  align: TextAlign = 'left',
): Promise<TextOutline> {
  return textOutlineOf(await loadSketchFont(fontId), text, align);
}

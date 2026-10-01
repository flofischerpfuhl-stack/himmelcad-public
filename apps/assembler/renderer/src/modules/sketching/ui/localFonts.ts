/**
 * Installed fonts for sketch text in the desktop app (SK-11), through the
 * browser's Local Font Access API (`window.queryLocalFonts`, Chromium /
 * Electron): the list carries names only; a font's bytes are read only when
 * text is placed in it, parsed in the renderer (`text/fonts.ts`), and never
 * copied into the project — the text's outline is stored instead. Where the
 * API is missing or not allowed, only the bundled font is offered.
 */
import {
  setSystemFontProvider,
  SYSTEM_FONT_PREFIX,
  type SketchFontInfo,
} from '../../../foundation/sketch-solver/text/fonts.js';

/** The slice of the Local Font Access API used here. */
interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

type QueryLocalFonts = (options?: { postscriptNames?: string[] }) => Promise<LocalFontData[]>;

function queryLocalFonts(): QueryLocalFonts | null {
  const query = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  return typeof query === 'function' ? query.bind(globalThis) : null;
}

const LIST_TIMEOUT_MS = 6000;

/** Installs the installed-font provider when the platform offers the API (desktop UI only). */
export function installLocalFontProvider(): void {
  const query = queryLocalFonts();
  if (!query) return;
  const byId = new Map<string, LocalFontData>();
  setSystemFontProvider({
    list: async () => {
      // A permission prompt that never comes (or a refusal that never answers) must not leave
      // the menu "loading": give up after a few seconds; "Show installed fonts" retries.
      const fonts = await Promise.race([
        query(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Installed fonts did not answer')), LIST_TIMEOUT_MS),
        ),
      ]);
      const out: SketchFontInfo[] = [];
      for (const font of fonts) {
        if (!font.postscriptName) continue;
        const id = `${SYSTEM_FONT_PREFIX}${font.postscriptName}`;
        if (byId.has(id)) continue;
        byId.set(id, font);
        out.push({
          id,
          label: font.fullName || font.postscriptName,
          source: 'system',
          family: font.family,
          style: font.style,
        });
      }
      return out;
    },
    bytes: async (info) => {
      let font = byId.get(info.id);
      if (!font) {
        const postScript = info.id.slice(SYSTEM_FONT_PREFIX.length);
        font = (await query({ postscriptNames: [postScript] }))[0];
      }
      if (!font) throw new Error(`The font "${info.label}" is not installed on this computer`);
      return (await font.blob()).arrayBuffer();
    },
  });
}

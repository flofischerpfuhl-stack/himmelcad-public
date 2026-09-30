/**
 * Font bytes for sketch text in the headless CLI: the bundled Inter WOFF
 * (SIL OFL 1.1, `@fontsource/inter`, see `LICENSES/THIRD_PARTY.md`) read
 * from node_modules, the same file the app bundles as an asset.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { setFontLoader } from '../renderer/src/foundation/sketch-solver/text/fonts.js';

export function installHeadlessFonts(): void {
  const require = createRequire(import.meta.url);
  setFontLoader(async (font) => {
    const bytes = await readFile(require.resolve(`@fontsource/inter/files/${font.file}`));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });
}

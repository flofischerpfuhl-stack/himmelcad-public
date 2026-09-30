/** Installs the Node font loader for sketch text in tests (the bundled Inter WOFF from node_modules). */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { setFontLoader } from '../../renderer/src/sketch/text/fonts.js';

export function installNodeFonts(): void {
  const require = createRequire(import.meta.url);
  setFontLoader(async (font) => {
    const bytes = await readFile(require.resolve(`@fontsource/inter/files/${font.file}`));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });
}

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Gallery imports the live source. Adjacent historical JS build artifacts must
// not shadow the TypeScript implementation (including generated command rows).
export default {
  plugins: [
    {
      name: 'gallery-typescript-source',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
        const stem = resolve(dirname(importer), source.slice(0, -3));
        for (const extension of ['.ts', '.tsx']) {
          if (existsSync(stem + extension)) return stem + extension;
        }
        return null;
      },
    },
  ],
};

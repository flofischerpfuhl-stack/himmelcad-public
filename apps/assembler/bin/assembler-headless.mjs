#!/usr/bin/env node
// HimmelCAD Assembler headless CLI (JSON-RPC 2.0 over stdio). Build first:
// `pnpm --filter @himmelcad/assembler build:headless`.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/headless/headless/cli.js', import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write(
    'assembler-headless is not built. Run: pnpm --filter @himmelcad/assembler build:headless\n',
  );
  process.exit(1);
}
await import(entry.href);

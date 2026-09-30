/** Paths of the interop fixtures (`test/fixtures/interop`, see their generators there). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Compiled to apps/assembler/.build/tests/apps/assembler/test/interop: six levels up is apps/assembler.
export const INTEROP_FIXTURES = join(here, '../../../../../../test/fixtures/interop');

export function interopFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(INTEROP_FIXTURES, name)));
}

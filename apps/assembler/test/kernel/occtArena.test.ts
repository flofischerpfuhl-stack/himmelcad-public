/**
 * OCCT object arenas (`kernel/occtArena.ts`): nested arenas release their
 * own objects; an out-of-order close (two asynchronous kernel users
 * interleaving on one OCCT instance) releases only its own arena, never the
 * still-open inner one, and is counted (`assembler/ROBUSTNESS.md`,
 * native-crash hardening). Pure JS: fake deletable objects.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  arenaInterleavings,
  closeArena,
  openArena,
} from '../../renderer/src/foundation/geometry-kernel/occtArena.js';

class Fake {
  deleted = false;
  delete(): void {
    if (this.deleted) throw new Error('double delete');
    this.deleted = true;
  }
  isDeleted(): boolean {
    return this.deleted;
  }
}

// Created after the arena module patched the global (as replicad's registry is).
const registry = new FinalizationRegistry<Fake>(() => undefined);

function make(): Fake {
  const held = new Fake();
  registry.register({}, held, held);
  return held;
}

void test('nested arenas release their own objects in order', () => {
  const outer = openArena();
  const a = make();
  const inner = openArena();
  const b = make();
  assert.equal(closeArena(inner), 1);
  assert.equal(b.deleted, true);
  assert.equal(a.deleted, false, 'the outer arena is still open');
  const c = make();
  assert.equal(closeArena(outer), 2);
  assert.equal(a.deleted && c.deleted, true);
});

void test('an out-of-order close releases only its own arena and keeps the inner one open', () => {
  const before = arenaInterleavings();
  const first = openArena(); // user A
  const a = make();
  const second = openArena(); // user B, while A awaits
  const b1 = make();
  assert.equal(closeArena(first), 1, 'A releases only what it recorded');
  assert.equal(a.deleted, true);
  assert.equal(b1.deleted, false, "B's objects survive A's close (no use-after-delete)");
  assert.equal(arenaInterleavings(), before + 1, 'the interleaving is counted');
  const b2 = make(); // still recorded in B
  assert.equal(closeArena(second), 2);
  assert.equal(b1.deleted && b2.deleted, true);
  // Back at the top level: nothing is recorded any more.
  const loose = make();
  const arena = openArena();
  assert.equal(closeArena(arena), 0);
  assert.equal(loose.deleted, false);
  assert.equal(closeArena(first), 0, 'closing twice is a no-op');
});

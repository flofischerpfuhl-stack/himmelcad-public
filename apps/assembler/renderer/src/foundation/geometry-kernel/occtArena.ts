/**
 * Deterministic release of OCCT objects created through replicad.
 *
 * replicad frees the C++ objects behind its wrappers (shapes, builders,
 * adaptors) only when the JavaScript garbage collector finalizes the
 * wrapper (`FinalizationRegistry`). The JS side of a wrapper is tiny, so the
 * collector has no reason to run while the wasm heap fills up with
 * intermediate B-rep: a long modelling session grows the heap by megabytes
 * per edit (measured: ~3.5 MB per demo edit) until wasm32 runs out of
 * memory.
 *
 * This module (imported before replicad by every kernel module that
 * imports replicad, so replicad's registry is created from it) wraps the
 * global `FinalizationRegistry` so that every registration made while an
 * **arena** is open is also recorded. Closing the arena deletes every
 * recorded object that is not **pinned** — body shapes kept by the
 * evaluator's checkpoint cache and cached topology are pinned, everything
 * else a feature created (booleans' builders, temporary faces/edges,
 * adaptors, tools) is released right after the feature. A wrapper deleted
 * here is skipped by replicad's own finalizer later (no double delete).
 *
 * Objects created outside an arena keep replicad's GC behaviour.
 */

interface Deletable {
  delete(): void;
  isDeleted?(): boolean;
}

interface Entry {
  held: Deletable;
  token: object | undefined;
  registry: FinalizationRegistry<unknown>;
}

const ARENA_MARK = Symbol.for('himmelcad.occtArena');

let current: Entry[] | null = null;
const stack: (Entry[] | null)[] = [];
const pinned = new WeakSet<object>();
let installed = false;

function isDeletable(value: unknown): value is Deletable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { delete?: unknown }).delete === 'function'
  );
}

function isDeleted(value: Deletable): boolean {
  try {
    return typeof value.isDeleted === 'function' ? value.isDeleted() : false;
  } catch {
    return true;
  }
}

function install(): void {
  const g = globalThis as { FinalizationRegistry?: typeof FinalizationRegistry };
  const Original = g.FinalizationRegistry;
  if (!Original) return;
  if ((Original as unknown as Record<symbol, unknown>)[ARENA_MARK]) {
    installed = true;
    return;
  }
  class TrackingFinalizationRegistry<T> extends Original<T> {
    constructor(cleanup: (held: T) => void) {
      super((held: T) => {
        // Already released by an arena: nothing left to finalize.
        if (isDeletable(held) && isDeleted(held)) return;
        cleanup(held);
      });
    }

    override register(target: WeakKey, held: T, token?: WeakKey): void {
      super.register(target, held, token);
      if (current && isDeletable(held)) {
        current.push({
          held,
          token: token as object | undefined,
          registry: this as FinalizationRegistry<unknown>,
        });
      }
    }
  }
  (TrackingFinalizationRegistry as unknown as Record<symbol, unknown>)[ARENA_MARK] = true;
  g.FinalizationRegistry = TrackingFinalizationRegistry as unknown as typeof FinalizationRegistry;
  installed = true;
}

install();

/** `true` when registrations are tracked (the module was evaluated before replicad). */
export function arenaInstalled(): boolean {
  return installed;
}

/** Keeps `raw` (an OCCT handle, e.g. `shape.wrapped`) alive across arena closes. */
export function pin(raw: object | null | undefined): void {
  if (raw) pinned.add(raw);
}

export function unpin(raw: object | null | undefined): void {
  if (raw) pinned.delete(raw);
}

export function isPinned(raw: object | null | undefined): boolean {
  return raw ? pinned.has(raw) : false;
}

/** Identifies an open arena (returned by {@link openArena}). */
export type ArenaToken = object;

let interleavings = 0;

/**
 * How many arenas were closed out of order so far (interleaved asynchronous
 * users of one OCCT instance). Must stay 0; the fuzzer and tests check it.
 */
export function arenaInterleavings(): number {
  return interleavings;
}

/** Opens a nested arena; every replicad object registered until `closeArena` is recorded. */
export function openArena(): ArenaToken {
  stack.push(current);
  current = [];
  return current;
}

/**
 * Closes the innermost arena (or the arena `token`) and deletes every
 * recorded object that is not pinned. Returns the number of objects deleted.
 *
 * Arenas are a stack; two asynchronous users that interleave (evaluator A
 * opens, awaits, evaluator B opens, A resumes and closes) used to close the
 * wrong arena — B's objects, still in use, were deleted (use-after-delete
 * inside OCCT). With a token, an out-of-order close releases only its own
 * arena and unlinks it, leaving the still-open inner arena intact
 * (`assembler/ROBUSTNESS.md`, native-crash hardening).
 */
export function closeArena(token?: ArenaToken): number {
  let entries: Entry[];
  if (token !== undefined && token !== current) {
    const index = stack.indexOf(token as Entry[]);
    if (index < 0) return 0; // already closed
    interleavings += 1;
    entries = token as Entry[];
    // `stack[index]` is the arena opened right after `token` recording `token` as its parent:
    // unlinked, that arena returns to `token`'s own parent when it closes.
    stack.splice(index, 1);
  } else {
    entries = current ?? [];
    current = stack.pop() ?? null;
  }
  let released = 0;
  for (const entry of entries) {
    if (pinned.has(entry.held) || isDeleted(entry.held)) continue;
    try {
      if (entry.token) entry.registry.unregister(entry.token);
      entry.held.delete();
      released += 1;
    } catch {
      // Deleted elsewhere in the meantime; nothing to release.
    }
  }
  return released;
}

/** Runs `fn` inside an arena (closed also when `fn` throws). */
export function inArena<T>(fn: () => T): T {
  const arena = openArena();
  try {
    return fn();
  } finally {
    closeArena(arena);
  }
}

/**
 * Async variant of {@link inArena}. Interleaved async arenas no longer
 * delete each other's objects (see {@link closeArena}), but an object one
 * user creates while another's arena is innermost is recorded there.
 */
export async function inArenaAsync<T>(fn: () => Promise<T>): Promise<T> {
  const arena = openArena();
  try {
    return await fn();
  } finally {
    closeArena(arena);
  }
}

/** Deletes an OCCT object or replicad wrapper now (no-op when already deleted). */
export function release(object: Deletable | null | undefined): void {
  if (!object) return;
  try {
    const raw = (object as { _wrapped?: object | null })._wrapped;
    if (raw) pinned.delete(raw);
    object.delete();
  } catch {
    // already deleted
  }
}

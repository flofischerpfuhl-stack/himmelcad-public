export type EscapeRungKind =
  | 'fieldRevert'
  | 'drag'
  | 'menu'
  | 'tool'
  | 'modal'
  | 'detachedFunction'
  | 'functionTab'
  | 'selection';

export type EscapeRungHandler = (event: KeyboardEvent) => boolean;

const ESCAPE_RUNG_ORDER: readonly EscapeRungKind[] = [
  'fieldRevert',
  'drag',
  'menu',
  'tool',
  'modal',
  'detachedFunction',
  'functionTab',
  'selection',
];

interface RegisteredRung {
  readonly handler: EscapeRungHandler;
  readonly order: number;
  readonly sequence: number;
}

const rungs = new Map<EscapeRungKind, RegisteredRung[]>();
const installedTargets = new WeakMap<
  Window | Document,
  { references: number; listener: EventListener }
>();
const suppressedBlurCommits = new WeakSet<HTMLInputElement | HTMLTextAreaElement>();
let registrationSequence = 0;

/**
 * The UIP-D14 Escape ladder, innermost first, handles exactly one rung per press:
 * (1) a focused commit/revert field reverts to its committed value (DESIGN-SYSTEM
 * "Input consistency"); free-text surfaces (agent chat input, console input) are
 * exempt: Escape never discards their content, at most releases focus, and is
 * consumed; (2) an active drag reverts; (3) an open menu/quick-surface closes;
 * (4) an armed tool/placement cancels; (5) a modal island traps Escape for its
 * own close; (6) the topmost detached function island closes — persistent
 * workspace islands are never Escape rungs; (7) the active function tab closes,
 * the panel falling back to Properties (UIP-D7) — Properties itself is never a
 * rung; (8) the selection clears.
 */
export function registerEscapeRung(
  kind: EscapeRungKind,
  handler: EscapeRungHandler,
  options: { order?: number } = {},
): () => void {
  const registered: RegisteredRung = {
    handler,
    order: options.order ?? 0,
    sequence: ++registrationSequence,
  };
  const entries = rungs.get(kind) ?? [];
  entries.push(registered);
  rungs.set(kind, entries);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = rungs.get(kind);
    if (!current) return;
    const index = current.indexOf(registered);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) rungs.delete(kind);
  };
}

export function dispatchEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape') return false;
  if (isExplicitEscapeFreeTextTarget(event.target)) {
    consume(event);
    return true;
  }

  for (const kind of ESCAPE_RUNG_ORDER) {
    const entries = [...(rungs.get(kind) ?? [])].sort(
      (left, right) => right.order - left.order || right.sequence - left.sequence,
    );
    for (const entry of entries) {
      if (!entry.handler(event)) continue;
      consume(event);
      return true;
    }
    if (kind === 'fieldRevert' && isUnregisteredFreeTextTarget(event.target)) {
      consume(event);
      return true;
    }
  }
  return false;
}

/** Installs one shared keydown listener per Window or Document target. */
export function installEscapeLadder(target: Window | Document): () => void {
  const existing = installedTargets.get(target);
  if (existing) {
    existing.references += 1;
    return () => uninstallEscapeLadder(target, existing);
  }
  const listener: EventListener = (event) => dispatchEscape(event as KeyboardEvent);
  const installed = { references: 1, listener };
  installedTargets.set(target, installed);
  target.addEventListener('keydown', listener, true);
  return () => uninstallEscapeLadder(target, installed);
}

/** Marks an input as free text whose content Escape must never discard. */
export function escapeFreeTextProps(): { 'data-escape-free-text': true } {
  return { 'data-escape-free-text': true };
}

/** Reverts a commit/revert field and prevents its resulting blur from committing. */
export function revertEscapeField(
  field: HTMLInputElement | HTMLTextAreaElement,
  committedValue: string,
): void {
  suppressedBlurCommits.add(field);
  field.value = committedValue;
}

/** Returns true once for a blur caused by an Escape field revert. */
export function consumeEscapeBlurCommitSuppression(
  field: HTMLInputElement | HTMLTextAreaElement,
): boolean {
  if (!suppressedBlurCommits.has(field)) return false;
  suppressedBlurCommits.delete(field);
  return true;
}

function uninstallEscapeLadder(
  target: Window | Document,
  installed: { references: number; listener: EventListener },
): void {
  if (installedTargets.get(target) !== installed) return;
  installed.references -= 1;
  if (installed.references > 0) return;
  target.removeEventListener('keydown', installed.listener, true);
  installedTargets.delete(target);
}

function isExplicitEscapeFreeTextTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { closest?: unknown }).closest !== 'function') return false;
  return Boolean(
    (target as unknown as { closest: (selector: string) => unknown }).closest(
      '[data-escape-free-text], textarea, [contenteditable="true"]',
    ),
  );
}

function isUnregisteredFreeTextTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { closest?: unknown }).closest !== 'function') return false;
  return Boolean(
    (target as unknown as { closest: (selector: string) => unknown }).closest(
      'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"]',
    ),
  );
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

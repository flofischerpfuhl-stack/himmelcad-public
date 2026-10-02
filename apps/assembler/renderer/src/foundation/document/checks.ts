/**
 * Stored checks (assembler/CHECKS.md): requirements a document keeps next
 * to its features — "Lid ↔ Base clearance ≥ 0.3 mm", "printable without
 * errors", "volume 40–60 cm³" — evaluated after every rebuild. A check is
 * plain data: its `kind` names a check kind a module registered
 * (`commands/checks.ts`), `params` are that kind's parameters.
 *
 * Document state: part of every undo snapshot (`commands/store.ts`), saved
 * as the optional top-level `.hcasm` field `checks` (the checks module
 * registers it; no schema bump — older apps ignore the field, a file without
 * it has no checks). The kind's own parameter checks run where the kind is
 * known; a kind this build does not know is kept unchanged and reported as
 * unsupported, so a newer file round-trips through an older app.
 */

export interface StoredCheck {
  /** Unique in the document, e.g. `check-k3f9a2`. */
  id: string;
  /** A registered check kind (`clearance`, `distance`, `printable`, …). */
  kind: string;
  /** User label; absent: the kind describes the check from its parameters. */
  name?: string;
  /** The kind's parameters (JSON). */
  params: Record<string, unknown>;
  /** `false`: kept but not evaluated. Absent = enabled. */
  enabled?: boolean;
}

/** Upper bound of checks in one document (a file with more is rejected). */
export const MAX_CHECKS = 500;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The structural problem of a stored check (id, kind, name, params object,
 * enabled flag), or `null` when its shape is fine. The kind's parameters
 * are checked by the kind's own validator.
 */
export function storedCheckProblem(value: unknown): { path: string; message: string } | null {
  if (!isRecord(value)) return { path: '', message: 'expected an object' };
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) {
    return { path: '.id', message: 'expected an id of letters, digits, "-" or "_"' };
  }
  if (typeof value.kind !== 'string' || !/^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(value.kind)) {
    return { path: '.kind', message: 'expected a check kind name' };
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 200)) {
    return { path: '.name', message: 'expected a string of at most 200 characters' };
  }
  if (!isRecord(value.params)) return { path: '.params', message: 'expected an object' };
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    return { path: '.enabled', message: 'expected a boolean' };
  }
  return null;
}

/** A copy with only the stored fields (unknown keys dropped). */
export function normalizeStoredCheck(check: StoredCheck): StoredCheck {
  return {
    id: check.id,
    kind: check.kind,
    ...(check.name !== undefined && check.name.trim() !== '' ? { name: check.name.trim() } : {}),
    params: check.params,
    ...(check.enabled === false ? { enabled: false } : {}),
  };
}

/** A fresh check id not used in `existing`. */
export function newCheckId(existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((c) => c.id));
  for (;;) {
    const id = `check-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
}

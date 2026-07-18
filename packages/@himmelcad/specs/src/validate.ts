import type { SpecCode, SpecLibrary, Specification } from './types.js';
import { SPECS_LIBRARY_FORMAT, SPECS_LIBRARY_KIND } from './types.js';

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

/** Accept 1..10 decimal digits as integer (no leading-zero requirement). */
export function isValidSpecCode(code: unknown): code is SpecCode {
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 1) return false;
  return code <= 9_999_999_999;
}

export function validateSpecification(spec: Specification): ValidateResult {
  const errors: string[] = [];
  if (!spec.id?.trim()) errors.push('Specification id is required');
  if (!isValidSpecCode(spec.code)) {
    errors.push('Code must be an integer with 1–10 digits (1 … 9999999999)');
  }
  if (!spec.name?.trim()) errors.push('Name is required');
  if (!Array.isArray(spec.drawFolder)) errors.push('drawFolder must be an array of path segments');
  else if (spec.drawFolder.some((s) => typeof s !== 'string' || !s.trim())) {
    errors.push('drawFolder segments must be non-empty strings');
  }
  if (!spec.presentations || typeof spec.presentations !== 'object') {
    errors.push('presentations is required');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true };
}

export function validateLibrary(library: SpecLibrary): ValidateResult {
  const errors: string[] = [];
  if (library.formatVersion !== SPECS_LIBRARY_FORMAT) {
    errors.push(`Unsupported formatVersion ${String(library.formatVersion)}`);
  }
  if (library.kind !== SPECS_LIBRARY_KIND) {
    errors.push(`Wrong kind (expected ${SPECS_LIBRARY_KIND})`);
  }
  if (!library.id?.trim()) errors.push('Library id is required');
  if (!library.name?.trim()) errors.push('Library name is required');

  const codes = new Set<number>();
  for (const spec of library.specifications ?? []) {
    const r = validateSpecification(spec);
    if (!r.ok) errors.push(...r.errors.map((e) => `${spec.code}: ${e}`));
    if (codes.has(spec.code)) errors.push(`Duplicate code ${spec.code}`);
    codes.add(spec.code);
  }

  const ids = new Set<string>();
  for (const list of [
    library.linetypes,
    library.hatches,
    library.textures,
    library.materials,
    library.specifications,
  ]) {
    for (const item of list ?? []) {
      if (!item?.id) continue;
      if (ids.has(item.id)) errors.push(`Duplicate id ${item.id}`);
      ids.add(item.id);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true };
}

/** Parent codes by decimal prefix (11 → 1, 111 → 11 → 1). */
export function ancestorCodes(code: SpecCode): SpecCode[] {
  if (!isValidSpecCode(code)) return [];
  const s = String(code);
  const out: SpecCode[] = [];
  for (let len = s.length - 1; len >= 1; len--) {
    out.push(Number(s.slice(0, len)));
  }
  return out;
}

export function childCodes(library: SpecLibrary, parent: SpecCode): Specification[] {
  const p = String(parent);
  return library.specifications
    .filter((s) => {
      const c = String(s.code);
      return c.length === p.length + 1 && c.startsWith(p);
    })
    .sort((a, b) => a.code - b.code);
}

export function roots(library: SpecLibrary): Specification[] {
  return library.specifications
    .filter((s) => String(s.code).length === 1)
    .sort((a, b) => a.code - b.code);
}

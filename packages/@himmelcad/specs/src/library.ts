import { createEmptyLibrary } from './defaults.js';
import type { SpecLibrary, Specification } from './types.js';
import { SPECS_LIBRARY_FORMAT, SPECS_LIBRARY_KIND } from './types.js';
import { isValidSpecCode, validateLibrary, validateSpecification } from './validate.js';

const STORAGE_KEY = 'himmelcad.specs.library.v1';

export function parseLibraryJson(
  raw: unknown,
): { ok: true; library: SpecLibrary } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['Not a JSON object'] };
  const lib = raw as SpecLibrary;
  const v = validateLibrary(lib);
  if (!v.ok) return v;
  return { ok: true, library: lib };
}

export function serializeLibrary(library: SpecLibrary): string {
  return `${JSON.stringify(library, null, 2)}\n`;
}

export function loadLibraryFromLocalStorage(): SpecLibrary {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyLibrary();
    const parsed = parseLibraryJson(JSON.parse(raw) as unknown);
    if (!parsed.ok) return createEmptyLibrary();
    return parsed.library;
  } catch {
    return createEmptyLibrary();
  }
}

export function saveLibraryToLocalStorage(library: SpecLibrary): void {
  const v = validateLibrary(library);
  if (!v.ok) throw new Error(v.errors.join('; '));
  localStorage.setItem(
    STORAGE_KEY,
    serializeLibrary({ ...library, updatedAt: new Date().toISOString() }),
  );
}

export function upsertSpecification(library: SpecLibrary, spec: Specification): SpecLibrary {
  const check = validateSpecification(spec);
  if (!check.ok) throw new Error(check.errors.join('; '));
  if (!isValidSpecCode(spec.code)) throw new Error('Invalid code');
  const others = library.specifications.filter((s) => s.id !== spec.id);
  if (others.some((s) => s.code === spec.code)) {
    throw new Error(`Code ${spec.code} already exists`);
  }
  const next: SpecLibrary = {
    ...library,
    specifications: [...others, { ...spec, updatedAt: new Date().toISOString() }].sort(
      (a, b) => a.code - b.code,
    ),
    updatedAt: new Date().toISOString(),
  };
  const v = validateLibrary(next);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return next;
}

export function removeSpecification(library: SpecLibrary, specId: string): SpecLibrary {
  return {
    ...library,
    specifications: library.specifications.filter((s) => s.id !== specId),
    updatedAt: new Date().toISOString(),
  };
}

export function findByCode(library: SpecLibrary, code: number): Specification | undefined {
  return library.specifications.find((s) => s.code === code);
}

export function emptyLibraryShell(name: string): SpecLibrary {
  return {
    formatVersion: SPECS_LIBRARY_FORMAT,
    kind: SPECS_LIBRARY_KIND,
    id: `lib_${Date.now().toString(36)}`,
    name,
    linetypes: [],
    hatches: [],
    textures: [],
    materials: [],
    specifications: [],
    updatedAt: new Date().toISOString(),
  };
}

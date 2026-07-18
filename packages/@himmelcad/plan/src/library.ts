import type { PlanLibrary, PlanLibraryItem } from './paper.js';
import { PLAN_LIBRARY_FORMAT, PLAN_LIBRARY_KIND } from './paper.js';

const KEY = 'himmelcad.plan.library.v1';

export function emptyPlanLibrary(): PlanLibrary {
  return { formatVersion: PLAN_LIBRARY_FORMAT, kind: PLAN_LIBRARY_KIND, items: [] };
}

export function loadPlanLibrary(): PlanLibrary {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyPlanLibrary();
    const parsed = JSON.parse(raw) as PlanLibrary;
    if (parsed.kind !== PLAN_LIBRARY_KIND) return emptyPlanLibrary();
    return parsed;
  } catch {
    return emptyPlanLibrary();
  }
}

export function savePlanLibrary(library: PlanLibrary): void {
  localStorage.setItem(KEY, JSON.stringify(library));
}

export function upsertLibraryItem(library: PlanLibrary, item: PlanLibraryItem): PlanLibrary {
  const others = library.items.filter((i) => i.id !== item.id);
  return { ...library, items: [item, ...others].slice(0, 100) };
}

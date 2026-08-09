import { planContentHash, type PlanElement, type PlanTemplateDefinition } from './document.js';
import { createPlanTemplate } from './templates.js';

export const PLAN_LIBRARY_KIND = 'himmelcadPlanLibrary' as const;
export const PLAN_LIBRARY_FORMAT = 2 as const;

export interface PlanLibrary {
  formatVersion: typeof PLAN_LIBRARY_FORMAT;
  kind: typeof PLAN_LIBRARY_KIND;
  scope: 'user';
  revision: number;
  templates: readonly PlanTemplateDefinition[];
  contentHash: string;
}

export interface PlanLibraryStorage {
  load(): string | null;
  save(serialized: string): void;
}

interface LegacyPlanLibraryV1 {
  formatVersion: 1;
  kind: typeof PLAN_LIBRARY_KIND;
  items: readonly {
    id: string;
    name: string;
    elementsJson: string;
  }[];
}

const KEY = 'himmelcad.plan.library.v2';
const LEGACY_KEY = 'himmelcad.plan.library.v1';

export function emptyPlanLibrary(): PlanLibrary {
  return rehashLibrary({
    formatVersion: PLAN_LIBRARY_FORMAT,
    kind: PLAN_LIBRARY_KIND,
    scope: 'user',
    revision: 1,
    templates: [],
    contentHash: '',
  });
}

export function browserPlanLibraryStorage(): PlanLibraryStorage | null {
  if (typeof localStorage === 'undefined') return null;
  return {
    load: () => localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY),
    save: (serialized) => localStorage.setItem(KEY, serialized),
  };
}

export function loadPlanLibrary(storage = browserPlanLibraryStorage()): PlanLibrary {
  if (!storage) return emptyPlanLibrary();
  try {
    const raw = storage.load();
    if (!raw) return emptyPlanLibrary();
    return parsePlanLibrary(raw);
  } catch {
    return emptyPlanLibrary();
  }
}

export function savePlanLibrary(library: PlanLibrary, storage = browserPlanLibraryStorage()): void {
  if (!storage) return;
  storage.save(serializePlanLibrary(library));
}

export function upsertLibraryTemplate(
  library: PlanLibrary,
  template: PlanTemplateDefinition,
): PlanLibrary {
  const templates = [
    template,
    ...library.templates.filter((item) => item.id !== template.id),
  ].slice(0, 200);
  return rehashLibrary({ ...library, revision: library.revision + 1, templates });
}

export function removeLibraryTemplate(library: PlanLibrary, id: string): PlanLibrary {
  const templates = library.templates.filter((template) => template.id !== id);
  if (templates.length === library.templates.length) return library;
  return rehashLibrary({ ...library, revision: library.revision + 1, templates });
}

export function serializePlanLibrary(library: PlanLibrary): string {
  return JSON.stringify(rehashLibrary(library), null, 2);
}

export function parsePlanLibrary(serialized: string): PlanLibrary {
  const value = JSON.parse(serialized) as unknown;
  if (!isRecord(value) || value.kind !== PLAN_LIBRARY_KIND)
    throw new Error('Invalid plan library.');
  if (value.formatVersion === PLAN_LIBRARY_FORMAT) {
    const library = value as unknown as PlanLibrary;
    const expected = rehashLibrary({ ...library, contentHash: '' });
    if (expected.contentHash !== library.contentHash)
      throw new Error('Plan library hash mismatch.');
    return library;
  }
  if (value.formatVersion !== 1) throw new Error('Unsupported plan library version.');
  return migrateLegacyLibrary(value as unknown as LegacyPlanLibraryV1);
}

function migrateLegacyLibrary(legacy: LegacyPlanLibraryV1): PlanLibrary {
  const templates = legacy.items.flatMap((item) => {
    try {
      const elements = JSON.parse(item.elementsJson) as unknown;
      if (!Array.isArray(elements)) return [];
      const bounds = elementBounds(elements as PlanElement[]);
      return [
        createPlanTemplate({
          id: item.id,
          revision: 1,
          name: item.name,
          kind: 'textGroup',
          scope: 'user',
          elements: elements as PlanElement[],
          widthMm: Math.max(1, bounds.width / 4),
          heightMm: Math.max(1, bounds.height / 4),
          anchors: [{ id: 'center', xMm: bounds.width / 8, yMm: bounds.height / 8 }],
          bindings: [],
        }),
      ];
    } catch {
      return [];
    }
  });
  return rehashLibrary({
    formatVersion: PLAN_LIBRARY_FORMAT,
    kind: PLAN_LIBRARY_KIND,
    scope: 'user',
    revision: 1,
    templates,
    contentHash: '',
  });
}

function rehashLibrary(library: PlanLibrary): PlanLibrary {
  const normalized = { ...library, contentHash: '' };
  return { ...normalized, contentHash: planContentHash(normalized, ['contentHash']) };
}

function elementBounds(elements: readonly PlanElement[]): { width: number; height: number } {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    const x = numberValue(element.x);
    const y = numberValue(element.y);
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x + numberValue(element.width));
    maximumY = Math.max(maximumY, y + numberValue(element.height));
  }
  if (!Number.isFinite(minimumX)) return { width: 1, height: 1 };
  return { width: maximumX - minimumX, height: maximumY - minimumY };
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

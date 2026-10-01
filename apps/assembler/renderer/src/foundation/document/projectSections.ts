/**
 * The runtime half of the module file-format contract (assembler/MODULES.md
 * §3 `fileFormatFields`): what a module keeps in the open project besides
 * the feature document — the items organisation, pinned measurements, saved
 * views, display settings — and how Save, Open/New and the unsaved-changes
 * flag reach it without the project lifecycle (`shell-ui/project/
 * projectStore.ts`) knowing the module. The file side (field validators, key
 * order) is `format.ts` (`registerProjectFileField`, `registerViewStatePart`).
 *
 * A module lists its sections in `defineAssemblerModule({ fileFormatFields })`;
 * foundation data registers with {@link registerProjectSection} directly.
 */
import type { ProjectFileFields, ProjectFileV1, ProjectViewState } from './format.js';

/** A section's part of the file being saved. */
export interface ProjectSectionData {
  /** Top-level fields (each registered with `registerProjectFileField`). */
  fields?: Partial<ProjectFileFields>;
  /** View-state parts (each registered with `registerViewStatePart`). */
  viewState?: ProjectViewState;
}

export interface ProjectSection {
  /** Unique id, e.g. `measure.pins`. */
  id: string;
  /**
   * Order in which sections save: their view-state parts merge in this
   * order, so a part two sections share keeps a stable key order (the
   * document store's `section` fields, then display's face plane).
   */
  order: number;
  /** This section's part of the file Save writes now. */
  save(): ProjectSectionData | Promise<ProjectSectionData>;
  /**
   * Restores the section from an opened (already validated) project, or
   * resets it for a new one (`null`). Optional parts are lenient: malformed
   * entries are dropped, never a reason to fail the open.
   */
  load(project: ProjectFileV1 | null): void;
  /** Calls `onChange` when the user changed the section's data (the project becomes unsaved). */
  subscribe?(onChange: () => void): () => void;
}

const sections: ProjectSection[] = [];
const watchers = new Set<(section: ProjectSection) => void>();

/** Registers a section (once per id). */
export function registerProjectSection(section: ProjectSection): void {
  const known = sections.find((s) => s.id === section.id);
  if (known) {
    if (known === section) return;
    throw new Error(`Project section "${section.id}" is registered twice`);
  }
  sections.push(section);
  sections.sort((a, b) => a.order - b.order);
  for (const watch of watchers) watch(section);
}

/** The registered sections, in save order. */
export function projectSections(): readonly ProjectSection[] {
  return sections;
}

/** Calls `watch` for every registered section now and for each one registered later. */
export function watchProjectSections(watch: (section: ProjectSection) => void): () => void {
  for (const section of sections) watch(section);
  watchers.add(watch);
  return () => watchers.delete(watch);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collects every section's part of the file: fields by key, view-state
 * parts merged in section order (a part two sections write — an object —
 * is merged key by key, the earlier section's keys first).
 */
export async function collectProjectSections(): Promise<{
  fields: Partial<ProjectFileFields>;
  viewState: ProjectViewState;
}> {
  const parts = await Promise.all(sections.map((section) => section.save()));
  const fields: Record<string, unknown> = {};
  const viewState: Record<string, unknown> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part.fields ?? {})) {
      if (value !== undefined) fields[key] = value;
    }
    for (const [key, value] of Object.entries(part.viewState ?? {})) {
      if (value === undefined) continue;
      const previous = viewState[key];
      viewState[key] =
        isPlainObject(previous) && isPlainObject(value) ? { ...previous, ...value } : value;
    }
  }
  return {
    fields: fields as Partial<ProjectFileFields>,
    viewState: viewState as ProjectViewState,
  };
}

/** Restores every section from `project` (`null`: a new project). */
export function loadProjectSections(project: ProjectFileV1 | null): void {
  for (const section of sections) section.load(project);
}

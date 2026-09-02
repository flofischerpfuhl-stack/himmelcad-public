export interface RecentProject {
  readonly name: string;
  readonly path: string;
  readonly lastOpenedUnixMs: number;
}

export interface UntitledProjectInspection {
  readonly path: string;
  readonly directoryName: string;
  readonly modifiedUnixMs: number;
  readonly imageCount: number;
}

export type WorkingCopyDurability =
  | { readonly kind: 'durable'; readonly storedAtUnixMs: number }
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly reason: string };

export type StoredIndicatorState =
  | { readonly kind: 'noProject' }
  | {
      readonly kind: 'durable';
      readonly archiveChanges: number;
      readonly hasArchiveCopy: boolean;
      readonly storedAtUnixMs: number;
    }
  | {
      readonly kind: 'pending';
      readonly archiveChanges: number;
      readonly hasArchiveCopy: boolean;
    }
  | {
      readonly kind: 'failed';
      readonly archiveChanges: number;
      readonly hasArchiveCopy: boolean;
      readonly reason: string;
    };

const MAX_RECENT_PROJECTS = 10;
export const UNTITLED_PROJECT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

export function updateRecentProjects(
  recent: readonly RecentProject[],
  opened: RecentProject,
): RecentProject[] {
  return [opened, ...recent.filter((candidate) => candidate.path !== opened.path)]
    .sort((left, right) => right.lastOpenedUnixMs - left.lastOpenedUnixMs)
    .slice(0, MAX_RECENT_PROJECTS);
}

export function removeRecentProject(
  recent: readonly RecentProject[],
  path: string,
): RecentProject[] {
  return recent.filter((candidate) => candidate.path !== path);
}

export function selectUntitledLitterCandidates(
  projects: readonly UntitledProjectInspection[],
  nowUnixMs: number,
): UntitledProjectInspection[] {
  return projects.filter(
    (project) =>
      /^Untitled-.+\.hcad$/i.test(project.directoryName) &&
      project.imageCount === 0 &&
      nowUnixMs - project.modifiedUnixMs > UNTITLED_PROJECT_MAX_AGE_MS,
  );
}

export function storedIndicatorState(input: {
  readonly projectReady: boolean;
  readonly durability: WorkingCopyDurability;
  readonly autosaveGeneration: number;
  readonly lastSavedGeneration: number;
  readonly hasArchiveCopy: boolean;
}): StoredIndicatorState {
  if (!input.projectReady) return { kind: 'noProject' };
  const archive = {
    archiveChanges: Math.max(0, input.autosaveGeneration - input.lastSavedGeneration),
    hasArchiveCopy: input.hasArchiveCopy,
  };
  switch (input.durability.kind) {
    case 'durable':
      return { ...archive, kind: 'durable', storedAtUnixMs: input.durability.storedAtUnixMs };
    case 'pending':
      return { ...archive, kind: 'pending' };
    case 'failed':
      return { ...archive, kind: 'failed', reason: input.durability.reason };
  }
}

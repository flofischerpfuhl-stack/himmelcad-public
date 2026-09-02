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

export interface ProjectGenerationSnapshot {
  readonly autosaveGeneration: number;
  readonly lastSavedGeneration: number;
}

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

export function closeGuardDecision(snapshot: ProjectGenerationSnapshot | null): 'prompt' | 'close' {
  return snapshot && snapshot.autosaveGeneration !== snapshot.lastSavedGeneration
    ? 'prompt'
    : 'close';
}

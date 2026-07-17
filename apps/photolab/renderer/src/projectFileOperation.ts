export type ProjectFileOperationKind = 'create' | 'open' | 'save' | 'saveAs';

export interface ProjectArchiveOperationRequest {
  archiveOperationId: string;
  progressKey: string;
}

export interface ProjectArchiveProgress {
  phase: 'scanning' | 'packing' | 'validating' | 'extracting' | 'committing';
  filesCompleted: number;
  filesTotal: number;
  bytesCompleted: number;
  bytesTotal: number;
  currentPath?: string;
}

export interface ProjectProgressEvent {
  progressKey: string;
  operationId?: string;
  fraction: number;
  message: string;
  archive?: ProjectArchiveProgress;
}

export interface ProjectFileOperationState extends ProjectArchiveOperationRequest {
  kind: ProjectFileOperationKind;
  title: string;
  fraction: number;
  message: string;
  archive?: ProjectArchiveProgress;
  cancelRequested: boolean;
  error?: string;
}

const TITLES: Record<ProjectFileOperationKind, string> = {
  create: 'Creating project',
  open: 'Opening project',
  save: 'Saving project',
  saveAs: 'Saving project as',
};

export function createProjectFileOperation(
  kind: ProjectFileOperationKind,
  id = crypto.randomUUID(),
): ProjectFileOperationState {
  return {
    kind,
    title: TITLES[kind],
    archiveOperationId: `archive-${kind}-${id}`,
    progressKey: `project-${kind}:${id}`,
    fraction: 0,
    message: kind === 'open' ? 'Choose a project to open' : 'Preparing project operation',
    cancelRequested: false,
  };
}

export function applyProjectProgress(
  state: ProjectFileOperationState,
  event: ProjectProgressEvent,
): ProjectFileOperationState {
  if (event.progressKey !== state.progressKey) return state;
  if (event.operationId && event.operationId !== state.archiveOperationId) return state;
  const archive = event.archive ?? state.archive;
  return {
    ...state,
    // Defensive monotonicity protects the UX from stale/out-of-order stderr chunks.
    fraction: Math.max(state.fraction, clampFraction(event.fraction)),
    message: event.message,
    ...(archive ? { archive } : {}),
  };
}

export function requestProjectCancellation(
  state: ProjectFileOperationState,
): ProjectFileOperationState {
  if (state.error) return state;
  return { ...state, cancelRequested: true, message: 'Cancellation requested…' };
}

export function failProjectFileOperation(
  state: ProjectFileOperationState,
  error: string,
): ProjectFileOperationState {
  return { ...state, error, message: 'Project operation failed' };
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

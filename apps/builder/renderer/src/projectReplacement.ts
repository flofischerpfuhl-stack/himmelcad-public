export interface ProjectReplacementFailure {
  readonly targetRoot: string;
  readonly reason: string;
  readonly recoveredRoot: string | null;
  readonly recoveryReason: string | null;
}

export interface ProjectReplacementResult {
  readonly activeRoot: string | null;
  readonly failure: ProjectReplacementFailure | null;
}

export interface ProjectReplacementOperations {
  readonly currentRoot: string | null;
  closeCurrent(): Promise<boolean>;
  prepare(root: string): Promise<void>;
  openPrepared(): Promise<void>;
  discardFailed(): Promise<void>;
}

/**
 * Replaces the sidecar project while the React shell remains mounted. A failed
 * target is discarded and the previous project is reopened before returning.
 */
export async function replaceProjectWithRecovery(
  targetRoot: string,
  operations: ProjectReplacementOperations,
): Promise<ProjectReplacementResult> {
  if (!targetRoot.trim()) throw new TypeError('replacement project root is required');
  if (targetRoot === operations.currentRoot) {
    return { activeRoot: targetRoot, failure: null };
  }
  if (!(await operations.closeCurrent())) {
    return {
      activeRoot: operations.currentRoot,
      failure: {
        targetRoot,
        reason: 'The current project could not be stored and closed.',
        recoveredRoot: operations.currentRoot,
        recoveryReason: null,
      },
    };
  }

  await operations.prepare(targetRoot);
  try {
    await operations.openPrepared();
    return { activeRoot: targetRoot, failure: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await operations.discardFailed();
    if (!operations.currentRoot) {
      return {
        activeRoot: null,
        failure: { targetRoot, reason, recoveredRoot: null, recoveryReason: null },
      };
    }
    await operations.prepare(operations.currentRoot);
    try {
      await operations.openPrepared();
      return {
        activeRoot: operations.currentRoot,
        failure: {
          targetRoot,
          reason,
          recoveredRoot: operations.currentRoot,
          recoveryReason: null,
        },
      };
    } catch (recoveryError) {
      return {
        activeRoot: null,
        failure: {
          targetRoot,
          reason,
          recoveredRoot: null,
          recoveryReason:
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
        },
      };
    }
  }
}

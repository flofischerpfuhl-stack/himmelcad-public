/**
 * Saved import workflows (Image / GCP) and dual-path grid resolution.
 * Paths: always store absolute + relative; resolve absolute first, then relative.
 */

import type { LocalGridSelection } from './ImageImportPanel.js';
import type { GcpColumnSelection } from './gcpCsvMapping.js';

export type TransformMode = 'none' | 'separate' | 'combined';
export type YesNo = 'yes' | 'no';
export type GridPolicy = 'ntv2' | 'projOnly' | null;

export interface StoredGridRef {
  filename: string;
  kind: LocalGridSelection['kind'];
  driver: string;
  coverage: LocalGridSelection['coverage'];
  absolutePath: string;
  relativePath: string;
  localPath: string;
}

/** Snapshot of the chosen PROJ operation so load can skip re-picking. */
export interface StoredOperation {
  operationId: string;
  name: string;
  kind: 'general' | 'gaussKruegerDatumTransformation';
  projPipeline: string;
  areaOfUse: {
    westLongitude: number;
    southLatitude: number;
    eastLongitude: number;
    northLatitude: number;
  };
  expectedAccuracyMm?: number;
  ballpark: boolean;
  bestAvailable: boolean;
  requiredGrids: Array<{
    kind?: 'ntv2' | 'gtg' | 'geoid';
    officialFilename: string;
    officialSha256?: string;
    license?: {
      licenseName: string;
      spdxExpression?: string;
      source: string;
      redistributionAllowed: boolean;
    };
    coverage?: StoredGridRef['coverage'];
    availability:
      | { state: 'missing' }
      | {
          state: 'presentVerified';
          localPath?: string;
          local_path?: string;
          observedSha256?: string;
        };
  }>;
}

export interface ImageImportWorkflow {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  kind: 'image';
  savedAt: string;
  mode: TransformMode;
  doVertical: YesNo | null;
  doHorizontal: YesNo | null;
  sourceHorizontalEpsg: number;
  targetHorizontalEpsg: number;
  sourceVerticalEpsg: number;
  targetVerticalEpsg: number;
  gridPolicy: GridPolicy;
  verticalGrid: StoredGridRef | null;
  horizontalGrid: StoredGridRef | null;
  /** Chosen PROJ op at save time — required for full restore past the operations step. */
  operation?: StoredOperation | null;
  /** True when NTv2/geoid steps after the op were finished (or not needed). */
  gridStepCompleted?: boolean;
  /** PROJ/EPSG audit from discovery so freeze does not need a re-discover. */
  discoveryAudit?: { projVersion: string; epsgDatabaseVersion: string };
  discoveryWarnings?: string[];
}

export interface GcpImportWorkflow {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  kind: 'gcp';
  savedAt: string;
  mode: TransformMode;
  doVertical: YesNo | null;
  doHorizontal: YesNo | null;
  sourceCrsEpsg: number;
  sourceVerticalEpsg: number;
  targetVerticalEpsg: number;
  gridPolicy: GridPolicy;
  verticalGrid?: StoredGridRef | null;
  horizontalGrid: StoredGridRef | null;
  delimiter: string;
  decimalSeparator: 'point' | 'comma';
  hasHeader: boolean;
  columns: Pick<GcpColumnSelection, 'name' | 'east' | 'north' | 'height'> &
    Partial<Omit<GcpColumnSelection, 'name' | 'east' | 'north' | 'height'>>;
  role: string;
  horizontalStddev: number;
  heightStddev: number;
}

export type ImportWorkflow = ImageImportWorkflow | GcpImportWorkflow;

export const LEGACY_WORKFLOW_KEY = 'himmelcad.photolab.importWorkflows';

export interface LegacyWorkflowMigrationPlan {
  readonly workflows: readonly ImportWorkflow[];
}

/** Pure compatibility parser used before moving old GCP workflows to `.hcimport` files. */
export function legacyWorkflowMigrationPlan(raw: string | null): LegacyWorkflowMigrationPlan {
  if (!raw) return { workflows: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { workflows: [] };
    const workflows = parsed.filter(isImportWorkflow);
    return {
      workflows: workflows.map((item) => ({ ...item, description: item.description ?? '' })),
    };
  } catch {
    return { workflows: [] };
  }
}

function isImportWorkflow(value: unknown): value is ImportWorkflow {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImportWorkflow>;
  return (
    candidate.schemaVersion === 1 &&
    (candidate.kind === 'image' || candidate.kind === 'gcp') &&
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.savedAt === 'string'
  );
}

export function enrichGridPaths(
  selection: LocalGridSelection,
  projectDir: string | null,
): LocalGridSelection {
  const absolutePath = isAbsolute(selection.localPath) ? selection.localPath : selection.localPath;
  const relativePath =
    projectDir && absolutePath.startsWith(projectDir)
      ? absolutePath.slice(projectDir.length).replace(/^[/\\]/, '')
      : selection.filename;
  return {
    ...selection,
    absolutePath,
    relativePath,
    localPath: absolutePath,
  };
}

export function toStoredGrid(selection: LocalGridSelection): StoredGridRef {
  const absolutePath = selection.absolutePath ?? selection.localPath;
  const relativePath = selection.relativePath ?? selection.filename;
  return {
    filename: selection.filename,
    kind: selection.kind,
    driver: selection.driver,
    coverage: selection.coverage,
    absolutePath,
    relativePath,
    localPath: selection.localPath,
  };
}

export async function resolveStoredGrid(
  stored: StoredGridRef,
  projectDir: string | null,
  pathExists: (path: string) => Promise<boolean>,
): Promise<LocalGridSelection | null> {
  const candidates: string[] = [];
  if (stored.absolutePath) candidates.push(stored.absolutePath);
  if (stored.relativePath) {
    if (projectDir) candidates.push(joinPath(projectDir, stored.relativePath));
    candidates.push(stored.relativePath);
  }
  if (stored.localPath) candidates.push(stored.localPath);

  for (const path of candidates) {
    if (!path) continue;
    try {
      if (await pathExists(path)) {
        return {
          filename: stored.filename,
          localPath: path,
          absolutePath: isAbsolute(path) ? path : stored.absolutePath,
          relativePath: stored.relativePath,
          kind: stored.kind,
          driver: stored.driver,
          coverage: stored.coverage,
        };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export function warningsForOperation(warnings: readonly string[], operationName: string): string[] {
  const base = operationName.replace(/\s*·\s*local grid override\s*$/i, '').trim();
  return warnings.filter(
    (warning) =>
      warning.includes(operationName) ||
      warning.includes(base) ||
      (warning.startsWith('The selected local grids') && operationName.includes('local')),
  );
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function joinPath(root: string, relative: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[/\\]$/, '')}${sep}${relative.replace(/^[/\\]/, '')}`;
}

/**
 * Saved import workflows (Image / GCP) and dual-path grid resolution.
 * Paths: always store absolute + relative; resolve absolute first, then relative.
 */

import type { LocalGridSelection } from './ImageImportPanel.js';

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
  columns: { name: string; east: string; north: string; height: string };
  role: string;
  horizontalStddev: number;
  heightStddev: number;
}

export type ImportWorkflow = ImageImportWorkflow | GcpImportWorkflow;

const WORKFLOW_KEY = 'himmelcad.photolab.importWorkflows';
const MAX_WORKFLOWS = 24;

export function listWorkflows(kind: 'image' | 'gcp'): ImportWorkflow[] {
  try {
    const raw = localStorage.getItem(WORKFLOW_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ImportWorkflow[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && item.kind === kind && item.schemaVersion === 1)
      .map((item) => ({
        ...item,
        description:
          'description' in item && typeof item.description === 'string' ? item.description : '',
      }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function workflowNameExists(
  kind: 'image' | 'gcp',
  name: string,
  exceptId?: string,
): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return listWorkflows(kind).some(
    (item) => item.id !== exceptId && item.name.trim().toLowerCase() === normalized,
  );
}

export function saveWorkflow(
  workflow: ImportWorkflow,
): { ok: true } | { ok: false; error: string } {
  const name = workflow.name.trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (workflowNameExists(workflow.kind, name, workflow.id)) {
    return { ok: false, error: `A workflow named “${name}” already exists.` };
  }
  const all = loadAll().filter((item) => item.id !== workflow.id);
  all.unshift({ ...workflow, name, description: workflow.description.trim() });
  localStorage.setItem(WORKFLOW_KEY, JSON.stringify(all.slice(0, MAX_WORKFLOWS)));
  return { ok: true };
}

function loadAll(): ImportWorkflow[] {
  try {
    const raw = localStorage.getItem(WORKFLOW_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ImportWorkflow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function deleteWorkflow(id: string): void {
  localStorage.setItem(WORKFLOW_KEY, JSON.stringify(loadAll().filter((item) => item.id !== id)));
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

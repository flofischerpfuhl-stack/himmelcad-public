import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { removeRecentProject, updateRecentProjects, type RecentProject } from './projectLifecycle';

export type { RecentProject } from './projectLifecycle';

export type DirectoryPreference =
  | 'project'
  | 'image'
  | 'export'
  | 'batch'
  | 'verticalGrid'
  | 'horizontalGrid'
  | 'importWorkflow'
  | 'alignmentPreset';

export type GcpCsvDefaultRole =
  | 'controlXyz'
  | 'controlXy'
  | 'controlZ'
  | 'checkpointXyz'
  | 'checkpointXy'
  | 'checkpointZ'
  | 'disabled';

export interface GcpCsvImportDefaults {
  delimiter: string;
  decimalSeparator: 'point' | 'comma';
  hasHeader: boolean;
  columns: { name: string; east: string; north: string; height: string };
  role: GcpCsvDefaultRole;
  horizontalStddev: number;
  heightStddev: number;
}

interface PhotolabPreferencesV3 {
  schemaVersion: 3;
  lastProjectPath: string | null;
  recentProjects: RecentProject[];
  directories: Record<DirectoryPreference, string | null>;
  gcpCsvImportDefaults: GcpCsvImportDefaults;
}

const DEFAULT_GCP_CSV_IMPORT: GcpCsvImportDefaults = {
  delimiter: ';',
  decimalSeparator: 'comma',
  hasHeader: true,
  columns: { name: '0', east: '1', north: '2', height: '3' },
  role: 'controlXyz',
  horizontalStddev: 0.02,
  heightStddev: 0.03,
};

const EMPTY_PREFERENCES: PhotolabPreferencesV3 = {
  schemaVersion: 3,
  lastProjectPath: null,
  recentProjects: [],
  directories: {
    project: null,
    image: null,
    export: null,
    batch: null,
    verticalGrid: null,
    horizontalGrid: null,
    importWorkflow: null,
    alignmentPreset: null,
  },
  gcpCsvImportDefaults: DEFAULT_GCP_CSV_IMPORT,
};

/** Versioned, process-local preferences with serialized atomic persistence. */
export class PhotolabPreferencesService {
  private value: PhotolabPreferencesV3 | null = null;
  private writes: Promise<void> = Promise.resolve();

  public constructor(private readonly path: string) {}

  public async directory(key: DirectoryPreference): Promise<string | null> {
    return (await this.load()).directories[key];
  }

  public async rememberDirectory(key: DirectoryPreference, path: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error(`Preference directory must be absolute: ${path}`);
    const value = await this.load();
    value.directories[key] = resolve(path);
    await this.persist(value);
  }

  public async lastProjectPath(): Promise<string | null> {
    return (await this.load()).lastProjectPath;
  }

  public async rememberLastProjectPath(path: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error(`Last project path must be absolute: ${path}`);
    const value = await this.load();
    value.lastProjectPath = resolve(path);
    await this.persist(value);
  }

  public async recentProjects(): Promise<RecentProject[]> {
    return structuredClone((await this.load()).recentProjects);
  }

  public async rememberRecentProject(project: RecentProject): Promise<void> {
    if (!isAbsolute(project.path)) {
      throw new Error(`Recent project path must be absolute: ${project.path}`);
    }
    const value = await this.load();
    value.recentProjects = updateRecentProjects(value.recentProjects, {
      ...project,
      path: resolve(project.path),
    });
    await this.persist(value);
  }

  public async removeRecentProject(path: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error(`Recent project path must be absolute: ${path}`);
    const value = await this.load();
    value.recentProjects = removeRecentProject(value.recentProjects, resolve(path));
    if (value.lastProjectPath === resolve(path)) value.lastProjectPath = null;
    await this.persist(value);
  }

  public async gcpCsvImportDefaults(): Promise<GcpCsvImportDefaults> {
    return structuredClone((await this.load()).gcpCsvImportDefaults);
  }

  public async rememberGcpCsvImportDefaults(value: unknown): Promise<void> {
    const preferences = await this.load();
    preferences.gcpCsvImportDefaults = parseGcpCsvImportDefaults(value);
    await this.persist(preferences);
  }

  private async load(): Promise<PhotolabPreferencesV3> {
    if (this.value) return this.value;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      this.value = parsePreferences(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT')
        console.warn(`PhotoLab preferences could not be read: ${String(error)}`);
      this.value = structuredClone(EMPTY_PREFERENCES);
    }
    return this.value;
  }

  private async persist(value: PhotolabPreferencesV3): Promise<void> {
    const snapshot = structuredClone(value);
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => writeAtomically(this.path, snapshot));
    await this.writes;
  }
}

function parsePreferences(value: unknown): PhotolabPreferencesV3 {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)
  )
    return structuredClone(EMPTY_PREFERENCES);
  const directories = isRecord(value.directories) ? value.directories : {};
  return {
    schemaVersion: 3,
    lastProjectPath: absolutePathOrNull(value.lastProjectPath),
    recentProjects:
      value.schemaVersion === 3 && Array.isArray(value.recentProjects)
        ? value.recentProjects.flatMap(parseRecentProject)
        : [],
    directories: {
      project: absolutePathOrNull(directories.project),
      image: absolutePathOrNull(directories.image),
      export: absolutePathOrNull(directories.export),
      batch: absolutePathOrNull(directories.batch),
      verticalGrid: absolutePathOrNull(directories.verticalGrid),
      horizontalGrid: absolutePathOrNull(directories.horizontalGrid),
      importWorkflow: absolutePathOrNull(directories.importWorkflow),
      alignmentPreset: absolutePathOrNull(directories.alignmentPreset),
    },
    gcpCsvImportDefaults:
      value.schemaVersion === 2 || value.schemaVersion === 3
        ? parseGcpCsvImportDefaultsOrDefault(value.gcpCsvImportDefaults)
        : structuredClone(DEFAULT_GCP_CSV_IMPORT),
  };
}

function parseRecentProject(value: unknown): RecentProject[] {
  if (!isRecord(value)) return [];
  const path = absolutePathOrNull(value.path);
  if (
    !path ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    value.name.length > 512 ||
    typeof value.lastOpenedUnixMs !== 'number' ||
    !Number.isSafeInteger(value.lastOpenedUnixMs) ||
    value.lastOpenedUnixMs < 0
  ) {
    return [];
  }
  return [{ name: value.name, path, lastOpenedUnixMs: value.lastOpenedUnixMs }];
}

async function writeAtomically(path: string, value: PhotolabPreferencesV3): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseGcpCsvImportDefaults(value: unknown): GcpCsvImportDefaults {
  if (!isRecord(value)) throw new Error('Invalid GCP CSV import preferences');
  const delimiter = value.delimiter;
  const decimalSeparator = value.decimalSeparator;
  const hasHeader = value.hasHeader;
  const columns = value.columns;
  const role = value.role;
  const horizontalStddev = value.horizontalStddev;
  const heightStddev = value.heightStddev;
  if (
    typeof delimiter !== 'string' ||
    [...delimiter].length !== 1 ||
    /[\r\n]/.test(delimiter) ||
    (decimalSeparator !== 'point' && decimalSeparator !== 'comma') ||
    typeof hasHeader !== 'boolean' ||
    !isRecord(columns) ||
    !validColumn(columns.name) ||
    !validColumn(columns.east) ||
    !validColumn(columns.north) ||
    !validColumn(columns.height) ||
    !isGcpRole(role) ||
    !validStddev(horizontalStddev) ||
    !validStddev(heightStddev)
  ) {
    throw new Error('Invalid GCP CSV import preferences');
  }
  return {
    delimiter,
    decimalSeparator,
    hasHeader,
    columns: {
      name: columns.name,
      east: columns.east,
      north: columns.north,
      height: columns.height,
    },
    role,
    horizontalStddev,
    heightStddev,
  };
}

function parseGcpCsvImportDefaultsOrDefault(value: unknown): GcpCsvImportDefaults {
  try {
    return parseGcpCsvImportDefaults(value);
  } catch {
    return structuredClone(DEFAULT_GCP_CSV_IMPORT);
  }
}

function validColumn(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validStddev(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

function isGcpRole(value: unknown): value is GcpCsvDefaultRole {
  return (
    value === 'controlXyz' ||
    value === 'controlXy' ||
    value === 'controlZ' ||
    value === 'checkpointXyz' ||
    value === 'checkpointXy' ||
    value === 'checkpointZ' ||
    value === 'disabled'
  );
}

function absolutePathOrNull(value: unknown): string | null {
  return typeof value === 'string' && isAbsolute(value) ? resolve(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

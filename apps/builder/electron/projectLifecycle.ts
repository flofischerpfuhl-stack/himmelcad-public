import { promises as fs } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

export const DEFAULT_RECENT_PROJECT_LIMIT = 10;

export interface RecentProjectEntry {
  readonly path: string;
  readonly name: string;
  readonly openedAtUnixMs: number;
}

interface ProjectLifecycleFileV1 {
  readonly schemaVersion: 1;
  readonly lastProjectPath: string | null;
  readonly recent: readonly RecentProjectEntry[];
}

export class BuilderProjectLifecycleStore {
  private state: ProjectLifecycleFileV1 = {
    schemaVersion: 1,
    lastProjectPath: null,
    recent: [],
  };
  private persistTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly maximumRecent = recentProjectLimitFromEnvironment(),
  ) {
    if (!Number.isSafeInteger(maximumRecent) || maximumRecent < 1 || maximumRecent > 100) {
      throw new RangeError('recent project limit must be between 1 and 100');
    }
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.path, 'utf8')) as unknown;
      this.state = parseLifecycleFile(parsed, this.maximumRecent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A damaged preference must not prevent access to the durable projects.
        console.warn(`[project-lifecycle] ignored invalid preferences: ${String(error)}`);
      }
    }
  }

  recent(): readonly RecentProjectEntry[] {
    return this.state.recent;
  }

  lastProjectPath(): string | null {
    return this.state.lastProjectPath;
  }

  async opened(projectPath: string): Promise<readonly RecentProjectEntry[]> {
    const normalized = resolve(projectPath);
    const entry: RecentProjectEntry = {
      path: normalized,
      name: projectDisplayName(normalized),
      openedAtUnixMs: Date.now(),
    };
    this.state = {
      schemaVersion: 1,
      lastProjectPath: normalized,
      recent: [entry, ...this.state.recent.filter((item) => item.path !== normalized)].slice(
        0,
        this.maximumRecent,
      ),
    };
    await this.persist();
    return this.state.recent;
  }

  async forget(projectPath: string): Promise<void> {
    const normalized = resolve(projectPath);
    this.state = {
      ...this.state,
      lastProjectPath:
        this.state.lastProjectPath === normalized ? null : this.state.lastProjectPath,
      recent: this.state.recent.filter((item) => item.path !== normalized),
    };
    await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot = this.state;
    const write = this.persistTail.then(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true });
      const candidate = `${this.path}.tmp-${process.pid}`;
      await fs.writeFile(candidate, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'w' });
      const file = await fs.open(candidate, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(candidate, this.path);
      try {
        const directory = await fs.open(dirname(this.path), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (process.platform !== 'win32') throw error;
      }
    });
    this.persistTail = write.catch(() => undefined);
    await write;
  }
}

export function recentProjectLimitFromEnvironment(
  value = process.env.HCAD_RECENT_PROJECT_LIMIT,
): number {
  if (!value?.trim()) return DEFAULT_RECENT_PROJECT_LIMIT;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : DEFAULT_RECENT_PROJECT_LIMIT;
}

export function withProjectExtension(path: string): string {
  return extname(path).toLowerCase() === '.hcad' ? path : `${path}.hcad`;
}

export function withArchiveExtension(path: string): string {
  return extname(path).toLowerCase() === '.hcadx' ? path : `${path}.hcadx`;
}

export function projectDisplayName(path: string): string {
  return basename(path).replace(/\.(hcadx?|HCADX?)$/, '') || 'Untitled';
}

function parseLifecycleFile(value: unknown, limit: number): ProjectLifecycleFileV1 {
  if (!value || typeof value !== 'object') throw new Error('preferences are not an object');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.recent)) {
    throw new Error('unsupported project lifecycle preferences');
  }
  const recent = candidate.recent.flatMap((item): RecentProjectEntry[] => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.path !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.openedAtUnixMs !== 'number' ||
      !Number.isSafeInteger(entry.openedAtUnixMs)
    ) {
      return [];
    }
    return [{ path: resolve(entry.path), name: entry.name, openedAtUnixMs: entry.openedAtUnixMs }];
  });
  return {
    schemaVersion: 1,
    lastProjectPath:
      typeof candidate.lastProjectPath === 'string' ? resolve(candidate.lastProjectPath) : null,
    recent: recent.slice(0, limit),
  };
}

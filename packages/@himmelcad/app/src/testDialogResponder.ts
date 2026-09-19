export type TestDialogResponse =
  | {
      readonly kind: 'open';
      readonly canceled: boolean;
      readonly filePaths: readonly string[];
    }
  | {
      readonly kind: 'save';
      readonly canceled: boolean;
      readonly filePath?: string;
    };

export interface TestDialogResponderOptions {
  readonly isPackaged: boolean;
  readonly queuePath?: string;
  readonly log?: (event: 'dialog.responded', response: TestDialogResponse) => void;
}

/**
 * Development-only adapter for native dialogs that CDP cannot drive.
 *
 * The packaged-build guard is deliberately constructor-owned rather than left
 * to callers, so setting the environment variable can never activate this
 * path in a distributed application.
 */
export class TestDialogResponder {
  private readonly queuePath: string | null;
  private readonly log: (event: 'dialog.responded', response: TestDialogResponse) => void;

  constructor(options: TestDialogResponderOptions) {
    this.queuePath =
      !options.isPackaged && options.queuePath?.trim()
        ? options.queuePath.trim()
        : null;
    this.log = options.log ?? (() => undefined);
  }

  enabled(): boolean {
    return this.queuePath !== null;
  }

  async open(): Promise<{ canceled: boolean; filePaths: string[] } | null> {
    const response = await this.pop('open');
    return response
      ? { canceled: response.canceled, filePaths: [...response.filePaths] }
      : null;
  }

  async save(): Promise<{ canceled: boolean; filePath: string } | null> {
    const response = await this.pop('save');
    if (!response) return null;
    return { canceled: response.canceled, filePath: response.filePath ?? '' };
  }

  private async pop<K extends TestDialogResponse['kind']>(
    kind: K,
  ): Promise<Extract<TestDialogResponse, { readonly kind: K }> | null> {
    if (!this.queuePath) return null;
    return withQueueLock(this.queuePath, async () => {
      const queue = await readQueue(this.queuePath!);
      const next = queue[0];
      if (!next) throw new Error(`Test dialog queue is empty; expected ${kind} response.`);
      if (next.kind !== kind) {
        throw new Error(`Test dialog queue expected ${kind}, but next response is ${next.kind}.`);
      }
      await writeQueue(this.queuePath!, queue.slice(1));
      this.log('dialog.responded', next);
      return next as Extract<TestDialogResponse, { readonly kind: K }>;
    });
  }
}

export function parseTestDialogQueue(value: unknown): TestDialogResponse[] {
  if (!Array.isArray(value)) throw new TypeError('Test dialog queue must be a JSON array.');
  return value.map((item, index) => parseResponse(item, index));
}

async function readQueue(path: string): Promise<TestDialogResponse[]> {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(path, 'utf8');
  return parseTestDialogQueue(JSON.parse(source) as unknown);
}

async function writeQueue(path: string, queue: readonly TestDialogResponse[]): Promise<void> {
  const fs = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await fs.mkdir(dirname(path), { recursive: true });
  const pending = `${path}.pending-${process.pid}`;
  await fs.writeFile(pending, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(pending, path);
}

async function withQueueLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const fs = await import('node:fs/promises');
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error) || Date.now() >= deadline) {
        throw new Error(`Could not lock test dialog queue: ${path}`, { cause: error });
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rmdir(lockPath).catch(() => undefined);
  }
}

function parseResponse(value: unknown, index: number): TestDialogResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Test dialog response ${index} must be an object.`);
  }
  const response = value as Record<string, unknown>;
  if (response.kind !== 'open' && response.kind !== 'save') {
    throw new TypeError(`Test dialog response ${index} has an invalid kind.`);
  }
  if (typeof response.canceled !== 'boolean') {
    throw new TypeError(`Test dialog response ${index} requires canceled.`);
  }
  if (response.kind === 'open') {
    if (!Array.isArray(response.filePaths) || !response.filePaths.every(isNonEmptyString)) {
      throw new TypeError(`Open dialog response ${index} requires filePaths.`);
    }
    return {
      kind: 'open',
      canceled: response.canceled,
      filePaths: [...response.filePaths],
    };
  }
  if (response.filePath !== undefined && !isNonEmptyString(response.filePath)) {
    throw new TypeError(`Save dialog response ${index} has an invalid filePath.`);
  }
  return response.filePath === undefined
    ? { kind: 'save', canceled: response.canceled }
    : { kind: 'save', canceled: response.canceled, filePath: response.filePath };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

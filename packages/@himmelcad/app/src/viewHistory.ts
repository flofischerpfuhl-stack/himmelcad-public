import type { LocalHistoryV1 } from '@himmelcad/data/canonical';

export interface ViewHistoryPersistence {
  load(projectId: string): Promise<unknown | null>;
  store(projectId: string, record: unknown): Promise<void>;
}

/** The S-04 storage strategy: one atomic localStorage publication per project/stream. */
export class LocalStorageViewHistoryPersistence implements ViewHistoryPersistence {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly stream: 'camera' | 'display',
  ) {}
  async load(projectId: string): Promise<unknown | null> {
    const value = this.storage.getItem(`hcad.${this.stream}.v1:${projectId}`);
    return value === null ? null : JSON.parse(value);
  }
  async store(projectId: string, record: unknown): Promise<void> {
    this.storage.setItem(`hcad.${this.stream}.v1:${projectId}`, JSON.stringify(record));
  }
}

/** P8 stream, with no document client. Preview stays outside commit(). */
export class ViewLocalHistory<T> {
  private history: LocalHistoryV1;
  private state: T;
  private tail = Promise.resolve();
  private ready = false;
  constructor(
    private readonly projectId: string,
    private readonly stream: 'display' | 'camera',
    baseline: T,
    private readonly parse: (input: unknown) => T,
    private readonly persistence: ViewHistoryPersistence,
    private readonly report: (message: string) => void = () => undefined,
  ) {
    this.state = structuredClone(parse(baseline));
    this.history = this.empty();
  }
  get current(): T {
    return structuredClone(this.state);
  }
  get canUndo(): boolean {
    return this.history.cursor > 0;
  }
  get canRedo(): boolean {
    return this.history.cursor < this.history.head;
  }
  get snapshot(): LocalHistoryV1 {
    return structuredClone(this.history);
  }
  async open(): Promise<void> {
    try {
      const value = await this.persistence.load(this.projectId);
      if (value !== null) {
        const record = value as { state: unknown; history: LocalHistoryV1 };
        const h = record.history;
        if (
          !h ||
          h.schemaId !== 'hcad.local-history@1' ||
          h.schemaVersion !== 1 ||
          h.projectId !== this.projectId ||
          h.streamKind !== this.stream ||
          !Array.isArray(h.entries) ||
          !Number.isSafeInteger(h.localSequence) ||
          h.localSequence < 0 ||
          !Number.isInteger(h.cursor) ||
          !Number.isInteger(h.head) ||
          h.cursor < 0 ||
          h.cursor > h.head ||
          h.head !== h.entries.length ||
          h.entries.length > 128 ||
          h.checksum !== (await checksum(h))
        )
          throw new TypeError('invalid header or checksum');
        let sequence = 0;
        for (const entry of h.entries) {
          if (
            !Number.isSafeInteger(entry.sequence) ||
            entry.sequence <= sequence ||
            entry.sequence > h.localSequence
          )
            throw new TypeError('invalid sequence');
          this.parse(entry.before);
          this.parse(entry.after);
          sequence = entry.sequence;
        }
        const state = this.parse(record.state);
        const expected = h.entries.length
          ? h.cursor
            ? h.entries[h.cursor - 1]!.after
            : h.entries[0]!.before
          : state;
        if (JSON.stringify(state) !== JSON.stringify(expected))
          throw new TypeError('state/cursor mismatch');
        this.state = structuredClone(state);
        this.history = structuredClone(h);
      }
    } catch (error) {
      this.history = this.empty();
      this.report(`${this.stream} history reset: ${String(error)}`);
    } finally {
      this.ready = true;
    }
  }
  commit(value: T, gestureSession: string | null = null): boolean {
    this.assertReady();
    const next = structuredClone(this.parse(value));
    if (JSON.stringify(next) === JSON.stringify(this.state)) return false;
    this.history.entries.splice(this.history.cursor);
    this.history.entries.push({
      sequence: ++this.history.localSequence,
      before: this.state,
      after: next,
      gestureSession,
      coalescingKey: null,
    });
    if (this.history.entries.length > 128) this.history.entries.shift();
    this.history.head = this.history.cursor = this.history.entries.length;
    this.state = next;
    this.persist();
    return true;
  }
  undo(): T {
    this.assertReady();
    if (this.canUndo) {
      this.state = structuredClone(this.parse(this.history.entries[--this.history.cursor]!.before));
      this.persist();
    }
    return this.current;
  }
  redo(): T {
    this.assertReady();
    if (this.canRedo) {
      this.state = structuredClone(this.parse(this.history.entries[this.history.cursor++]!.after));
      this.persist();
    }
    return this.current;
  }
  clear(): void {
    this.assertReady();
    this.history.entries = [];
    this.history.cursor = this.history.head = 0;
    this.persist();
  }
  async flushPersistence(): Promise<void> {
    await this.tail;
  }
  private assertReady(): void {
    if (!this.ready) throw new Error(`${this.stream} history is loading`);
  }
  private empty(): LocalHistoryV1 {
    return {
      schemaId: 'hcad.local-history@1',
      schemaVersion: 1,
      projectId: this.projectId,
      streamKind: this.stream,
      localSequence: 0,
      cursor: 0,
      head: 0,
      entries: [],
      checksum: '0'.repeat(64) as LocalHistoryV1['checksum'],
    };
  }
  private persist(): void {
    const history = structuredClone(this.history),
      state = this.current;
    this.tail = this.tail
      .then(async () => {
        history.checksum = await checksum(history);
        await this.persistence.store(this.projectId, { state, history });
      })
      .catch((error: unknown) =>
        this.report(`${this.stream} persistence failed: ${String(error)}`),
      );
  }
}
async function checksum(history: LocalHistoryV1): Promise<LocalHistoryV1['checksum']> {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...history, checksum: '0'.repeat(64) }));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('') as LocalHistoryV1['checksum'];
}

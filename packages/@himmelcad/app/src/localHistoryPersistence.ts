/** Shared atomic publication adapter for the three independent P8 streams. */
export class LocalStorageLocalHistoryPersistence<RecordType = unknown> {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly prefix: string,
  ) {}

  async load(projectId: string): Promise<unknown | null> {
    const encoded = this.storage.getItem(this.prefix + projectId);
    return encoded === null ? null : JSON.parse(encoded);
  }

  async store(projectId: string, record: RecordType): Promise<void> {
    this.storage.setItem(this.prefix + projectId, JSON.stringify(record));
  }
}

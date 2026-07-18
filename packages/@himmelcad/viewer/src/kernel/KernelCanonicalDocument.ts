import type {
  CanonicalCommandTransaction,
  CanonicalEntity,
  CanonicalEntityTombstone,
  CanonicalJournalEntry,
} from './generated/index.js';
import type {
  HimmelcadViewerWasmLoader,
  WasmCanonicalDocumentBinding,
} from './WgpuKernelViewer.js';

/** Browser/Electron facade over the render-independent Rust document authority. */
export class KernelCanonicalDocument {
  static async create(
    loader: HimmelcadViewerWasmLoader,
    journal: readonly CanonicalJournalEntry[] = [],
  ): Promise<KernelCanonicalDocument> {
    const module = await loader();
    if (module.default !== undefined) await module.default();
    const constructor = module.WasmCanonicalDocument;
    if (constructor === undefined) {
      throw new Error('loaded HimmelCAD WASM module has no canonical document authority');
    }
    const binding =
      journal.length === 0
        ? new constructor()
        : constructor.from_journal_json(JSON.stringify(journal));
    return new KernelCanonicalDocument(binding);
  }

  private disposed = false;

  private constructor(private readonly binding: WasmCanonicalDocumentBinding) {}

  get generation(): number {
    this.assertAlive();
    return this.binding.generation();
  }

  execute(transaction: CanonicalCommandTransaction): CanonicalJournalEntry {
    this.assertAlive();
    return parseJournalEntry(this.binding.execute_transaction_json(JSON.stringify(transaction)));
  }

  undo(commandId: string, targetCommandId: string): CanonicalJournalEntry {
    this.assertAlive();
    return parseJournalEntry(this.binding.undo_json(commandId, targetCommandId));
  }

  redo(commandId: string, targetCommandId: string): CanonicalJournalEntry {
    this.assertAlive();
    return parseJournalEntry(this.binding.redo_json(commandId, targetCommandId));
  }

  entity(entityId: string): CanonicalEntity | null {
    this.assertAlive();
    return JSON.parse(this.binding.entity_json(entityId)) as CanonicalEntity | null;
  }

  tombstone(entityId: string): CanonicalEntityTombstone | null {
    this.assertAlive();
    return JSON.parse(this.binding.tombstone_json(entityId)) as CanonicalEntityTombstone | null;
  }

  entities(): readonly CanonicalEntity[] {
    this.assertAlive();
    return JSON.parse(this.binding.entities_json()) as CanonicalEntity[];
  }

  journal(): readonly CanonicalJournalEntry[] {
    this.assertAlive();
    return JSON.parse(this.binding.journal_json()) as CanonicalJournalEntry[];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.binding.free();
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('canonical document is disposed');
  }
}

function parseJournalEntry(json: string): CanonicalJournalEntry {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { commandId?: unknown }).commandId !== 'string' ||
    !Array.isArray((value as { effects?: unknown }).effects)
  ) {
    throw new TypeError('canonical document returned a malformed journal entry');
  }
  return value as CanonicalJournalEntry;
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { KernelCanonicalDocument } from '../src/kernel/KernelCanonicalDocument.js';
import type { CanonicalCommandTransaction } from '../src/kernel/generated/index.js';
import type {
  HimmelcadViewerWasmModule,
  WasmCanonicalDocumentBinding,
} from '../src/kernel/WgpuKernelViewer.js';

test('canonical document facade keeps commands separate from viewer residency', async () => {
  const calls: unknown[][] = [];
  class MockDocument implements WasmCanonicalDocumentBinding {
    static from_journal_json(journalJson: string): WasmCanonicalDocumentBinding {
      calls.push(['replay', journalJson]);
      return new MockDocument();
    }

    execute_transaction_json(transactionJson: string): string {
      calls.push(['execute', transactionJson]);
      return entry('create-road', 'command');
    }
    undo_json(commandId: string, targetCommandId: string): string {
      calls.push(['undo', commandId, targetCommandId]);
      return entry(commandId, 'undo');
    }
    redo_json(commandId: string, targetCommandId: string): string {
      calls.push(['redo', commandId, targetCommandId]);
      return entry(commandId, 'redo');
    }
    entity_json(entityId: string): string {
      calls.push(['entity', entityId]);
      return 'null';
    }
    tombstone_json(entityId: string): string {
      calls.push(['tombstone', entityId]);
      return 'null';
    }
    entities_json(): string {
      return '[]';
    }
    journal_json(): string {
      return `[${entry('create-road', 'command')}]`;
    }
    generation(): number {
      return 1;
    }
    free(): void {
      calls.push(['free']);
    }
  }

  const module = {
    default: async () => calls.push(['init']),
    WasmCanonicalDocument: MockDocument,
  } as unknown as HimmelcadViewerWasmModule;
  const document = await KernelCanonicalDocument.create(async () => module);
  const transaction = {
    commandId: 'create-road',
    mutations: [],
  } as CanonicalCommandTransaction;
  assert.equal(document.execute(transaction).commandId, 'create-road');
  assert.equal(document.undo('undo-road', 'create-road').kind, 'undo');
  assert.equal(document.redo('redo-road', 'create-road').kind, 'redo');
  assert.equal(document.generation, 1);
  assert.equal(document.entity('road'), null);
  assert.deepEqual(document.entities(), []);
  assert.equal(document.journal().length, 1);
  document.dispose();
  assert.throws(() => document.entities(), /disposed/);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['init', 'execute', 'undo', 'redo', 'entity', 'free'],
  );
});

function entry(commandId: string, kind: 'command' | 'undo' | 'redo'): string {
  return JSON.stringify({ sequence: 1, commandId, kind, relatedCommandId: null, effects: [] });
}

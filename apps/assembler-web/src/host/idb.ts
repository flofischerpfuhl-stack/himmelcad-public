/**
 * A minimal promise wrapper over IndexedDB for the web host: one database,
 * two object stores. `recent` keeps recent projects with their File System
 * Access handles (handles are structured-cloneable in Chromium); `kv` keeps
 * the crash-recovery copy. IndexedDB, unlike `localStorage`, holds
 * multi-megabyte projects and does not block the main thread on writes.
 */
const DB_NAME = 'himmelcad-assembler';
const DB_VERSION = 1;
export type StoreName = 'recent' | 'kv';

let opening: Promise<IDBDatabase> | null = null;

/** `true` if this browser offers IndexedDB (not in some private modes). */
export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('recent'))
        db.createObjectStore('recent', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema: let it, and reopen on next use.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error('IndexedDB could not be opened'));
    };
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  return opening;
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  action: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = action(transaction.objectStore(store));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error ?? request.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
      }),
  );
}

export function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return run(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbAll<T>(store: StoreName): Promise<T[]> {
  return run(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function idbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  await run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  await run(store, 'readwrite', (s) => s.delete(key));
}

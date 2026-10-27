import type { BlobStore } from './store.ts';

/** Browser host adapter. Archive and runtime code never reference IndexedDB. */
export class IndexedDbBlobStore implements BlobStore {
  private readonly database: Promise<IDBDatabase>;
  constructor(readonly name: string, factory: IDBFactory = globalThis.indexedDB) {
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('blobs');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
  }
  private async operation<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.database;
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('blobs', mode);
      const request = action(transaction.objectStore('blobs'));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? request.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
  async keys() { return (await this.operation('readonly', store => store.getAllKeys())).map(String).sort(); }
  async read(key: string): Promise<Uint8Array | null> {
    const value = await this.operation('readonly', store => store.get(key));
    return value === undefined ? null : new Uint8Array(value as ArrayBuffer).slice();
  }
  async write(key: string, value: Uint8Array) {
    const bytes = new Uint8Array(value).buffer;
    await this.operation('readwrite', store => store.put(bytes, key));
  }
  async remove(key: string) { await this.operation('readwrite', store => store.delete(key)); }
  async close() { (await this.database).close(); }
}

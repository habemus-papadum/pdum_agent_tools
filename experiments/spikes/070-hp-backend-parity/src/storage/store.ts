/** Opaque keys and bytes: no filesystem paths, browser objects or JSON policy. */
export interface BlobStore {
  keys(): Promise<string[]>;
  read(key: string): Promise<Uint8Array | null>;
  /** Replace one complete value atomically; completion is the adapter's commit boundary. */
  write(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Useful for portable scenarios and failure injection; never presented as durable. */
export class MemoryBlobStore implements BlobStore {
  private readonly values = new Map<string, Uint8Array>();
  async keys() { return [...this.values.keys()].sort(); }
  async read(key: string) { return this.values.get(key)?.slice() ?? null; }
  async write(key: string, value: Uint8Array) { this.values.set(key, value.slice()); }
  async remove(key: string) { this.values.delete(key); }
}

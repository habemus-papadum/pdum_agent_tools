import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobStore } from './store.ts';

/** Filesystem details remain in this adapter. Keys need not be valid filenames. */
export class FileBlobStore implements BlobStore {
  constructor(readonly directory: string) {}
  private path(key: string) { return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.blob`); }
  async keys(): Promise<string[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const keys = await Promise.all(files.filter(file => file.endsWith('.blob')).map(async file => {
      const record = JSON.parse(await readFile(join(this.directory, file), 'utf8'));
      if (typeof record.key !== 'string' || typeof record.data !== 'string') throw new Error('Invalid blob envelope');
      return record.key as string;
    }));
    return keys.sort();
  }
  async read(key: string): Promise<Uint8Array | null> {
    let text: string;
    try { text = await readFile(this.path(key), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const record = JSON.parse(text);
    if (record.key !== key || typeof record.data !== 'string') throw new Error('Invalid blob envelope');
    return Uint8Array.from(Buffer.from(record.data, 'base64'));
  }
  async write(key: string, value: Uint8Array): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(key); const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ key, data: Buffer.from(value).toString('base64') }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}

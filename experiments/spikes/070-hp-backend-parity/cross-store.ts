/** Import browser-produced archive bytes through the Node storage adapter; no inference. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { FileBlobStore } from './src/storage/filesystem.ts';
import { ArchiveRepository, decodeArchive, encodeArchive } from './src/archive.ts';
import { pricesFromSnapshot, summarizeArchive } from './src/accounting.ts';
const root = new URL('../../artifacts/070-hp-backend-parity/', import.meta.url);
const bytes = new Uint8Array(await readFile(new URL('browser-live/continue-archive.json', root)));
const archive = decodeArchive(bytes);
const repository = new ArchiveRepository(new FileBlobStore(new URL('browser-to-filesystem/', root).pathname));
await repository.store.write('opaque transfer key / λ', bytes);
const loaded = await repository.get('opaque transfer key / λ');
assert.deepEqual(loaded, archive);
assert.deepEqual(encodeArchive(loaded!), encodeArchive(archive));
const prices = pricesFromSnapshot(JSON.parse(await readFile(new URL('../../../typescript/packages/agent-history/src/litellm-snapshot.json', import.meta.url), 'utf8')));
const report = { passed: true, bytes: bytes.length, sourceId: loaded!.sourceId, stats: summarizeArchive(loaded!, prices), providerCalls: 0 };
await writeFile(new URL('cross-store.json', root), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCatalog, readDocument, validateCatalog } from './read-adapter.mjs';

// Explicitly synthetic: checks transport identity/path handling, not SDK fidelity.
const entry = {key:'codex-synthetic',provider:'codex',sessionId:'synthetic',source:{method:'synthetic fixture'}};

test('catalog rejects duplicate identity and path-shaped keys', () => {
  assert.throws(() => validateCatalog({version:1,sessions:[entry,entry]}), /duplicate/);
  assert.throws(() => validateCatalog({version:1,sessions:[{...entry,key:'../private'}]}), /Invalid/);
});

test('known-document lookup preserves unknown native fields and rejects mismatched identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdum-058-reader-test-'));
  try {
    await mkdir(join(directory,'documents'));
    await writeFile(join(directory,'catalog.json'), JSON.stringify({version:1,sessions:[entry]}));
    const path = join(directory,'documents',`${entry.key}.json`);
    const payload = {futureNativeField:{opaque:[1,2,3]},unknownBlock:{type:'future'}};
    await writeFile(path, JSON.stringify({...entry,payload}));
    assert.deepEqual((await readDocument(directory,entry.key)).payload,payload);
    assert.equal(await readDocument(directory,'../private'),null);
    assert.equal((await readCatalog(directory)).sessions.length,1);
    await writeFile(path, JSON.stringify({...entry,sessionId:'different',payload}));
    await assert.rejects(readDocument(directory,entry.key), /identity differs/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

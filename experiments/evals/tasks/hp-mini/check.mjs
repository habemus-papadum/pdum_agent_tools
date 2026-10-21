import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = resolve(process.argv[2]);
const task = fileURLToPath(new URL('./', import.meta.url));
let failed = 0;
async function check(name, action) {
  try { const detail = await action(); console.log(`CHECK ${name} ok${detail ? ` ${detail}` : ''}`); }
  catch (error) { failed += 1; console.log(`CHECK ${name} FAIL ${String(error).replaceAll('\n', ' ')}`); }
}
const record = (overrides = {}) => ({ sessionId: 'a', requestId: 'r', revision: 1, origin: 'runtime', inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, ...overrides });
const zero = () => ({ requests: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0 });
let summarize;
await check('import', async () => { summarize = (await import(pathToFileURL(join(directory, 'src/usage.mjs')).href)).summarizeUsage; assert.equal(typeof summarize, 'function'); });
await check('empty', () => assert.deepEqual(summarize([]), { sessions: [], totals: zero() }));
await check('cache-subset', () => {
  assert.deepEqual(summarize([record()]).totals, { requests: 1, inputTokens: 10, cachedInputTokens: 4, uncachedInputTokens: 6, outputTokens: 2 });
});
await check('revisions-and-ties', () => {
  const result = summarize([record({ revision: 2, inputTokens: 20 }), record({ revision: 1, inputTokens: 100 }), record({ revision: 2, inputTokens: 30 })]);
  assert.equal(result.totals.requests, 1); assert.equal(result.totals.inputTokens, 30);
});
await check('inherited-before-dedup', () => {
  const result = summarize([record(), record({ revision: 999, origin: 'copied-context', inputTokens: 900 })]);
  assert.equal(result.totals.inputTokens, 10); assert.deepEqual(summarize([record({ origin: 'copied-context' })]).totals, zero());
});
await check('session-scoped-identity', () => {
  const result = summarize([record({ sessionId: 'b' }), record({ sessionId: 'a' }), record({ sessionId: 'a:r', requestId: 'x' }), record({ sessionId: 'a', requestId: 'r:x' })]);
  assert.equal(result.totals.requests, 4); assert.deepEqual(result.sessions.map((s) => s.sessionId), ['a', 'a:r', 'b']);
});
await check('frozen-input', () => {
  const data = Object.freeze([Object.freeze(record({ sessionId: 'z' })), Object.freeze(record({ sessionId: 'A' }))]);
  const before = JSON.stringify(data); const result = summarize(data);
  assert.equal(JSON.stringify(data), before); assert.deepEqual(result.sessions.map((s) => s.sessionId), ['A', 'z']);
});
await check('ordinal-sort', () => {
  const result = summarize(['a', 'Z', 'A', 'ä'].map((sessionId) => record({ sessionId })));
  assert.deepEqual(result.sessions.map((s) => s.sessionId), ['A', 'Z', 'a', 'ä']);
});
await check('skill-readme', async () => {
  const text = await readFile(join(directory, 'README.md'), 'utf8'); assert.ok(text.includes('Cached tokens are a subset of input.'));
});
await check('scope', async () => {
  const allowed = new Set(['src/usage.mjs', 'test/usage.test.mjs', 'README.md']);
  async function walk(base, current = base) {
    const files = [];
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) files.push(...await walk(base, path));
      else files.push(relative(base, path));
    }
    return files;
  }
  const originals = await walk(join(task, 'fixture')); const actual = await walk(directory);
  assert.deepEqual(actual.sort(), originals.sort(), 'unexpected added/deleted project files');
  for (const file of originals) if (!allowed.has(file)) assert.equal(await readFile(join(directory, file), 'utf8'), await readFile(join(task, 'fixture', file), 'utf8'), `${file} changed`);
});
await check('test', () => {
  const result = spawnSync(process.execPath, ['--test', 'test/usage.test.mjs'], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  const count = Number(output.match(/(?:# |ℹ )tests (\d+)/)?.[1] ?? 0);
  assert.ok(count >= 4, `expected at least 4 regression tests, got ${count}`);
  return `${count} passed`;
});
process.exitCode = failed ? 1 : 0;

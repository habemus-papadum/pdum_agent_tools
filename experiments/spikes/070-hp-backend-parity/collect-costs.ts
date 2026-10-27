/** Reconcile saved usage with independently captured live endpoint evidence; no provider calls. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { decodeArchive } from './src/archive.ts';
import { pricesFromSnapshot, summarizeArchive } from './src/accounting.ts';

const root = new URL('../../artifacts/070-hp-backend-parity/', import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const prices = pricesFromSnapshot(JSON.parse(await readFile(new URL('../../../typescript/packages/agent-history/src/litellm-snapshot.json', import.meta.url), 'utf8')));
const nodeSeed = await read('node-live/seed-ledger.json');
const nodeContinuation = await read('node-live/continue-ledger.json');
const compact = await read('node-live/compact-response.json');
const browser = await read('browser-live/ledger.json');
const results = [];
for (const host of ['node', 'browser']) {
  const archive = decodeArchive(new Uint8Array(await readFile(new URL(`${host}-live/continue-archive.json`, root))));
  const summary = summarizeArchive(archive, prices);
  const seenIds = host === 'node'
    ? [...nodeSeed.responses, ...nodeContinuation.responses].map(record => record.responseId).concat(compact.id)
    : browser.responses.map((record: { responseId: string }) => record.responseId);
  assert.deepEqual(new Set(seenIds), new Set(archive.usages.map(record => record.usage.responseId)));
  assert(summary.complete && summary.responses === 7 && summary.compactionResponses === 1);
  const userTurns = archive.snapshots.reduce((sum, saved) => sum + saved.thread.turns.filter(turn => !saved.inheritedTurnIds.includes(turn.id)).length, 0);
  const writes = archive.usages.reduce((sum, record) => sum + record.usage.cacheWriteTokens, 0);
  results.push({ host, userTurns, modelResponses: summary.responses - summary.compactionResponses,
    compactions: summary.compactionResponses, counts: summary.counts, writes,
    estimatedUsd: summary.knownCostUsd, coverage: 'Every observed response/compaction has matching saved usage' });
}
const report = { date: '2026-10-25', model: 'gpt-6-luna', prices: prices.version, results,
  estimatedUsd: results.reduce((sum, result) => sum + result.estimatedUsd, 0),
  requests: { model: results.reduce((sum, result) => sum + result.modelResponses, 0), compaction: 2 },
  actualBilling: null, assistantCost: null, failedModelAttempts: 0,
  basis: 'Native observed usage, deduplicated by response ID; saved fork context is not charged again.' };
await writeFile(new URL('costs.json', root), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

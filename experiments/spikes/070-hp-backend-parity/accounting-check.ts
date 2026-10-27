/** Actual production writer/DuckDB/pricing qualification. --fixture invokes no provider. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryDb, num } from '../../../typescript/packages/agent-history/src/db.ts';
import { CHECKS, runChecks } from '../../../typescript/packages/agent-history/src/checks.ts';
import { priceSnapshot, priceUsage, ratesFor, pricesCte, USD_EXPRESSION } from '../../../typescript/packages/agent-history/src/pricing.ts';
import { decodeArchive } from './src/archive.ts';
import { historyExport, pricesFromSnapshot, uniqueUsage } from './src/accounting.ts';
import { createAccountingFixture } from './src/accounting-fixture.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const repo = resolve(directory, '../../..');
const fixture = process.argv[2] === '--fixture';
const output = resolve(process.argv[3] ?? resolve(directory, '../../artifacts/070-hp-backend-parity/accounting'));
await mkdir(output, { recursive: true });
const archive = fixture ? await createAccountingFixture() : decodeArchive(await readFile(process.argv[2]!));
const exported = historyExport(archive, pricesFromSnapshot(priceSnapshot));
const exportPath = resolve(output, 'history-export.json');
await writeFile(exportPath, JSON.stringify(exported));
if (fixture) await writeFile(resolve(output, 'fixture-archive.json'), JSON.stringify(archive));
const database = resolve(output, 'history.duckdb');

function ingest() {
  const result = spawnSync(resolve(repo, '.venv/bin/python'), [resolve(directory, 'ingest.py'), exportPath, database],
    { cwd: resolve(repo, 'experiments'), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Ingest failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const first = ingest(), second = ingest();
assert.equal(second.units.changed, 0, 'Identical second import must use existing ledger');
assert.equal(second.units.unchanged, 1);
const db = await HistoryDb.open(database);
try {
  const identity = [archive.sourceId];
  const totals = (await db.query(`WITH ${pricesCte()}
    SELECT count(*) AS responses, sum(u.input_tokens) AS input, sum(u.cached_input_tokens) AS cached,
      sum(u.cache_write_input_tokens) AS cache_write, sum(u.output_tokens) AS output,
      sum(CASE WHEN u.input_tokens IS NOT NULL AND u.output_tokens IS NOT NULL THEN ${USD_EXPRESSION} END) AS usd
    FROM usage_events u LEFT JOIN prices p ON p.model=u.model WHERE u.source_id=?`, identity))[0]!;
  assert.equal(num(totals.responses), exported.statistics.responses);
  for (const [column, key] of [['input', 'input'], ['cached', 'cached'], ['cache_write', 'cacheWrite'], ['output', 'output']] as const) {
    assert.equal(num(totals[column]), exported.statistics.counts[key]);
  }
  assert.ok(Math.abs(num(totals.usd) - exported.statistics.knownCostUsd) < 1e-12);
  let productionCost = 0;
  for (const record of uniqueUsage(archive)) {
    const u = record.usage, rates = ratesFor(u.model);
    assert.ok(rates, `Unpriced model in qualification: ${u.model}`);
    productionCost += priceUsage(rates, { uncached: u.inputTokens - u.cachedInputTokens - u.cacheWriteTokens,
      cached: u.cachedInputTokens, cacheWrite: u.cacheWriteTokens, cacheWrite1h: 0, output: u.outputTokens });
  }
  assert.ok(Math.abs(productionCost - exported.statistics.knownCostUsd) < 1e-12);
  const basicIds = new Set(['schema-version', 'rows-without-source', 'sources-without-provenance', 'threads-without-lineage',
    'duplicate-responses', 'responses-without-turn', 'items-without-turn', 'turns-without-thread', 'blobs-without-item']);
  const invariants = await runChecks(db, CHECKS.filter(check => basicIds.has(check.id)));
  assert.equal(invariants.length, basicIds.size, 'Every requested invariant must exist');
  const outOfTurn = uniqueUsage(archive).filter(record => record.turnId === null).length;
  for (const check of invariants) {
    if (check.id === 'responses-without-turn') assert.equal(check.value, outOfTurn);
    else assert.equal(check.ok, true, `Unexpected production invariant failure: ${check.id}`);
  }
  const ownUsage = await db.query(`SELECT thread_id, count(*) AS responses, sum(input_tokens) AS input
    FROM usage_events WHERE source_id=? GROUP BY thread_id ORDER BY thread_id`, identity);
  const lineage = await db.query(`SELECT thread_id,parent_thread_id,forked_from_id,lineage_id,lineage_depth
    FROM threads WHERE source_id=? ORDER BY thread_id`, identity);
  const inherited = num(await db.scalar(`SELECT count(*) FROM turns WHERE source_id=? AND origin='copied-context'`, identity));
  const report = { kind: fixture ? 'local scripted usage + real HP runtime/tools/production writer' : 'provided saved HP archive',
    providerCallsInThisCheck: 0, sourceId: archive.sourceId, schemaVersion: exported.rows.schemaVersion,
    firstImportUnits: first.units, duplicateImportUnits: second.units, statistics: exported.statistics,
    databaseTotals: totals, productionPriceFunctionUsd: productionCost, ownUsage, lineage, inheritedTurns: inherited,
    invariants, expectedInvariantGap: outOfTurn ? `${outOfTurn} out-of-turn compaction responses fail existing responses-without-turn; no fake turn inserted` : null,
    database, storageIndependent: 'Accounting accepts archive data; Python ingestion consumes a transported export, not a backing store.' };
  const json = JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? Number(value) : value, 2);
  await writeFile(resolve(output, 'accounting-report.json'), `${json}\n`);
  console.log(json);
} finally { db.close(); }

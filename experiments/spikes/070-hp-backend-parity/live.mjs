import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { modelHost } from '../045-hp-behavior/model-host.mjs';
import { FileBlobStore } from './src/storage/filesystem.ts';
import { ArchiveRepository } from './src/archive.ts';
import { pricesFromSnapshot, historyExport } from './src/accounting.ts';
import { LIVE_SUFFIX, seedLive, continueLive } from './src/live-scenarios.ts';

assert(process.argv.includes('--live'), 'Explicit --live required');
const phase = process.argv.includes('--continue') ? 'continue' : 'seed';
const root = resolve(process.env.HP070_ARTIFACTS ?? '../../artifacts/070-hp-backend-parity/node-live');
await mkdir(root, { recursive: true });
const prices = pricesFromSnapshot(JSON.parse(await readFile('../../../typescript/packages/agent-history/src/litellm-snapshot.json', 'utf8')));
const host = await modelHost({ maxRequests: 8, timeoutMs: 120000, maxOutputTokens: 256, effort: 'none', suffix: LIVE_SUFFIX });
const repo = new ArchiveRepository(new FileBlobStore(resolve(root, 'store')));
let result, failure;
try {
  const bindings = { connector: host.connector, instructions: host.instructions, prices, signal: host.signal };
  const api = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 30000 });
  const compactor = { responses: { compact: async (...args) => {
    const value = await api.responses.compact(...args);
    await writeFile(resolve(root, 'compact-response.json'), JSON.stringify(value));
    return value;
  } } };
  result = phase === 'seed'
    ? await seedLive(repo, bindings, compactor)
    : await continueLive(repo, bindings);
  await writeFile(resolve(root, `${phase}-archive.json`), JSON.stringify(result.archive));
  await writeFile(resolve(root, `${phase}-export.json`), JSON.stringify(historyExport(result.archive, prices)));
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  host.close();
  const evidence = host.evidence();
  await writeFile(resolve(root, `${phase}-wire.json`), JSON.stringify(evidence.wire));
  await writeFile(resolve(root, `${phase}-ledger.json`), JSON.stringify(evidence.ledger, null, 2));
  const { archive, ...summary } = result ?? {};
  await writeFile(resolve(root, `${phase}-result.json`), JSON.stringify({ ...summary, failure, phase, node: process.version }, null, 2));
  console.log(JSON.stringify({ ...summary, failure, phase, responses: evidence.ledger.responses.length, root }, null, 2));
}

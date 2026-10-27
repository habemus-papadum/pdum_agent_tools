import { IndexedDbBlobStore } from './storage/indexeddb.ts';
import { ArchiveRepository, decodeArchive, encodeArchive } from './archive.ts';
import { pricesFromSnapshot, historyExport, summarizeArchive } from './accounting.ts';
import { attachmentScenarios } from './attachment-scenarios.ts';
import { runPersistenceScenarios } from './persistence-scenarios.ts';
import { seedLive, continueLive } from './live-scenarios.ts';
import { DirectResponsesConnector } from '../../038-hp-sdk-fit/src/direct.ts';
import { browserConnectionFactory } from '../../039-hp-agent-runtime/src/browser-connection.ts';
import type { CompactionClient } from '../../043-hp-context-compaction/src/compaction.ts';

globalThis.addEventListener('message', async ({ data }) => {
  const store = new IndexedDbBlobStore(data.database ?? 'hp-070-study');
  const repo = new ArchiveRepository(store);
  let connector: DirectResponsesConnector | undefined;
  try {
    let result: unknown;
    if (data.action === 'local') result = { persistence: await runPersistenceScenarios(store), attachment: await attachmentScenarios() };
    else if (data.action === 'read') result = { catalogue: await repo.list(), seed: (await repo.get('seed'))?.runtimeId, final: (await repo.get('final'))?.runtimeId };
    else if (data.action === 'transfer') {
      const bytes = new Uint8Array(await (await fetch('/node-archive.json')).arrayBuffer());
      const archive = decodeArchive(bytes);
      await store.write('from-node', bytes);
      const restored = await repo.get('from-node');
      if (JSON.stringify(restored) !== JSON.stringify(archive)) throw Error('Cross-adapter archive changed');
      const prices = pricesFromSnapshot(await (await fetch('/prices.json')).json());
      result = { passed: true, bytes: encodeArchive(restored!).byteLength, stats: summarizeArchive(restored!, prices) };
    } else if (data.action === 'seed' || data.action === 'continue') {
      const settings = await (await fetch('/__spike')).json();
      if (!settings.live) throw Error('Host is not in explicitly enabled live mode');
      const instructions = await (await fetch('/instructions.json')).json();
      const prices = pricesFromSnapshot(await (await fetch('/prices.json')).json());
      const url = new URL('/responses', globalThis.location.href); url.protocol = 'ws:';
      connector = new DirectResponsesConnector(browserConnectionFactory(url.href), { max_output_tokens: 256, reasoning: { effort: 'none' }, service_tier: 'default' });
      const signal = AbortSignal.timeout(120000);
      const bindings = { connector, instructions, prices, signal };
      const compactor = { responses: { compact: async (body: unknown) => {
        const response = await fetch('/compact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
        const value = await response.json(); if (!response.ok) throw Error(`Compaction HTTP ${response.status}`); return value;
      } } } as unknown as CompactionClient;
      const report = data.action === 'seed' ? await seedLive(repo, bindings, compactor) : await continueLive(repo, bindings);
      await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: data.action, report, exported: historyExport(report.archive, prices) }) });
      const { archive, ...summary } = report; result = summary;
    } else throw Error('Unknown qualification action');
    globalThis.postMessage({ id: data.id, result });
  } catch (error) { globalThis.postMessage({ id: data.id, error: String(error) }); }
  finally { connector?.close(); await store.close(); }
});

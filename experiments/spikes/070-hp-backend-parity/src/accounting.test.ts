import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntime } from '../../039-hp-agent-runtime/src/runtime.ts';
import { echoTool } from '../../039-hp-agent-runtime/src/fixture.ts';
import type { ModelConnector, ModelEvent, ModelRunArgs } from '../../038-hp-sdk-fit/src/connector.ts';
import { captureArchive, decodeArchive, encodeArchive } from './archive.ts';
import { resumeArchive } from './runtime-restore.ts';
import { archiveHistoryRows, pricesFromSnapshot, summarizeArchive, type Prices } from './accounting.ts';

const prices: Prices = { version: 'explicit fixture rates, not provider spend', models: {
  'fixture-model': { uncached: 1, cached: 0.1, cacheWrite: 1.25, output: 5 },
} };

/** Scripted provider facts run through the real HP turn/tool machinery; no inference. */
function connector(): ModelConnector {
  return { run: (args: ModelRunArgs) => ({ events: (async function* (): AsyncGenerator<ModelEvent> {
    const responseId = crypto.randomUUID();
    yield { type: 'raw', event: { type: 'response.created', response: { id: responseId } } };
    const last = args.input.at(-1);
    if (last?.type !== 'function_call_output' && JSON.stringify(last).includes('call_echo')) {
      const id = crypto.randomUUID(), input = JSON.stringify({ text: 'real local tool output' });
      yield { type: 'outputItem', item: { type: 'function_call', call_id: id, name: 'echo', arguments: input } };
      yield { type: 'toolCall', id, name: 'echo', arguments: input, kind: 'function' };
    } else yield { type: 'outputItem', item: { type: 'message', id: crypto.randomUUID(), role: 'assistant',
      content: [{ type: 'output_text', text: 'Completed local scenario.' }] } };
    yield { type: 'usage', responseId, model: 'fixture-model', inputTokens: 100, cachedInputTokens: 60,
      cacheWriteTokens: 10, outputTokens: 12 };
    yield { type: 'completed', responseId };
  })(), steer: async () => {} }) };
}

test('live facts, serialized archive, fork, child and resumed epoch preserve each response cost once', async () => {
  const runtime = new AgentRuntime({ connector: connector(), tools: [echoTool], model: 'fixture-model' });
  const parent = runtime.create(); runtime.start(parent.id, 'call_echo'); await runtime.wait(parent.id);
  const child = runtime.spawn(parent.id, 'independent child'); await runtime.wait(child.threadId);
  const fork = runtime.fork(parent.id); runtime.start(fork.id, 'new fork input'); await runtime.wait(fork.id);
  const saved = captureArchive(runtime, { sourceId: 'accounting-fixture' });
  const before = summarizeArchive(saved, prices);
  assert.equal(before.responses, 4);
  assert.equal(before.complete, true);
  assert.deepEqual(before.counts, { input: 400, uncached: 120, cached: 240, cacheWrite: 40, output: 48 });
  assert.equal(before.byThread[parent.id]?.responses, 2);
  assert.equal(before.byThread[fork.id]?.responses, 1);
  assert.equal(before.byThread[child.threadId]?.responses, 1);
  const duplicate = structuredClone(saved); duplicate.usages.push(...structuredClone(saved.usages));
  assert.equal(summarizeArchive(duplicate, prices).knownCostUsd, before.knownCostUsd);
  assert.equal(summarizeArchive(duplicate, prices).duplicateUsageRecords, 4);
  assert.deepEqual(summarizeArchive(decodeArchive(encodeArchive(saved)), prices), before);
  runtime.dispose();

  const restored = resumeArchive(saved, parent.id, { connector: connector(), tools: [echoTool] });
  try {
    assert.equal(restored.runtime.usages.length, 0);
    restored.runtime.start(parent.id, 'new resumed input'); await restored.runtime.wait(parent.id);
    const continued = captureArchive(restored.runtime, { previous: saved });
    assert.equal(continued.sourceId, saved.sourceId);
    const after = summarizeArchive(continued, prices);
    assert.equal(after.responses, 5);
    assert.equal(after.counts.input, 500);
    const exported = archiveHistoryRows(continued);
    assert.equal(exported.schemaVersion, 5);
    assert.equal(exported.tables.responses!.length, 5);
    assert.equal(new Set(exported.tables.responses!.map(row => row.response_id)).size, 5);
    assert.ok(exported.tables.items!.some(row => row.origin === 'copied-context'));
    assert.equal(exported.tables.fork_edges!.length, 1);
    assert.equal(exported.tables.spawn_edges!.length, 1);
  } finally { restored.runtime.dispose(); }
});

test('missing, invalid and unpriced usage stays explicit instead of becoming zero cost or context size', async () => {
  const runtime = new AgentRuntime({ connector: connector(), model: 'fixture-model' });
  const thread = runtime.create(); runtime.start(thread.id, 'one turn'); await runtime.wait(thread.id);
  const archive = captureArchive(runtime);
  const unpriced = summarizeArchive(archive);
  assert.equal(unpriced.complete, false); assert.equal(unpriced.unpricedResponseIds.length, 1);
  assert.equal(unpriced.contextTokens, null);
  const missing = structuredClone(archive); missing.usages = [];
  assert.equal(summarizeArchive(missing, prices).missingResponseIds.length, 1);
  assert.equal(summarizeArchive(missing, prices).turnsWithoutUsage.length, 1);
  const invalid = structuredClone(archive); invalid.usages[0]!.usage.cachedInputTokens = 999;
  assert.equal(summarizeArchive(invalid, prices).invalidResponseIds.length, 1);
  assert.equal(archiveHistoryRows(invalid).tables.responses![0]!.input_tokens, null);
  const conflict = structuredClone(archive); conflict.usages.push({ ...structuredClone(archive.usages[0]!), threadId: 'wrong-owner' });
  assert.throws(() => summarizeArchive(conflict, prices), /Conflicting usage/);
  runtime.dispose();
});

test('out-of-turn compaction is retained once, including discarded work, without a fabricated turn', async () => {
  const runtime = new AgentRuntime({ connector: connector(), model: 'fixture-model' });
  const thread = runtime.create(); runtime.start(thread.id, 'one turn'); await runtime.wait(thread.id);
  const extra = { ...structuredClone(runtime.usages[0]!), turnId: null, originRunId: runtime.runId,
    afterTurnId: runtime.read(thread.id).turns.at(-1)!.id,
    endpoint: 'responses.compact' as const, disposition: 'discarded' as const };
  extra.usage.responseId = 'compact-unique';
  const archive = captureArchive(runtime, { extraUsages: [extra, structuredClone(extra)] });
  const summary = summarizeArchive(archive, prices);
  assert.equal(summary.responses, 2); assert.equal(summary.compactionResponses, 1);
  const compact = archiveHistoryRows(archive).tables.responses!.find(row => row.origin === 'responses.compact')!;
  assert.equal(compact.turn_id, null); assert.equal(compact.response_id, 'compact-unique');
  assert.equal(archiveHistoryRows(archive).tables.turns!.length, 1);
  runtime.dispose();
});

test('dated table adaptation does not require storage or node APIs', () => {
  const adapted = pricesFromSnapshot({ fetched_at: '2026-10-17', entries: {
    'fixture-model': { input_cost_per_token: 1e-6, cache_read_input_token_cost: 1e-7,
      cache_creation_input_token_cost: 1.25e-6, output_cost_per_token: 5e-6 },
  } });
  assert.equal(adapted.version, 'litellm 2026-10-17');
  for (const key of ['uncached', 'cached', 'cacheWrite', 'output'] as const) {
    assert.ok(Math.abs(adapted.models['fixture-model']![key] - prices.models['fixture-model']![key]) < 1e-12);
  }
});

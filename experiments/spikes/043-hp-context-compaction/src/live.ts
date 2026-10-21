import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { AgentRuntime, replay, type Tool, type Turn } from '../../039-hp-agent-runtime/src/runtime.ts';
import { DirectResponsesConnector } from '../../038-hp-sdk-fit/src/direct.ts';
import { officialConnectionFactory } from '../../038-hp-sdk-fit/src/official-connection.ts';
import type { NativeItem, ResponsesConnectionFactory } from '../../038-hp-sdk-fit/src/connector.ts';
import { compactIdleThread, inspectContext, type CompactionOutcome } from './compaction.ts';

assert(process.argv.includes('--live'), 'Paid probe requires explicit --live');
assert(process.env.OPENAI_API_KEY, 'Supply OPENAI_API_KEY through the host environment');
const model = 'gpt-6-luna';
const reasoningTask = process.argv.includes('--reasoning-task');
const initialAvailable = reasoningTask ? 458 : 95;
const instructions = 'Maintain inventory accounting. Call read_manifest once if no prior result exists; it is the source for the original inventory. Use prior context after that and never repeat the tool. If the manifest describes delivered by modular constraints, solve for the smallest positive delivered count satisfying all of them. Available = delivered minus returned minus packed. Apply each later correction once. Reply only with compact JSON containing project and available.';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, maxRetries: 0, timeout: 60_000 });
const raw: NativeItem[] = [];
const observed = new Map<string, NativeItem>();
const requests: NativeItem[] = [];
const tokenCounts: NativeItem[] = [];
let calls = 0;
let connectionCount = 0;
let createdResponses = 0;
let toolExecutions = 0;
let compaction: CompactionOutcome | undefined;
const rates = { input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50 };
const estimate = (input: number, cached: number, writes: number, output: number) => ((input - cached - writes) * rates.input + cached * rates.cachedInput + writes * rates.cacheWrite + output * rates.output) / 1e6;
const factory = officialConnectionFactory(() => client);
const observedFactory: ResponsesConnectionFactory = async (signal) => {
  const connection = await factory(signal);
  const connectionId = ++connectionCount;
  return {
    close: () => connection.close(),
    send(event) {
      if (event.type === 'response.create') { assert(++calls <= 5, 'Five generated-call allocation exhausted'); assert.equal(event.model, model); }
      requests.push({ connectionId, event: structuredClone(event) });
      connection.send(event);
    },
    events: (async function* () {
      for await (const event of connection.events) {
        raw.push({ connectionId, event });
        if (event.type === 'response.created') assert(++createdResponses <= 5, 'Unexpected automatic response');
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(String(event.type))) {
          const response = event.response as NativeItem;
          const u = response.usage as NativeItem | undefined;
          if (u) {
            const detail = u.input_tokens_details as NativeItem;
            const outputDetail = u.output_tokens_details as NativeItem;
            const input = Number(u.input_tokens), cached = Number(detail.cached_tokens ?? 0), writes = Number(detail.cache_write_tokens ?? 0), output = Number(u.output_tokens);
            assert.equal(response.model, model); assert.equal(response.service_tier, 'default');
            observed.set(String(response.id), { endpoint: 'responses.create', responseId: response.id, input, cached, writes, output, reasoningTokens: Number(outputDetail.reasoning_tokens ?? 0), status: response.status, estimatedUsd: estimate(input, cached, writes, output) });
            assert(input <= 10_000 && output <= 1024 && cached + writes <= input, 'Observed usage exceeded experiment envelope');
          }
        }
        yield event;
      }
    })(),
  };
};
const outputText: OpenAI.Responses.ResponseTextConfig = { format: { type: 'json_schema', name: 'inventory', strict: true, schema: { type: 'object', properties: { project: { type: 'string' }, available: { type: 'integer' } }, required: ['project', 'available'], additionalProperties: false } } };
const direct = new DirectResponsesConnector(observedFactory, {
  max_output_tokens: 1024, reasoning: { effort: 'low' }, service_tier: 'default', text: outputText,
});
const manifest: Tool = {
  definition: { type: 'function', name: 'read_manifest', description: 'Read the experiment inventory manifest once. Returns original delivered, returned and packed counts and project identity.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true },
  async execute() { assert.equal(++toolExecutions, 1, 'Fixture tool must not repeat across forks or compaction'); return JSON.stringify(reasoningTask
      ? { project: 'CEDAR-7', delivered: { rule: 'smallest positive integer', constraints: [{ modulus: 7, remainder: 3 }, { modulus: 11, remainder: 5 }, { modulus: 13, remainder: 6 }] }, returned: 19, packed: 23 }
      : { project: 'CEDAR-7', delivered: 137, returned: 19, packed: 23 }); },
};
const runtime = new AgentRuntime({
  model, instructions, tools: [manifest],
  connector: { run(args) { return direct.run({ ...args, signal: AbortSignal.any([args.signal, AbortSignal.timeout(60_000)]) }); } },
  async beforeModel(args) {
    const counted = await client.responses.inputTokens.count({ model, input: args.input as unknown as OpenAI.Responses.ResponseInputItem[], instructions, tools: args.tools as unknown as OpenAI.Responses.Tool[], text: outputText, reasoning: { effort: 'low' } }, { signal: AbortSignal.timeout(60_000), maxRetries: 0 });
    tokenCounts.push({ scope: 'generation preflight: full items, instructions, tools, reasoning and output format', threadId: args.threadId, turnId: args.turnId, inputTokens: counted.input_tokens });
    assert(counted.input_tokens <= 10_000, 'Input bound exceeded before generation');
  },
});
const parent = runtime.create();
const result: NativeItem = { startedAt: new Date().toISOString(), model, reasoningEffort: 'low', fixture: reasoningTask ? 'modular inventory' : 'simple inventory', versions: { openai: '7.38.0', node: process.version }, checks: {} };
const checks = result.checks as NativeItem;
async function run(threadId: string, text: string, expected: number) {
  runtime.start(threadId, text);
  const turn = await runtime.wait(threadId) as Turn;
  assert.equal(turn.status, 'completed', JSON.stringify(turn.error));
  const message = turn.items.filter((item) => item.type === 'agentMessage').map((item) => String(item.text)).join('');
  const parsed = JSON.parse(message) as NativeItem;
  assert.deepEqual(parsed, { project: 'CEDAR-7', available: expected });
  return { output: parsed, turnId: turn.id };
}
async function countContext(input: NativeItem[], scope: string) {
  const count = await client.responses.inputTokens.count({ model, input: input as unknown as OpenAI.Responses.ResponseInputItem[], instructions }, { signal: AbortSignal.timeout(60_000), maxRetries: 0 });
  tokenCounts.push({ scope, inputTokens: count.input_tokens });
  assert(count.input_tokens <= 10_000, 'Compaction context exceeds preflight bound');
  return count.input_tokens;
}
let failure: string | undefined;
try {
  checks.initial = await run(parent.id, 'Read the manifest and calculate the available inventory. Remember the project and counts for later adjustments.', initialAvailable);
  const beforeContext = runtime.context(parent.id);
  const beforeFacts = inspectContext(beforeContext);
  checks.opaqueReasoningAvailableBeforeFork = beforeFacts.opaqueReasoningItems > 0;
  const rawFork = runtime.fork(parent.id);
  const rawForkInitial = runtime.context(rawFork.id);
  assert.deepEqual(rawForkInitial, beforeContext);
  const connectionsBeforeRawFork = connectionCount;
  checks.reasoningFork = await run(rawFork.id, 'Report current project and available inventory without using the tool again.', initialAvailable);
  assert.equal(connectionCount, connectionsBeforeRawFork + 1, 'Raw reasoning fork must use a new connection');
  assert.deepEqual(runtime.context(parent.id), beforeContext);
  const beforeTranscript = runtime.read(parent.id);
  const beforeTokens = await countContext(beforeContext, 'before standalone compaction, no tool definitions');
  result.compactionPlanningAllowance = { inputTokens: beforeTokens, modelMaxOutputTokens: 128_000, estimatedUsd: estimate(beforeTokens, 0, 0, 128_000), note: 'Planning allowance from model limit, not an endpoint-enforced output cap; API has no max_output_tokens for compact.' };
  compaction = await compactIdleThread(runtime, parent.id, client, { signal: AbortSignal.timeout(60_000) });
  assert.equal(compaction.status, 'applied');
  assert.equal(compaction.usage.model, model);
  assert(compaction.usage.inputTokens <= 10_000);
  assert(compaction.usage.outputTokens <= 128_000, 'Unexpected compaction output; stop before further requests');
  assert.deepEqual(runtime.read(parent.id), beforeTranscript, 'Full transcript must remain unchanged');
  assert.deepEqual(runtime.context(parent.id), compaction.nextContext, 'Use full canonical window without filtering');
  const afterFacts = inspectContext(compaction.nextContext);
  assert(afterFacts.opaqueCompactionItems > 0, 'Expected real opaque compaction item');
  const afterTokens = await countContext(compaction.nextContext, 'after standalone compaction, no tool definitions');
  checks.compaction = { status: compaction.status, transcriptUnchanged: true, before: beforeFacts, after: afterFacts, beforeInputTokens: beforeTokens, afterInputTokens: afterTokens };
  checks.afterCompaction = await run(parent.id, 'Five more units have now been packed. Update the inventory and report project and available. Do not call the tool.', initialAvailable - 5);
  const parentAfter = runtime.snapshots().find((saved) => saved.thread.id === parent.id)!;
  const compactedFork = runtime.fork(parent.id);
  assert.deepEqual(runtime.context(compactedFork.id), parentAfter.context);
  const connectionsBeforeCompactedFork = connectionCount;
  checks.compactedFork = await run(compactedFork.id, 'For this branch only, 11 additional units were delivered. Apply this change and report project and available. Do not call the tool.', initialAvailable + 6);
  assert.equal(connectionCount, connectionsBeforeCompactedFork + 1);
  assert.deepEqual(runtime.snapshots().find((saved) => saved.thread.id === parent.id), parentAfter);
  assert.deepEqual(replay(runtime.journal), runtime.snapshots());
  checks.parentUnchangedByFork = true;
  checks.offlineReplayMatches = true;
  checks.toolExecutions = toolExecutions;
  checks.compactionCheckpoints = parentAfter.contextCheckpoints.length;
  checks.connectionCount = connectionCount;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  direct.close();
  const responses = [...observed.values()];
  if (compaction) {
    const u = compaction.usage;
    responses.push({ endpoint: u.endpoint, responseId: u.responseId, input: u.inputTokens, cached: u.cachedInputTokens, writes: u.cacheWriteTokens, output: u.outputTokens, reasoningTokens: u.reasoningTokens, status: compaction.status, estimatedUsd: estimate(u.inputTokens, u.cachedInputTokens, u.cacheWriteTokens, u.outputTokens) });
  }
  const estimatedUsd = responses.reduce((sum, entry) => sum + Number(entry.estimatedUsd), 0);
  result.passed = !failure; result.failure = failure ?? null;
  result.ledger = { date: new Date().toISOString(), generatedRequests: calls, generatedResponsesCreated: createdResponses, generatedUsageRows: observed.size, compactionsWithUsage: compaction ? 1 : 0, responses, estimatedUsd, actualBilling: 'unknown', inputCountingCalls: tokenCounts.length,
    pricing: { checkedOn: '2026-10-18', source: 'https://developers.openai.com/api/docs/models/gpt-6-luna', usdPerMillion: rates },
    bounds: { generated: 5, compact: 1, maxInputPerRequest: 10_000, maxGeneratedOutput: 1024, perCallTimeoutMs: 60_000, allocationUsd: .10, retries: 0 },
  };
  result.tokenCounts = tokenCounts;
  const directory = new URL(`../../../artifacts/043-hp-context-compaction/${Date.now()}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(new URL('summary.json', directory), JSON.stringify(result, null, 2) + '\n'),
    writeFile(new URL('raw.json', directory), JSON.stringify({ requests, responses: raw, compaction })),
    writeFile(new URL('journal.json', directory), JSON.stringify(runtime.journal)),
    writeFile(new URL('snapshots.json', directory), JSON.stringify(runtime.snapshots())),
  ]);
  console.log(JSON.stringify({ passed: !failure, failure: failure ?? null, checks, estimatedUsd, generated: observed.size, compaction: !!compaction, directory: directory.pathname }, null, 2));
  assert(estimatedUsd <= .10, 'Observed estimated spend exceeded allocation');
}
if (failure) process.exitCode = 1;

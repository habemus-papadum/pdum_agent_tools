/** Explicit paid qualification. Max 5 generated responses, max256 output each, no retries. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Agent, OpenAIProvider, Runner, setTracingDisabled } from '@openai/agents';
import OpenAI from 'openai';
import { DirectResponsesConnector } from './direct.js';
import { officialConnectionFactory } from './official-connection.js';
import type { ModelEvent, NativeItem } from './connector.js';

assert(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY required; run explicitly with the root --env-file');
setTracingDisabled(true);
const model = 'gpt-6-luna';
const steeringOnly = process.argv.includes('--steering-only');
const artifactPrefix = steeringOnly ? 'live-steering' : 'live';
const clients = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, maxRetries: 0, timeout: 30_000 });
const usage: NativeItem[] = [];
const raw: NativeItem[] = [];
const results: NativeItem = { model, date: new Date().toISOString(), versions: { openai: '7.38.0', agents: '0.20.0', node: process.version }, bounds: { maxResponses: steeringOnly ? 2 : 5, maxOutputTokensPerResponse: 256, perScenarioTimeoutMs: 30000, attempts: 1, maxEstimatedUsd: 0.10 }, tests: {} };
const tests = results.tests as NativeItem;
const artifactDir = new URL('../../../artifacts/038-hp-sdk-fit/', import.meta.url);
await mkdir(artifactDir, { recursive: true });
const rates = { input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50 };
function recordUsage(event: NativeItem) {
  const response = event.response as NativeItem | undefined;
  if (!response?.usage || usage.some((item) => item.responseId === response.id)) return;
  assert.equal(response.model, model);
  const data = response.usage as NativeItem;
  const detail = data.input_tokens_details as NativeItem;
  const input = Number(data.input_tokens), output = Number(data.output_tokens);
  const cached = Number(detail.cached_tokens ?? 0), cacheWrite = Number(detail.cache_write_tokens ?? 0);
  assert(input <= 4000 && output <= 256 && cached + cacheWrite <= input);
  assert(response.service_tier === 'default' || response.service_tier === undefined);
  const estimatedUsd = ((input - cached - cacheWrite) * rates.input + cached * rates.cachedInput + cacheWrite * rates.cacheWrite + output * rates.output) / 1e6;
  usage.push({ responseId: response.id, status: response.status, input, cached, cacheWrite, output, serviceTier: response.service_tier ?? 'not returned', estimatedUsd });
  assert(usage.length <= 5);
}
try {
  const provider = new OpenAIProvider({ openAIClient: clients(), useResponsesWebSocket: true });
  try {
    if (!steeringOnly) {
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
    const agent = new Agent({ name: 'sdk-live', model, instructions: 'Reply briefly.', modelSettings: { maxTokens: 256, providerData: { reasoning: { effort: 'none' }, service_tier: 'default' }, preserveRawUsage: true } });
    const result = await runner.run(agent, 'Reply with SDK_OK.', { stream: true, maxTurns: 1, signal: AbortSignal.timeout(30_000) });
    for await (const event of result) {
      if (event.type === 'raw_model_stream_event') {
        const data = event.data as NativeItem;
        if (data.type === 'model') { const modelEvent = data.event as NativeItem; raw.push(modelEvent); recordUsage(modelEvent); }
      }
    }
    tests.sdk = { passed: result.finalOutput?.includes('SDK_OK'), output: result.finalOutput, requestCount: result.state.usage.requests };
    }
  } catch (error) { tests.sdk = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
  finally { await provider.close(); }

  const connector = new DirectResponsesConnector(officialConnectionFactory(clients), { max_output_tokens: 256, reasoning: { effort: 'none' }, service_tier: 'default' });
  try {
    const input = [{ role: 'user', content: 'Give three short facts about the Moon, in three sentences.' }];
    const run = connector.run({ threadId: 'steering', turnId: 't1', model, instructions: 'Follow the latest user request. Keep output concise.', input, tools: [], signal: AbortSignal.timeout(30_000) });
    const events: ModelEvent[] = [];
    let sent = false;
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'raw') {
        raw.push(event.event); recordUsage(event.event);
        if (event.event.type === 'response.created' && !sent) { sent = true; await run.steer('Stop listing. Reply with exactly STEER_OK.'); }
      }
    }
    const states = events.filter((event) => event.type === 'steering').map((event) => event.state);
    const text = events.filter((event) => event.type === 'textDelta').map((event) => event.delta).join('');
    tests.steering = { passed: states.includes('accepted') && states.includes('committed') && text.includes('STEER_OK'), states, text };
  } catch (error) { tests.steering = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
  finally { connector.close(); }

  const tools = [{ type: 'custom', name: 'apply_patch', description: 'Return an empty patch for this protocol test.', format: { type: 'grammar', syntax: 'lark', definition: 'start: "*** Begin Patch\\n*** End Patch"' } }];
  const custom = new DirectResponsesConnector(officialConnectionFactory(clients), { max_output_tokens: 256, reasoning: { effort: 'none' }, service_tier: 'default' });
  try {
    if (!steeringOnly) {
    const input: NativeItem[] = [{ role: 'user', content: 'Call apply_patch once with an empty patch, then after its result reply CUSTOM_OK.' }];
    let call: Extract<ModelEvent, { type: 'toolCall' }> | undefined;
    const args = { threadId: 'custom', turnId: 't1', model, instructions: 'Use the named tool exactly once, then reply briefly.', input, tools, signal: AbortSignal.timeout(30_000) };
    for await (const event of custom.run(args).events) {
      if (event.type === 'raw') { raw.push(event.event); recordUsage(event.event); }
      if (event.type === 'outputItem' || event.type === 'inputItem') input.push(event.item);
      if (event.type === 'toolCall') call = event;
    }
    assert(call && call.kind === 'custom', 'Expected freeform custom_tool_call');
    assert.equal(call.arguments, '*** Begin Patch\n*** End Patch');
    input.push({ type: 'custom_tool_call_output', call_id: call.id, output: 'Empty patch accepted by fixture; no files changed.' });
    let text = '';
    for await (const event of custom.run({ ...args, tools: [] }).events) {
      if (event.type === 'raw') { raw.push(event.event); recordUsage(event.event); }
      if (event.type === 'textDelta') text += event.delta;
    }
    tests.customTool = { passed: text.includes('CUSTOM_OK'), tool: call.name, kind: call.kind, patch: call.arguments, text };
    }
  } catch (error) { tests.customTool = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
  finally { custom.close(); }
} finally {
  results.usage = usage;
  results.pricing = { checkedOn: '2026-10-18', source: 'https://developers.openai.com/api/docs/models/gpt-6-luna', usdPerMillion: rates, basis: 'Short-context standard API-equivalent estimate; actual billing unknown' };
  results.estimatedUsd = usage.reduce((sum, item) => sum + Number(item.estimatedUsd), 0);
  results.actualBilling = 'unknown';
  const unique = `${artifactPrefix}-${String(results.date).replace(/[:.]/g, '-')}`;
  await writeFile(new URL(`${unique}-summary.json`, artifactDir), JSON.stringify(results, null, 2) + '\n');
  await writeFile(new URL(`${unique}-events.jsonl`, artifactDir), raw.map((event) => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(new URL(`${artifactPrefix}-summary.json`, artifactDir), JSON.stringify(results, null, 2) + '\n');
  await writeFile(new URL(`${artifactPrefix}-events.jsonl`, artifactDir), raw.map((event) => JSON.stringify(event)).join('\n') + '\n');
  console.log(JSON.stringify(results, null, 2));
  if (Object.values(tests).some((test) => (test as NativeItem).passed === false)) process.exitCode = 1;
}

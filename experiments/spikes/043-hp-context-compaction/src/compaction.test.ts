import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import OpenAI from 'openai';
import { AgentRuntime, replay } from '../../039-hp-agent-runtime/src/runtime.ts';
import { FixtureConnector } from '../../039-hp-agent-runtime/src/fixture.ts';
import { compactIdleThread, inspectContext } from './compaction.ts';

const fixtureOutput = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained user item' }] },
  { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'opaque-fixture-never-provider-valid', created_by: 'model' },
];
const fixtureResponse = { id: 'cmp_response', object: 'response.compaction', created_at: 1, output: fixtureOutput,
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 112 } };

async function setup(mode: 'success' | 'hold' | 'error' = 'success') {
  let received!: () => void;
  const seen = new Promise<void>((resolve) => { received = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    assert.equal(req.url, '/v1/responses/compact');
    received();
    if (mode === 'hold') await held;
    res.setHeader('content-type', 'application/json');
    if (mode === 'error') { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'injected server failure', type: 'server_error' } })); }
    else res.end(JSON.stringify(fixtureResponse));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new OpenAI({ apiKey: 'local-fixture-only', baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 });
  const runtime = new AgentRuntime({ connector: new FixtureConnector(), instructions: 'fixture instructions' });
  const thread = runtime.create();
  runtime.start(thread.id, 'Remember a small fact');
  await runtime.wait(thread.id);
  return { client, runtime, thread, requests, seen, release, async close() { release(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test('compaction keeps canonical output, transcript, opaque checkpoint and separate endpoint usage', async () => {
  const env = await setup();
  try {
    const before = env.runtime.read(env.thread.id);
    const outcome = await compactIdleThread(env.runtime, env.thread.id, env.client);
    assert.equal(outcome.status, 'applied');
    assert.deepEqual(env.runtime.context(env.thread.id), fixtureOutput);
    assert.deepEqual(env.runtime.read(env.thread.id), before);
    assert.equal(env.runtime.usages.length, 0, 'Do not forge a model turn for compaction usage');
    assert.deepEqual(outcome.usage, { endpoint: 'responses.compact', responseId: 'cmp_response', threadId: env.thread.id,
      afterTurnId: before.turns.at(-1)!.id, model: 'gpt-6-luna', inputTokens: 100, cachedInputTokens: 7,
      cacheWriteTokens: 3, outputTokens: 12, reasoningTokens: 4, raw: fixtureResponse.usage });
    const saved = replay(env.runtime.journal).find((item) => item.thread.id === env.thread.id)!;
    assert.equal(saved.contextCheckpoints.length, 1);
    assert.deepEqual(saved.contextCheckpoints[0]!.input, fixtureOutput);
    const fork = env.runtime.fork(env.thread.id);
    assert.deepEqual(env.runtime.context(fork.id), fixtureOutput);
    const facts = inspectContext(fixtureOutput);
    assert.equal(facts.opaqueCompactionItems, 1); assert.equal(facts.fullContextTokens, null);
    const request = env.requests[0] as Record<string, unknown>;
    assert.equal(request.service_tier, 'default'); assert.equal(request.instructions, 'fixture instructions');
  } finally { await env.close(); }
});

test('a turn started while compact is in flight cannot be overwritten; discarded work keeps usage', async () => {
  const env = await setup('hold');
  try {
    const compact = compactIdleThread(env.runtime, env.thread.id, env.client);
    await env.seen;
    env.runtime.start(env.thread.id, 'Newer user input'); await env.runtime.wait(env.thread.id);
    const newer = env.runtime.snapshots();
    env.release();
    const outcome = await compact;
    assert.equal(outcome.status, 'discarded'); assert.equal(outcome.reason, 'thread_changed');
    assert.equal(outcome.usage.outputTokens, 12);
    assert.deepEqual(env.runtime.snapshots(), newer);
  } finally { await env.close(); }
});

test('active compaction fails before any request, provider errors leave context unchanged and are not retried', async () => {
  const env = await setup('error');
  try {
    const turn = env.runtime.start(env.thread.id, 'Busy turn');
    await assert.rejects(compactIdleThread(env.runtime, env.thread.id, env.client), /idle thread/);
    assert.equal(env.requests.length, 0);
    env.runtime.interrupt(env.thread.id, turn.id); await env.runtime.wait(env.thread.id);
    const before = env.runtime.snapshots();
    await assert.rejects(compactIdleThread(env.runtime, env.thread.id, env.client), /injected server failure/);
    assert.deepEqual(env.runtime.snapshots(), before); assert.equal(env.requests.length, 1);
  } finally { await env.close(); }
});

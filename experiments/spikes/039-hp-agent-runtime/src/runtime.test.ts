import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import type { ModelConnector, ModelEvent } from '../../038-hp-sdk-fit/src/connector.ts';
import { AgentRuntime, replay, type Turn } from './runtime.ts';
import { PortClient, servePort, type Port } from './protocol.ts';
import { FixtureConnector, echoTool } from './fixture.ts';
import { runDemo } from './demo.ts';
import { historyRows } from './history.ts';

test('full client demonstration uses actual Node MessagePorts, isolated fork and offline replay', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector(), tools: [echoTool] });
  const channel = new MessageChannel(); const stop = servePort(runtime, channel.port1 as unknown as Port);
  const client = new PortClient(channel.port2 as unknown as Port);
  try {
    const result = await runDemo(client);
    assert.equal(result.parentUnchanged, true); assert.equal(result.contextSeparatedFromTranscript, true);
    assert.deepEqual(result.replay, { threads: 3, turns: 5, items: 14 });
    const rows = historyRows(runtime);
    assert.equal(rows.tables.responses!.length, 0, 'fixtures must not fabricate paid-model usage');
    assert.equal(rows.tables.items!.filter((i) => i.item_type === 'toolCall' && i.origin === 'runtime').length, 1);
    assert.equal(rows.tables.fork_edges!.length, 1); assert.equal(rows.tables.spawn_edges!.length, 1);
  } finally { client.close(); stop(); channel.port1.close(); channel.port2.close(); }
});

test('history reads and fork do not invoke model; returned objects cannot mutate history', async () => {
  const connector = new FixtureConnector(); const runtime = new AgentRuntime({ connector });
  const t = runtime.create(); runtime.start(t.id, 'Hello'); await runtime.wait(t.id);
  const count = connector.calls; const read = runtime.read(t.id); read.turns.splice(0);
  runtime.list(); const fork = runtime.fork(t.id); replay(runtime.journal);
  assert.equal(runtime.read(t.id).turns.length, 1); assert.equal(runtime.read(fork.id).turns.length, 1);
  assert.equal(connector.calls, count);
});

test('interrupt during streaming settles interrupted and observer errors do not fail execution', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector() });
  const t = runtime.create();
  runtime.subscribe(() => { throw new Error('bad observer'); });
  runtime.subscribe((event) => {
    if (event.method === 'item/agentMessage/delta') runtime.interrupt(t.id, String(event.params.turnId));
  });
  runtime.start(t.id, 'Hello'); const turn = await runtime.wait(t.id);
  assert.equal(turn?.status, 'interrupted');
  assert.ok(runtime.journal.some((e) => e.kind === 'observerFailure'));
});

test('wrong-turn steering fails, pending steering cannot enter historical model context', async () => {
  let signalStarted!: () => void; const started = new Promise<void>((r) => { signalStarted = r; });
  let finish!: () => void; const done = new Promise<void>((r) => { finish = r; });
  const connector: ModelConnector = { run: () => ({
    events: (async function* (): AsyncGenerator<ModelEvent> { yield { type: 'raw', event: { type: 'response.created', response: { id: 'fixture' } } }; signalStarted(); await done; yield { type: 'completed', responseId: 'fixture' }; })(),
    steer: async () => { /* sent but no committed event */ },
  }) };
  const runtime = new AgentRuntime({ connector }); const t = runtime.create(); const turn = runtime.start(t.id, 'Original');
  await started;
  await assert.rejects(runtime.steer(t.id, 'wrong', 'bad'), /expectedTurnId/);
  await runtime.steer(t.id, turn.id, 'UNCOMMITTED'); finish(); await runtime.wait(t.id);
  assert.ok(JSON.stringify(runtime.read(t.id)).includes('UNCOMMITTED'));
  assert.ok(!JSON.stringify(runtime.context(t.id)).includes('UNCOMMITTED'));
});

test('failed tool becomes a tool result, context checkpoint is separate from transcript', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector(), tools: [{ ...echoTool, execute: async () => { throw new Error('host failure'); } }] });
  const t = runtime.create(); runtime.start(t.id, 'tool'); const done = await runtime.wait(t.id);
  assert.equal(done?.status, 'completed'); assert.equal(done?.items.find((i) => i.type === 'dynamicToolCall')?.success, false);
  assert.ok(JSON.stringify(runtime.context(t.id)).includes('host failure'));
  const history = runtime.read(t.id); runtime.replaceContext(t.id, [{ role: 'developer', content: 'summary supplied by host' }], 'test checkpoint');
  assert.deepEqual(runtime.read(t.id), history); assert.equal(runtime.context(t.id).length, 1);
});

test('active fork and duplicate start are explicit unsupported operations', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector() }); const t = runtime.create();
  const turn = runtime.start(t.id, 'Hello');
  assert.throws(() => runtime.fork(t.id), /completed turn boundary/);
  assert.throws(() => runtime.start(t.id, 'duplicate'), /explicit steer/);
  runtime.interrupt(t.id, turn.id); assert.equal((await runtime.wait(t.id))?.status, 'interrupted');
});

test('numeric and string request IDs remain distinct and unsupported methods fail', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector() }); const channel = new MessageChannel();
  const stop = servePort(runtime, channel.port1 as unknown as Port); const seen: unknown[] = [];
  const done = new Promise<void>((resolve) => channel.port2.on('message', (value) => { seen.push(value); if (seen.length === 2) resolve(); }));
  channel.port2.postMessage({ id: 1, method: 'initialize', params: {} });
  channel.port2.postMessage({ id: '1', method: 'thread/compact/start', params: {} });
  await done;
  assert.equal((seen[0] as { id: unknown }).id, 1); assert.equal((seen[1] as { id: unknown }).id, '1');
  assert.equal((seen[1] as { error: { code: number } }).error.code, -32601);
  stop(); channel.port1.close(); channel.port2.close();
});

test('two clients can listen to the same runtime without ownership locks', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector() });
  const channels = [new MessageChannel(), new MessageChannel()];
  const stops = channels.map((c) => servePort(runtime, c.port1 as unknown as Port));
  const clients = channels.map((c) => new PortClient(c.port2 as unknown as Port));
  try {
    await Promise.all(clients.map((c) => c.request('initialize')));
    const counts = [0, 0]; clients.forEach((c, i) => c.subscribe((e) => { if (e.method === 'turn/completed') counts[i]! += 1; }));
    const t = runtime.create(); await clients[0]!.request('turn/start', { threadId: t.id, input: [{ type: 'text', text: 'Hi' }] });
    const result = await clients[1]!.request<{ turn: Turn }>('hp/agent/wait', { threadId: t.id });
    assert.equal(result.turn.status, 'completed');
    // Message ports preserve ordering per destination; query each to drain completion messages.
    await Promise.all(clients.map((c) => c.request('thread/list'))); assert.deepEqual(counts, [1, 1]);
  } finally { clients.forEach((c) => c.close()); stops.forEach((s) => s()); channels.forEach((c) => { c.port1.close(); c.port2.close(); }); }
});

test('rejected steering dispatch creates no ghost user item or model input', async () => {
  let started!: () => void; const ready = new Promise<void>((r) => { started = r; });
  let finish!: () => void; const end = new Promise<void>((r) => { finish = r; });
  const connector: ModelConnector = { run: () => ({
    events: (async function* (): AsyncGenerator<ModelEvent> { yield { type: 'raw', event: { type: 'response.created', response: { id: 'fixture' } } }; started(); await end; yield { type: 'completed', responseId: 'fixture' }; })(),
    steer: async () => { throw new Error('connection not ready'); },
  }) };
  const runtime = new AgentRuntime({ connector }); const t = runtime.create(); const turn = runtime.start(t.id, 'A'); await ready;
  await assert.rejects(runtime.steer(t.id, turn.id, 'GHOST'), /not ready/); finish(); await runtime.wait(t.id);
  assert.equal(runtime.read(t.id).turns[0]!.items.length, 1);
  assert.ok(!JSON.stringify(runtime.context(t.id)).includes('GHOST'));
  assert.equal(runtime.inspectInputs(t.id).at(-1)?.state, 'failed');
});

test('final native output items reconcile text and phase, including an output-only message', async () => {
  const connector: ModelConnector = { run: () => ({
    events: (async function* (): AsyncGenerator<ModelEvent> {
      yield { type: 'textDelta', itemId: 'a', delta: 'partial' };
      yield { type: 'outputItem', item: { id: 'a', type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Canonical text' }] } };
      yield { type: 'outputItem', item: { id: 'b', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Output-only answer' }] } };
      yield { type: 'completed', responseId: 'fixture' };
    })(), steer: async () => {},
  }) };
  const runtime = new AgentRuntime({ connector }); const t = runtime.create(); runtime.start(t.id, '🙂');
  const turn = await runtime.wait(t.id);
  assert.equal(turn!.items.find((i) => i.id === 'a')?.text, 'Canonical text');
  assert.equal(turn!.items.find((i) => i.id === 'a')?.phase, 'commentary');
  assert.equal(turn!.items.find((i) => i.id === 'b')?.text, 'Output-only answer');
  assert.equal(turn!.items.find((i) => i.id === 'b')?.phase, 'final_answer');
  const user = historyRows(runtime).tables.items!.find((i) => i.item_type === 'userMessage');
  assert.equal(user?.text, '🙂'); assert.equal(user?.text_len, 1);
});

test('fork start notification contains final lineage and parent context is not transiently changed', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector() }); const t = runtime.create();
  runtime.start(t.id, 'Hello'); await runtime.wait(t.id);
  const fork = runtime.fork(t.id);
  const notifications = runtime.journal.filter((e) => e.kind === 'notification' && e.data.method === 'thread/started')
    .map((e) => (e.data.params as { thread: { id: string; forkedFromId: string; sessionId: string; turns: unknown[] } }).thread)
    .filter((thread) => thread.id === fork.id);
  assert.equal(notifications.length, 1); assert.equal(notifications[0]?.forkedFromId, t.id);
  assert.equal(notifications[0]?.sessionId, t.sessionId); assert.deepEqual(notifications[0]?.turns, []);
});

test('truncated model stream fails instead of reporting a completed turn', async () => {
  const connector: ModelConnector = { run: () => ({ events: (async function* (): AsyncGenerator<ModelEvent> {
    yield { type: 'textDelta', itemId: 'partial', delta: 'Partial answer' };
  })(), steer: async () => {} }) };
  const runtime = new AgentRuntime({ connector }); const t = runtime.create(); runtime.start(t.id, 'Hello');
  assert.equal((await runtime.wait(t.id))?.status, 'failed');
});

test('concurrent children can be messaged and interrupted independently of their parent', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector() }); const parent = runtime.create();
  runtime.start(parent.id, 'Parent');
  const first = runtime.spawn(parent.id, 'First child'); const second = runtime.spawn(parent.id, 'Second child');
  await new Promise<void>((resolve) => {
    const unsubscribe = runtime.subscribe((event) => {
      if (event.method === 'item/agentMessage/delta' && event.params.threadId === first.threadId) { unsubscribe(); resolve(); }
    });
  });
  await runtime.message(first.threadId, 'CHILD STEERING'); runtime.interrupt(second.threadId, second.turnId);
  const [parentTurn, firstTurn, secondTurn] = await Promise.all([runtime.wait(parent.id), runtime.wait(first.threadId), runtime.wait(second.threadId)]);
  assert.equal(parentTurn?.status, 'completed'); assert.equal(firstTurn?.status, 'completed'); assert.equal(secondTurn?.status, 'interrupted');
  assert.ok(JSON.stringify(runtime.context(first.threadId)).includes('CHILD STEERING'));
  assert.ok(runtime.inspectInputs(parent.id).some((input) => input.kind === 'completion'));
});

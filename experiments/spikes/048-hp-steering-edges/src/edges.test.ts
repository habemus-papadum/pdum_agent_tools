import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import OpenAI from 'openai';
import { WebSocketServer, type WebSocket } from 'ws';
import { DirectResponsesConnector } from '../../038-hp-sdk-fit/src/direct.ts';
import { officialConnectionFactory } from '../../038-hp-sdk-fit/src/official-connection.ts';
import type { ModelEvent, ModelRunArgs, NativeItem, ResponsesConnectionFactory } from '../../038-hp-sdk-fit/src/connector.ts';

type Peer = { socket: WebSocket; id: number; send(event: NativeItem): void };
async function fixture(handle: (event: NativeItem, peer: Peer) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening'); const address = server.address(); assert(address && typeof address !== 'string');
  const requests: { connection: number; event: NativeItem }[] = [];
  let connections = 0;
  server.on('connection', (socket) => {
    let sequence = 0;
    const peer = { socket, id: ++connections, send(event: NativeItem) { socket.send(JSON.stringify({ sequence_number: sequence++, ...event })); } };
    socket.on('message', (data) => { const event = JSON.parse(data.toString()); requests.push({ connection: peer.id, event }); handle(event, peer); });
  });
  const factory = officialConnectionFactory(() => new OpenAI({ apiKey: 'local-fault-peer-only', baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 }));
  const connector = new DirectResponsesConnector(factory);
  return { connector, factory, requests, get connections() { return connections; },
    async close() { connector.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>((r) => server.close(() => r())); } };
}
const message = (id: string, text = 'DONE'): NativeItem => ({ id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const tool = (id: string): NativeItem => ({ id: `fc_${id}`, call_id: id, type: 'function_call', name: 'side_effect', arguments: '{}', status: 'completed' });
const response = (id: string, parent: string | null, output: NativeItem[] = [], status = 'completed'): NativeItem => ({ id, previous_response_id: parent, status, model: 'gpt-6-luna', output,
  incomplete_details: status === 'incomplete' ? { reason: 'steered' } : null,
  usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 } } });
const created = (peer: Peer, id: string, parent: string | null = null) => peer.send({ type: 'response.created', response: response(id, parent, [], 'in_progress') });
const complete = (peer: Peer, id: string, parent: string | null = null, output = [message(`msg_${id}`)]) => {
  for (const item of output) peer.send({ type: 'response.output_item.done', item });
  peer.send({ type: 'response.completed', response: response(id, parent, output) });
};
const args = (input: NativeItem[], signal = AbortSignal.timeout(3000)): ModelRunArgs => ({ threadId: 'thread', turnId: crypto.randomUUID(), model: 'gpt-6-luna', instructions: 'Local fault test', tools: [], input, signal });
const apply = (input: NativeItem[], event: ModelEvent) => {
  if (event.type === 'inputItem') input.splice(event.index ?? input.length, 0, event.item);
  if (event.type === 'outputItem') input.push(event.item);
};
const user = (text: string) => ({ role: 'user', content: text });

// These are client state-machine tests, not synthetic evidence of provider support.
test('multiple queued steers commit in submission order and readiness precedes response.created observation', async () => {
  let steers = 0;
  const env = await fixture((event, peer) => {
    if (event.type === 'response.create') created(peer, 'r1');
    else {
      peer.send({ type: 'response.steer.accepted', steer: { id: `s${++steers}`, previous_response_id: 'r1' } });
      if (steers === 2) {
        peer.send({ type: 'response.incomplete', response: response('r1', null, [], 'incomplete') });
        created(peer, 'r2', 'r1'); complete(peer, 'r2', 'r1');
      }
    }
  });
  try {
    const input: NativeItem[] = [user('original')]; const run = env.connector.run(args(input));
    assert.equal(run.status, 'opening'); await assert.rejects(run.steer('too early'), /No active response/);
    const events: ModelEvent[] = [];
    for await (const event of run.events) {
      events.push(event); apply(input, event);
      if (event.type === 'raw' && event.event.type === 'response.created' && (event.event.response as NativeItem).id === 'r1') {
        assert.equal(run.status, 'running');
        const a = await run.steer('first'), b = await run.steer('second');
        assert(a && b); assert.notEqual(a.receiptId, b.receiptId);
      }
      if (event.type === 'raw' && event.event.type === 'response.completed') await assert.rejects(run.steer('too late'), /No active response/);
    }
    assert.deepEqual(input.slice(0, 3), [user('original'), user('first'), user('second')]);
    assert.deepEqual(run.steeringReceipts?.map((r) => r.state), ['committed', 'committed']);
    assert.equal(events.filter((event) => event.type === 'usage').length, 2);
  } finally { await env.close(); }
});

test('pending provider steering is inserted before tool results and later local input; next turn keeps same socket', async () => {
  let creates = 0, steers = 0;
  const env = await fixture((event, peer) => {
    if (event.type === 'response.create') {
      const index = ++creates; created(peer, `r${index}`, index > 1 ? `r${index - 1}` : null);
      if (index > 1) complete(peer, `r${index}`, `r${index - 1}`);
    } else {
      peer.send({ type: 'response.steer.accepted', steer: { id: `s${++steers}`, previous_response_id: 'r1' } });
      if (steers === 2) {
        complete(peer, 'r1', null, [tool('call1')]);
        for (const id of ['s1', 's2']) peer.send({ type: 'response.steer.pending', steer: { id, previous_response_id: 'r1' }, required_input: [{ type: 'function_call_output', call_id: 'call1' }] });
      }
    }
  });
  try {
    const input: NativeItem[] = [user('original')]; const first = env.connector.run(args(input));
    for await (const event of first.events) {
      apply(input, event);
      if (event.type === 'raw' && event.event.type === 'response.created') { await first.steer('first'); await first.steer('second'); }
    }
    assert.equal(first.status, 'waitingForTools');
    input.push({ type: 'function_call_output', call_id: 'call1', output: 'saved once' }, user('later local input'));
    for await (const event of env.connector.run(args(input)).events) apply(input, event);
    assert.deepEqual(input.slice(0, 6), [user('original'), tool('call1'), user('first'), user('second'), { type: 'function_call_output', call_id: 'call1', output: 'saved once' }, user('later local input')]);
    const secondRequest = env.requests.filter((row) => row.event.type === 'response.create')[1]!.event;
    assert.deepEqual(secondRequest.input, [{ type: 'function_call_output', call_id: 'call1', output: 'saved once' }, user('later local input')]);
    input.push(user('next turn'));
    for await (const event of env.connector.run(args(input)).events) apply(input, event);
    const thirdRequest = env.requests.filter((row) => row.event.type === 'response.create')[2]!.event;
    assert.deepEqual(thirdRequest.input, [user('next turn')]); assert.equal(thirdRequest.previous_response_id, 'r2');
    assert.equal(env.connections, 1);
  } finally { await env.close(); }
});

test('failed steers before and after acceptance remain distinct and do not enter context', async () => {
  let steers = 0;
  const env = await fixture((event, peer) => {
    if (event.type === 'response.create') created(peer, 'r1');
    else if (++steers === 1) peer.send({ type: 'response.steer.accepted', steer: { id: 's1', previous_response_id: 'r1' } });
    else {
      const failed = { type: 'response.steer.failed', sequence_number: 700, steer: { previous_response_id: 'r1', input: 'second' }, error: { code: 'invalid_input' } };
      peer.send(failed); peer.send(failed);
      peer.send({ type: 'response.steer.failed', steer: { id: 's1', previous_response_id: 'r1', input: 'first' }, error: { code: 'successor_creation_failed' } });
      complete(peer, 'r1');
    }
  });
  try {
    const input: NativeItem[] = [user('original')], run = env.connector.run(args(input));
    const events: ModelEvent[] = [];
    for await (const event of run.events) {
      events.push(event); apply(input, event);
      if (event.type === 'raw' && event.event.type === 'response.created') { await run.steer('first'); await run.steer('second'); }
    }
    assert.deepEqual(run.steeringReceipts?.map((r) => [r.input, r.state]), [['first', 'failed'], ['second', 'failed']]);
    assert.equal(events.filter((e) => e.type === 'steering' && e.state === 'failed').length, 2);
    assert.equal(events.filter((e) => e.type === 'inputItem').length, 0);
    assert(events.some((e) => e.type === 'raw' && e.duplicate));
  } finally { await env.close(); }
});

for (const accepted of [false, true]) test(`socket loss ${accepted ? 'after' : 'before'} acceptance is unknown and never auto-replayed`, async () => {
  const env = await fixture((event, peer) => {
    if (event.type === 'response.create') { created(peer, `r${peer.id}`); if (peer.id > 1) complete(peer, `r${peer.id}`); }
    else {
      if (accepted) peer.send({ type: 'response.steer.accepted', steer: { id: 's1', previous_response_id: 'r1' } });
      peer.socket.close();
    }
  });
  try {
    const input: NativeItem[] = [user('original')], run = env.connector.run(args(input));
    await assert.rejects(async () => {
      for await (const event of run.events) {
        apply(input, event);
        if (event.type === 'raw' && event.event.type === 'response.created') await run.steer('UNCOMMITTED');
      }
    }, /outcome unknown/);
    assert.equal(run.steeringReceipts?.[0]?.state, 'unknown');
    input.push(user('new turn'));
    for await (const event of env.connector.run(args(input)).events) apply(input, event);
    assert.equal(env.connections, 2);
    const last = env.requests.at(-1)!.event;
    assert.equal(last.previous_response_id, undefined);
    assert(!JSON.stringify(last.input).includes('UNCOMMITTED'));
    assert.equal(env.requests.filter((row) => row.event.type === 'response.steer').length, 1);
  } finally { await env.close(); }
});

test('discard during host-tool phase evicts the socket and unresolved accepted input', async () => {
  const env = await fixture((event, peer) => {
    if (event.type === 'response.create') { created(peer, `r${peer.id}`); if (peer.id > 1) complete(peer, `r${peer.id}`); }
    else { peer.send({ type: 'response.steer.accepted', steer: { id: 's1', previous_response_id: 'r1' } }); complete(peer, 'r1', null, [tool('call1')]); }
  });
  try {
    const input: NativeItem[] = [user('original')], run = env.connector.run(args(input));
    for await (const event of run.events) { apply(input, event); if (event.type === 'raw' && event.event.type === 'response.created') await run.steer('old queued update'); }
    assert.equal(run.status, 'waitingForTools');
    const receipts = env.connector.discardThread('thread'); assert.equal(receipts[0]?.state, 'unknown');
    input.push({ type: 'function_call_output', call_id: 'call1', output: 'Interrupted: not executed; no tool retry.' }, user('next turn'));
    for await (const event of env.connector.run(args(input)).events) apply(input, event);
    assert.equal(env.connections, 2); assert(!JSON.stringify(env.requests.at(-1)!.event.input).includes('old queued update'));
    assert.equal(env.requests.at(-1)!.event.previous_response_id, undefined);
  } finally { await env.close(); }
});

test('interrupt after completed tool item but before response terminal allows explicit repaired next turn', async () => {
  const env = await fixture((event, peer) => {
    if (event.type !== 'response.create') return;
    created(peer, `r${peer.id}`);
    if (peer.id === 1) peer.send({ type: 'response.output_item.done', item: tool('call1') });
    else complete(peer, `r${peer.id}`);
  });
  try {
    const input: NativeItem[] = [user('original')], controller = new AbortController();
    await assert.rejects(async () => {
      for await (const event of env.connector.run(args(input, controller.signal)).events) {
        apply(input, event); if (event.type === 'toolCall') controller.abort(new Error('Interrupted before tool execution'));
      }
    });
    input.push({ type: 'function_call_output', call_id: 'call1', output: 'aborted before execution' }, user('next turn'));
    for await (const event of env.connector.run(args(input)).events) apply(input, event);
    assert.equal(env.connections, 2);
    assert.deepEqual((env.requests.at(-1)!.event.input as NativeItem[]).slice(0, 4), input.slice(0, 4));
  } finally { await env.close(); }
});

test('duplicate final item and prior terminal do not duplicate tools or usage; equal text deltas remain', async () => {
  let creates = 0;
  const env = await fixture((event, peer) => {
    if (event.type !== 'response.create') return;
    if (++creates === 1) {
      created(peer, 'r1'); const item = tool('call1');
      peer.send({ type: 'response.output_item.done', item }); peer.send({ type: 'response.output_item.done', item });
      const terminal = { type: 'response.completed', response: response('r1', null, [item]) };
      peer.send(terminal); peer.send(terminal);
    } else {
      created(peer, 'r2', 'r1');
      peer.send({ type: 'response.output_text.delta', item_id: 'msg_r2', delta: 'same' });
      peer.send({ type: 'response.output_text.delta', item_id: 'msg_r2', delta: 'same' });
      complete(peer, 'r2', 'r1', [message('msg_r2', 'samesame')]);
    }
  });
  try {
    const input: NativeItem[] = [user('original')], events: ModelEvent[] = [];
    for await (const event of env.connector.run(args(input)).events) { events.push(event); apply(input, event); }
    input.push({ type: 'function_call_output', call_id: 'call1', output: 'one execution' });
    for await (const event of env.connector.run(args(input)).events) { events.push(event); apply(input, event); }
    assert.equal(events.filter((event) => event.type === 'toolCall').length, 1);
    assert.deepEqual(events.filter((event) => event.type === 'usage').map((event) => event.responseId), ['r1', 'r2']);
    assert.equal(events.filter((event) => event.type === 'textDelta').map((event) => event.delta).join(''), 'samesame');
    assert(events.filter((event) => event.type === 'raw' && event.duplicate).length >= 2);
  } finally { await env.close(); }
});

test('concurrent startup is rejected and discarding a pending factory closes its eventual connection', async () => {
  const env = await fixture((event, peer) => { if (event.type === 'response.create') { created(peer, `r${peer.id}`); complete(peer, `r${peer.id}`); } });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let opened!: () => void; const ready = new Promise<void>((r) => { opened = r; });
  let first = true;
  const delayed: ResponsesConnectionFactory = async (signal) => { const connection = await env.factory(signal); if (first) { first = false; opened(); await gate; } return connection; };
  const connector = new DirectResponsesConnector(delayed);
  try {
    const run = connector.run(args([user('first')]));
    const pendingNext = run.events[Symbol.asyncIterator]().next(); await ready;
    await assert.rejects(async () => { for await (const _ of connector.run(args([user('duplicate')])).events) {} }, /One active model round/);
    connector.discardThread('thread'); await assert.rejects(pendingNext);
    release();
    assert.equal(env.requests.length, 0);
    for await (const _ of connector.run(args([user('fresh')])).events) {}
    assert.equal(env.requests.filter((row) => row.event.type === 'response.create').length, 1);
  } finally { release(); connector.close(); await env.close(); }
});

test('conflicting final item identity fails visibly instead of silently suppressing changed data', async () => {
  const env = await fixture((event, peer) => {
    if (event.type !== 'response.create') return;
    created(peer, 'r1');
    peer.send({ type: 'response.output_item.done', item: message('same_id', 'first') });
    peer.send({ type: 'response.output_item.done', item: message('same_id', 'changed') });
  });
  try {
    const run = env.connector.run(args([user('original')])); const events: ModelEvent[] = [];
    await assert.rejects(async () => { for await (const event of run.events) events.push(event); }, /Conflicting final item/);
    assert.equal(events.filter((event) => event.type === 'raw' && event.duplicate).length, 0);
    assert.equal(run.status, 'failed');
  } finally { await env.close(); }
});

test('local discard closes steering immediately and a pre-aborted run reports failure without dispatch', async () => {
  const env = await fixture((event, peer) => { if (event.type === 'response.create') created(peer, 'r1'); });
  try {
    const run = env.connector.run(args([user('original')]));
    await assert.rejects(async () => {
      for await (const event of run.events) if (event.type === 'raw' && event.event.type === 'response.created') {
        env.connector.discardThread('thread');
        await assert.rejects(run.steer('after discard'), /No active response/);
      }
    });
    assert.equal(env.requests.filter((row) => row.event.type === 'response.steer').length, 0);
    const controller = new AbortController(); controller.abort();
    const aborted = env.connector.run(args([user('original')], controller.signal));
    await assert.rejects(async () => { for await (const _ of aborted.events) {} });
    assert.equal(aborted.status, 'failed');
  } finally { await env.close(); }
});

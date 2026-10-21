/** Failure-injection and state-machine checks with actual loopback WebSockets. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import type { NativeItem, ModelEvent } from './connector.js';
import { DirectResponsesConnector } from './direct.js';
import { officialConnectionFactory } from './official-connection.js';

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const requests: NativeItem[] = [];
let connectionCount = 0;
server.on('connection', (socket) => {
  connectionCount++;
  let previousId = '';
  let mode = '';
  let sequence = 0;
  const emit = (event: NativeItem) => socket.send(JSON.stringify({ sequence_number: sequence++, ...event }));
  const response = (id: string, status: string, output: NativeItem[] = []) => ({ id, status, model: 'gpt-6-luna', output, previous_response_id: previousId || null, incomplete_details: status === 'incomplete' ? { reason: mode === 'limited' ? 'max_output_tokens' : 'steered' } : null, usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } });
  const finish = (id: string) => {
    const item = { type: 'message', id: `msg_${id}`, role: 'assistant', content: [{ type: 'output_text', text: 'DONE' }] };
    emit({ type: 'response.output_item.done', item });
    emit({ type: 'response.completed', response: response(id, 'completed', [item]) });
  };
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString()) as NativeItem;
    requests.push(event);
    if (event.type === 'response.create') {
      mode = String(event.instructions);
      const id = previousId ? 'resp_successor' : 'resp_initial';
      emit({ type: 'response.created', response: response(id, 'in_progress') });
      if (previousId || mode === 'normal') finish(id);
    } else if (event.type === 'response.steer') {
      emit({ type: 'response.steer.accepted', steer: { id: 'steer_1', previous_response_id: 'resp_initial' } });
      if (mode === 'disconnect') { socket.close(); return; }
      if (mode === 'pending') {
        const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'echo', arguments: '{}' };
        emit({ type: 'response.output_item.done', item });
        emit({ type: 'response.completed', response: response('resp_initial', 'completed', [item]) });
        emit({ type: 'response.steer.pending', steer: { id: 'steer_1', previous_response_id: 'resp_initial' }, required_input: [{ type: 'function_call_output', call_id: 'call_1' }] });
        previousId = 'resp_initial';
      } else {
        emit({ type: 'response.incomplete', response: response('resp_initial', 'incomplete') });
        previousId = 'resp_initial';
        emit({ type: 'response.created', response: response('resp_successor', 'in_progress') });
        finish('resp_successor');
      }
    }
  });
});
const connector = new DirectResponsesConnector(officialConnectionFactory(() => new OpenAI({ apiKey: 'local-only', baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 })));
const summary: NativeItem = { evidence: 'Local scripted provider, public OpenAI SDK WebSocket transport', tests: [] };
const tests = summary.tests as NativeItem[];
try {
  for (const mode of ['steering', 'limited', 'pending', 'disconnect']) {
    const input: NativeItem[] = [{ role: 'user', content: 'original' }];
    const args = { threadId: mode, turnId: 't1', model: 'gpt-6-luna', instructions: mode, input, tools: [], signal: AbortSignal.timeout(2000) };
    const run = connector.run(args);
    const events: ModelEvent[] = [];
    let sent = false;
    let failure = '';
    try {
      for await (const event of run.events) {
        events.push(event);
        if (event.type === 'raw' && event.event.type === 'response.created' && !sent) { sent = true; await run.steer('new direction'); }
        if (event.type === 'inputItem') input.splice(event.index ?? input.length, 0, event.item);
        if (event.type === 'outputItem') input.push(event.item);
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    if (mode === 'pending') {
      input.push({ type: 'function_call_output', call_id: 'call_1', output: 'OK' });
      for await (const event of connector.run(args).events) {
        events.push(event);
        if (event.type === 'inputItem') input.splice(event.index ?? input.length, 0, event.item);
        if (event.type === 'outputItem') input.push(event.item);
      }
      const create = requests.filter((request) => request.type === 'response.create').at(-1)!;
      assert.equal(create.previous_response_id, 'resp_initial');
      assert.deepEqual(create.input, [{ type: 'function_call_output', call_id: 'call_1', output: 'OK' }]);
      assert.equal(input.filter((item) => item.content === 'new direction').length, 1);
    }
    const states = events.filter((event) => event.type === 'steering').map((event) => event.state);
    if (mode === 'disconnect') assert.match(failure, /outcome unknown/);
    else { assert(states.includes('accepted')); assert(states.includes('committed')); }
    tests.push({ mode, states, error: failure || null, passed: true });
  }
  // Replacing context deliberately starts a fresh chain; preserved history remains caller-owned.
  const args = { threadId: 'replace', turnId: 't1', model: 'gpt-6-luna', instructions: 'normal', input: [{ role: 'user', content: 'before' }], tools: [], signal: AbortSignal.timeout(2000) };
  for await (const _ of connector.run(args).events) { /* drain */ }
  const before = connectionCount;
  for await (const _ of connector.run({ ...args, input: [{ role: 'user', content: 'after context replacement' }] }).events) { /* drain */ }
  assert.equal(connectionCount, before + 1);
  tests.push({ mode: 'context replacement', freshConnection: true, passed: true });
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const interrupted = { ...args, threadId: `abandoned-${abort}`, signal: controller.signal };
    for await (const event of connector.run(interrupted).events) {
      if (event.type === 'raw' && event.event.type === 'response.created') {
        if (abort) controller.abort();
        break;
      }
    }
    const beforeRestart = connectionCount;
    for await (const _ of connector.run({ ...interrupted, signal: AbortSignal.timeout(2000) }).events) { /* drain */ }
    assert.equal(connectionCount, beforeRestart + 1);
    tests.push({ mode: abort ? 'abort and abandon iterator' : 'abandon iterator', freshConnectionOnRestart: true, passed: true });
  }

} finally {
  connector.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const directory = new URL('../../../artifacts/038-hp-sdk-fit/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('direct-local-summary.json', directory), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));

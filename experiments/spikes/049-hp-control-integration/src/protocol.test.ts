import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { AgentRuntime } from '../../039-hp-agent-runtime/src/runtime.ts';
import { FixtureConnector } from '../../039-hp-agent-runtime/src/fixture.ts';
import { PortClient, servePort, type Port } from '../../039-hp-agent-runtime/src/protocol.ts';

test('one broken UI listener does not prevent another client observing the same agent', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector() });
  const channels = [new MessageChannel(), new MessageChannel()];
  const stops = channels.map(c => servePort(runtime, c.port1 as unknown as Port));
  const clients = channels.map(c => new PortClient(c.port2 as unknown as Port));
  let observed = 0;
  try {
    for (const client of clients) await client.request('initialize', {});
    clients[0]!.subscribe(() => { throw Error('render failure'); });
    clients[1]!.subscribe(() => { observed++; });
    const { thread } = await clients[1]!.request<{ thread: { id: string } }>('thread/start', {});
    await clients[1]!.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'hello' }] });
    await runtime.wait(thread.id);
    // Drain each port's ordered delivery after turn completion.
    await Promise.all(clients.map(c => c.request('thread/list')));
    assert(observed > 0);
    assert(clients[0]!.diagnostics.some(d => d.kind === 'observerFailure'));
    assert.equal(runtime.read(thread.id).turns[0]!.status, 'completed');
  } finally { clients.forEach(c => c.close()); stops.forEach(s => s()); channels.forEach(c => { c.port1.close(); c.port2.close(); }); }
});

test('detaching a UI does not interrupt the runtime; another client can finish observing', async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector() });
  const channel = new MessageChannel();
  const stop = servePort(runtime, channel.port1 as unknown as Port);
  const client = new PortClient(channel.port2 as unknown as Port);
  try {
    await client.request('initialize');
    const { thread } = await client.request<{ thread: { id: string } }>('thread/start');
    await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'continue after detach' }] });
    client.close(); stop();
    assert.equal((await runtime.wait(thread.id))?.status, 'completed');
  } finally { client.close(); stop(); channel.port1.close(); channel.port2.close(); }
});

test('invalid envelopes and local send failure are explicit and leave no unresolved operation', async () => {
  let receive: (event: MessageEvent) => void = () => {};
  const port: Port = { postMessage() { throw Error('port closed'); }, addEventListener(_type, fn) { receive = fn; }, removeEventListener() {} };
  const client = new PortClient(port);
  receive({ data: null } as MessageEvent);
  assert.equal(client.diagnostics[0]?.kind, 'invalidEnvelope');
  await assert.rejects(client.request('thread/list'), /port closed/);
  client.close();
});

test('rejected async observers are recorded and unresolved observers do not block execution', { timeout: 1500 }, async () => {
  const runtime = new AgentRuntime({ connector: new FixtureConnector() });
  runtime.subscribe(async () => { throw Error('async runtime observer'); });
  runtime.subscribe(() => new Promise<void>(() => {}));
  const channel = new MessageChannel();
  const stop = servePort(runtime, channel.port1 as unknown as Port);
  const client = new PortClient(channel.port2 as unknown as Port);
  client.subscribe(async () => { throw Error('async client observer'); });
  try {
    await client.request('initialize');
    const { thread } = await client.request<{ thread: { id: string } }>('thread/start');
    await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'finish despite observers' }] });
    assert.equal((await runtime.wait(thread.id))?.status, 'completed');
    await client.request('thread/list');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(runtime.journal.some(e => e.kind === 'observerFailure' && String(e.data.error).includes('async runtime')));
    assert(client.diagnostics.some(d => d.kind === 'observerFailure' && d.message.includes('async client')));
  } finally { client.close(); stop(); channel.port1.close(); channel.port2.close(); }
});

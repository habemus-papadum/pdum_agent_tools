import { AgentRuntime } from '../../039-hp-agent-runtime/src/runtime.ts';
import { FixtureConnector } from '../../039-hp-agent-runtime/src/fixture.ts';
import { PortClient, servePort, type Port } from '../../039-hp-agent-runtime/src/protocol.ts';
import { ReplayFeed, FeedReader } from './attachment.ts';

function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() > deadline) throw Error('MessagePort check timed out'); await tick(); }
}

/** Real MessagePorts and portable runtime; scripted provider, no inference. */
export async function attachmentScenarios() {
  const connector = new FixtureConnector();
  const runtime = new AgentRuntime({ connector });
  const feed = new ReplayFeed(runtime);
  const channels: MessageChannel[] = [];
  const cleanups: (() => void)[] = [];
  const observer = () => {
    const channel = new MessageChannel(); channels.push(channel);
    const reader = new FeedReader(channel.port2 as unknown as Port);
    const detach = feed.attach(channel.port1 as unknown as Port);
    cleanups.push(detach, () => reader.close());
    return { reader, detach };
  };
  const controller = () => {
    const channel = new MessageChannel(); channels.push(channel);
    const stop = servePort(runtime, channel.port1 as unknown as Port);
    const client = new PortClient(channel.port2 as unknown as Port);
    cleanups.push(() => client.close(), stop);
    return client;
  };
  try {
    const a = observer(), b = observer();
    const controllerA = controller(), controllerB = controller();
    await controllerA.request('initialize'); await controllerB.request('initialize');
    const thread = runtime.create();
    await controllerA.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'First local task' }] });
    const c = observer(); // Attach while scripted response is streaming.
    a.detach(); b.detach(); c.detach();
    await runtime.wait(thread.id);
    check(connector.calls === 1, 'Disconnect changed the number of executed requests');
    const d = observer(), e = observer();
    await until(() => !d.reader.replaying && !e.reader.replaying);
    check(JSON.stringify(d.reader.notifications) === JSON.stringify(e.reader.notifications), 'Replays differ');
    const replayLength = d.reader.notifications.length;
    const callsBeforeRead = connector.calls;
    await controllerB.request('thread/read', { threadId: thread.id, includeTurns: true });
    check(connector.calls === callsBeforeRead, 'Inspection executed model');
    await controllerB.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Second local task' }] });
    await runtime.wait(thread.id);
    await until(() => d.reader.notifications.filter(x => x.event.method === 'turn/completed').length === 2);
    await until(() => e.reader.notifications.length === d.reader.notifications.length);
    check(JSON.stringify(d.reader.notifications) === JSON.stringify(e.reader.notifications), 'Live tails differ');
    for (const reader of [d.reader, e.reader]) {
      const seqs = reader.notifications.map(x => x.seq);
      check(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!), 'Duplicate/out-of-order feed entry');
      const boundary = reader.events.findIndex(x => x.kind === 'replay-end');
      check(boundary > 0 && reader.events.slice(boundary + 1).some(x => x.kind === 'notification'), 'Missing live tail');
    }
    check(Number(connector.calls) === 2, 'Replay executed extra model calls');
    return { passed: true, checks: 6, replayNotifications: replayLength, totalNotifications: d.reader.notifications.length, provider: 'scripted local', calls: connector.calls };
  } finally {
    cleanups.reverse().forEach(close => close()); feed.close(); runtime.dispose();
    channels.forEach(channel => { channel.port1.close(); channel.port2.close(); });
  }
}

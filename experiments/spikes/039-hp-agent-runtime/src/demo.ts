import { PortClient } from './protocol.ts';
import { replay, type JournalEntry, type Json, type Thread, type Turn } from './runtime.ts';
import { historySummary } from './history.ts';

/** Same client flow runs unchanged across Node MessageChannel and browser Worker MessagePort. */
export async function runDemo(client: PortClient, live = false): Promise<Json> {
  await client.request('initialize', { clientInfo: { name: 'hp-spike-demo', version: '0' }, capabilities: { experimentalApi: true } });
  const { thread } = await client.request<{ thread: Thread }>('thread/start');
  let sent = false; let steering: Promise<unknown> | undefined;
  const steeringStates: string[] = [];
  const unsubscribe = client.subscribe((event) => {
    if (event.method === 'hp/model/steering' && event.params.threadId === thread.id) steeringStates.push(String(event.params.state));
    if (event.method === (live ? 'hp/model/started' : 'item/agentMessage/delta') && event.params.threadId === thread.id && !sent) {
      sent = true;
      steering = client.request('turn/steer', { threadId: thread.id, expectedTurnId: event.params.turnId, input: [{ type: 'text', text: 'Finish with the word STEERED.' }] });
      // Retain outcome for report and avoid unhandled rejection if the turn finishes first.
      void steering.catch(() => {});
    }
  });
  const first = await client.request<{ turn: Turn }>('turn/start', { threadId: thread.id, input: [{ type: 'text', text: live ? 'Call echo with text "host tool result", then write three short sentences describing it.' : 'Use the tool, then finish.' }] });
  const completed = await client.request<{ turn: Turn }>('hp/agent/wait', { threadId: thread.id });
  unsubscribe();
  let steerOutcome = 'no delta observed';
  if (steering) { try { await steering; steerOutcome = 'dispatched'; } catch (error) { steerOutcome = String(error); } }
  if (completed.turn.status !== 'completed') throw new Error(`Main turn ${completed.turn.status}: ${JSON.stringify(completed.turn.error)}`);
  const toolCalls = completed.turn.items.filter((item) => item.type === 'dynamicToolCall');
  if (toolCalls.length !== 1 || toolCalls[0]?.success !== true) throw new Error('Expected one successful host tool call');
  if (!steeringStates.includes('committed')) throw new Error(`Steer was not committed: ${JSON.stringify(steeringStates)}`);
  const waitCompleted = async (id: string) => {
    const result = await client.request<{ turn: Turn }>('hp/agent/wait', { threadId: id });
    if (result.turn.status !== 'completed') throw new Error(`Child/fork turn ${result.turn.status}: ${JSON.stringify(result.turn.error)}`);
  };
  const before = await client.request('thread/read', { threadId: thread.id, includeTurns: true });
  const { thread: fork } = await client.request<{ thread: Thread }>('thread/fork', { threadId: thread.id });
  const child = await client.request<{ threadId: string; turnId: string }>('hp/agent/spawn', { parentThreadId: thread.id, prompt: 'Reply with CHILD.' });
  // Active input and a subsequent independent child turn exercise separate lifecycle ownership.
  await waitCompleted(child.threadId);
  await client.request('hp/agent/message', { threadId: child.threadId, text: 'Reply with CHILD AGAIN.' });
  await waitCompleted(child.threadId);
  await client.request('turn/start', { threadId: fork.id, input: [{ type: 'text', text: 'Reply with FORK.' }] });
  await waitCompleted(fork.id);
  const after = await client.request('thread/read', { threadId: thread.id, includeTurns: true });
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Fork or child mutated parent history');
  await client.request('hp/context/replace', { threadId: fork.id, reason: 'Explicit demonstration checkpoint; not automatic compaction', input: [{ role: 'developer', content: 'Conversation checkpoint: host tool executed; fork remains independent.' }] });
  const recording = await client.request<{ journal: JournalEntry[] }>('hp/recording/read');
  const offline = replay(recording.journal);
  return { mode: live ? 'live-provider' : 'deterministic-provider-fixture', mainThreadId: thread.id, firstTurnId: first.turn.id,
    childThreadId: child.threadId, forkThreadId: fork.id, steerOutcome, steeringStates, toolCalls: toolCalls.length, replay: historySummary(offline),
    contextSeparatedFromTranscript: offline.find((s) => s.thread.id === fork.id)!.context.length === 1,
    parentUnchanged: true, providerCompatibility: live ? 'see captured live result and limitations' : 'not tested by fixture' };
}

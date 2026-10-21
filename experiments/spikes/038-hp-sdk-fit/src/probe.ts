/** Real SDK against a scripted local provider. No upstream compatibility claim or credentials. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { Agent, OpenAIProvider, Runner, setTracingDisabled, tool } from '@openai/agents';
import OpenAI from 'openai';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

setTracingDisabled(true);
const model = 'gpt-6-luna';
type Json = Record<string, any>;
const requests: Json[] = [];
let connections = 0;
let sequence = 0;
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const baseURL = `http://127.0.0.1:${address.port}/v1`;
function emit(socket: WebSocket, event: Json) {
  socket.send(JSON.stringify({ sequence_number: sequence++, ...event }));
}
function response(id: string, output: Json[], status = 'completed'): Json {
  return { id, object: 'response', model, status, output, usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 1 } }, error: null, incomplete_details: status === 'incomplete' ? { reason: 'steered' } : null };
}
function message(id: string, text: string): Json {
  return { id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
}
function complete(socket: WebSocket, id: string, output: Json[]) {
  for (const [output_index, item] of output.entries()) {
    emit(socket, { type: 'response.output_item.added', output_index, item });
    emit(socket, { type: 'response.output_item.done', output_index, item });
  }
  emit(socket, { type: 'response.completed', response: response(id, output) });
}
server.on('connection', (socket) => {
  connections++;
  socket.on('message', (data) => {
    const request = JSON.parse(data.toString()) as Json;
    requests.push(request);
    const id = `resp_${requests.length}`;
    emit(socket, { type: 'response.created', response: response(id, [], 'in_progress') });
    const scenario = request.metadata?.scenario;
    if (scenario === 'steering') {
      emit(socket, { type: 'response.steer.accepted', steer: { id: 'steer_test', previous_response_id: id } });
      emit(socket, { type: 'response.incomplete', response: response(id, [], 'incomplete') });
      emit(socket, { type: 'response.created', response: response(`${id}_successor`, [], 'in_progress') });
      complete(socket, `${id}_successor`, [message('msg_successor', 'SUCCESSOR')]);
    } else if (scenario === 'custom') {
      complete(socket, id, [{ type: 'custom_tool_call', id: 'ct_1', call_id: 'call_custom', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' }]);
    } else if (scenario === 'function' && !request.input.some((item: Json) => item.type === 'function_call_output')) {
      complete(socket, id, [{ type: 'function_call', id: 'fc_1', call_id: 'call_exec', name: 'exec_command', arguments: '{"cmd":"echo hello"}', status: 'completed' }]);
    } else {
      setTimeout(() => complete(socket, id, [message(`msg_${id}`, 'DONE')]), scenario === 'child' ? 30 : 0);
    }
  });
});
const providers: OpenAIProvider[] = [];
function runner(scenario: string) {
  const provider = new OpenAIProvider({ openAIClient: new OpenAI({ apiKey: 'local-simulation-only', baseURL, maxRetries: 0, timeout: 2000 }), useResponsesWebSocket: true });
  providers.push(provider);
  return new Runner({ modelProvider: provider, tracingDisabled: true, modelSettings: { providerData: { metadata: { scenario } }, preserveRawUsage: true } });
}
const results: Json = { evidence: 'Actual Agents SDK + loopback scripted WebSocket; not provider qualification', versions: { openai: '7.38.0', agents: '0.20.0', agentsInternalOpenAI: '7.36.0', node: process.version }, tests: {} };
try {
  let toolRuns = 0;
  const exec = tool({ name: 'exec_command', description: 'Execute command (fixture)', parameters: z.object({ cmd: z.string() }), execute: async ({ cmd }) => { toolRuns++; assert.equal(cmd, 'echo hello'); return 'hello'; } });
  const functionAgent = new Agent({ name: 'function', model, tools: [exec] });
  const stream = await runner('function').run(functionAgent, 'Execute the command', { stream: true, maxTurns: 2 });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(stream.finalOutput, 'DONE');
  assert.equal(toolRuns, 1);
  assert.equal(stream.state.usage.requests, 2);
  assert(events.some((event) => event.type === 'raw_model_stream_event'));
  results.tests.functionToolAndRawUsage = { passed: true, toolRuns, usage: stream.state.usage, eventTypes: [...new Set(events.map((event) => event.type))] };

  const custom = { type: 'hosted_tool' as const, name: 'apply_patch', providerData: { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: "*** Begin Patch" "\\n" "*** End Patch"' } } };
  const customStart = requests.length;
  let customOutcome: Json;
  try {
    const result = await runner('custom').run(new Agent({ name: 'custom', model, tools: [custom] }), 'Apply a patch', { maxTurns: 1 });
    customOutcome = { finalOutput: result.finalOutput, items: result.newItems.map((item) => item.type) };
  } catch (error) { customOutcome = { error: error instanceof Error ? error.message : String(error) }; }
  const customRequest = requests[customStart]!;
  assert.equal(customRequest.tools[0].type, 'custom');
  results.tests.codexCustomTool = { declarationPreserved: true, output: customOutcome, note: 'Hosted-tool passthrough does not supply a local custom-tool executor.' };

  const steeringEvents: string[] = [];
  let steeringError = '';
  try {
    const steered = await runner('steering').run(new Agent({ name: 'steering', model }), 'Work', { stream: true, maxTurns: 1 });
    for await (const event of steered) {
      if (event.type === 'raw_model_stream_event') steeringEvents.push(JSON.stringify(event.data));
    }
  } catch (error) { steeringError = error instanceof Error ? error.message : String(error); }
  assert.match(steeringError, /incomplete/i);
  assert(!steeringEvents.some((event) => event.includes('SUCCESSOR')));
  results.tests.steering = { error: steeringError, successorConsumed: false, acceptedEventVisible: steeringEvents.some((event) => event.includes('response.steer.accepted')), note: 'Server injected steering lifecycle to test consumer behavior; SDK exposes no public steer sender.' };

  const contextStart = requests.length;
  await runner('context').run(new Agent({ name: 'context', model, instructions: 'original' }), 'original input', {
    maxTurns: 1,
    callModelInputFilter: () => ({ instructions: 'compiled prompt', input: [{ role: 'user', content: 'replacement context' }] }),
  });
  assert.equal(requests[contextStart]!.instructions, 'compiled prompt');
  assert.equal(requests[contextStart]!.input[0].content, 'replacement context');
  results.tests.contextReplacement = { passed: true };

  const before = connections;
  const children = ['left', 'right'].map(async (name) => {
    const result = await runner('child').run(new Agent({ name, model }), `Task ${name}`, { maxTurns: 1 });
    return { name, output: result.finalOutput, historyLength: result.history.length };
  });
  const childResults = await Promise.all(children);
  assert.equal(connections - before, 2);
  results.tests.independentRuns = { passed: true, children: childResults, connections: connections - before, note: 'Addressability/mailboxes/parent lifetime remain application responsibilities. Separate providers avoid same-model socket serialization.' };
} finally {
  await Promise.all(providers.map((provider) => provider.close()));
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const artifactDir = new URL('../../../artifacts/038-hp-sdk-fit/', import.meta.url);
await mkdir(artifactDir, { recursive: true });
await writeFile(new URL('local-summary.json', artifactDir), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));

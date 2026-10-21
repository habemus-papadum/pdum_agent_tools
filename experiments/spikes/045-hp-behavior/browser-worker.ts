import * as content from '@habemus-papadum/aiui-prompts';
import * as operations from '@habemus-papadum/aiui-prompts/operations';
import { bindPrompts, createFidelityAdapter, prepareRequest, recordRequest, type Json, type JsonObject, type TextInput } from '../041-hp-codex-fidelity/src/core.ts';
import { DirectResponsesConnector } from '../038-hp-sdk-fit/src/direct.ts';
import { AgentRuntime } from '../039-hp-agent-runtime/src/runtime.ts';
import { browserConnectionFactory } from '../039-hp-agent-runtime/src/browser-connection.ts';
import { servePort, type Port } from '../039-hp-agent-runtime/src/protocol.ts';
import { createStockApplication, validateDelegation, type StockRow } from './application.ts';

declare const __HP_NATIVE__: { instructions: TextInput; codex: unknown; aiui: unknown; model: string };
const prompts = bindPrompts(content, operations);
export interface Capture {
  operation: ReturnType<typeof recordRequest>;
  prepared: ReturnType<typeof prepareRequest>;
  wire: ReturnType<typeof prompts.captureWire>;
  verified: boolean;
}
let active: { runtime: AgentRuntime; application: ReturnType<typeof createStockApplication>; close: () => void } | undefined;
let detach: (() => void) | undefined;

export function createDelegationRuntime(url: string, rows: StockRow[], publish: (event: unknown) => void) {
  const captures: Capture[] = [];
  let requests = 0;
  const factory = browserConnectionFactory(url);
  const connector = new DirectResponsesConnector(async (signal) => {
    const connection = await factory(signal);
    return {
      close: () => connection.close(), events: connection.events,
      send(event) {
        if (event.type !== 'response.create') { connection.send(event); return; }
        if (++requests > 12) throw new Error('Delegation experiment request bound exceeded');
        const { type: _type, model, instructions, input, tools, ...fields } = event;
        if (model !== 'gpt-6-luna' || instructions !== __HP_NATIVE__.instructions.text) throw new Error('Unexpected model or prompt');
        const operation = recordRequest(prompts, { instructions: __HP_NATIVE__.instructions, model: String(model), input: input as Json[], tools: tools as Json[], fields: fields as JsonObject, layout: 'responses' });
        const prepared = prepareRequest(prompts, operation);
        if (content.canonicalJson(prepared.payload) !== content.canonicalJson(event)) throw new Error('Prompt adapter changed request');
        const payload = JSON.parse(JSON.stringify(prepared.payload)); connection.send(payload);
        const wire = prompts.captureWire(prepared, payload, { capturedAt: new Date().toISOString(), transportId: 'browser-delegation-websocket' });
        const verified = prompts.verifyWire(operation, wire, [createFidelityAdapter()]).equal;
        if (!verified) throw new Error('Wire replay differs');
        const capture = { operation, prepared, wire, verified }; captures.push(capture); publish({ kind: 'capture', capture });
      },
    };
  }, { max_output_tokens: 512, reasoning: { effort: 'none' }, service_tier: 'default' });
  const application = createStockApplication(rows, (annotation) => publish({ kind: 'annotation', annotation }));
  const runtime = new AgentRuntime({ connector, model: 'gpt-6-luna', instructions: __HP_NATIVE__.instructions.text, tools: application.tools });
  const abort = () => { for (const thread of runtime.list()) { const turn = runtime.read(thread.id).turns.at(-1); if (turn?.status === 'inProgress') runtime.interrupt(thread.id, turn.id); } };
  const timer = setTimeout(abort, 120000);
  publish({ kind: 'provenance', ...__HP_NATIVE__, instructions: { origin: __HP_NATIVE__.instructions.origin, utf16: __HP_NATIVE__.instructions.text.length }, effort: 'none', bounds: { maxRequests: 12, maxOutputTokens: 512, timeoutMs: 120000 }, framing: 'Public Responses translation, not Responses Lite' });
  return { runtime, application, captures, close() { clearTimeout(timer); abort(); connector.close(); } };
}

globalThis.addEventListener('message', ((event: MessageEvent) => {
  const value = event.data;
  if (value?.type === 'stop') { detach?.(); active?.close(); active = undefined; globalThis.postMessage({ kind: 'stopped' }); return; }
  if (value?.type === 'report') {
    try {
      if (!active) throw new Error('No active demonstration');
      globalThis.postMessage({ kind: 'report', report: validateDelegation(active.runtime, active.application, value.rootThreadId), calls: active.application.calls });
    } catch (error) { globalThis.postMessage({ kind: 'report-error', error: String(error) }); }
    return;
  }
  if (!value?.port) return;
  try {
    if (active) throw new Error('A demonstration is already active');
    active = createDelegationRuntime(String(value.url), value.rows, (message) => globalThis.postMessage(message));
    detach = servePort(active.runtime, value.port as Port);
  } catch (error) { globalThis.postMessage({ kind: 'worker-error', error: String(error) }); }
}) as EventListener);

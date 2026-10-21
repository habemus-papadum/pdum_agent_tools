import * as content from '@habemus-papadum/aiui-prompts';
import * as operations from '@habemus-papadum/aiui-prompts/operations';
import { bindPrompts, createFidelityAdapter, prepareRequest, recordRequest, type Json, type JsonObject, type TextInput } from '../041-hp-codex-fidelity/src/core.ts';
import { DirectResponsesConnector } from '../038-hp-sdk-fit/src/direct.ts';
import type { NativeItem, ResponsesConnectionFactory } from '../038-hp-sdk-fit/src/connector.ts';
import { AgentRuntime } from '../039-hp-agent-runtime/src/runtime.ts';
import { browserConnectionFactory } from '../039-hp-agent-runtime/src/browser-connection.ts';
import { FixtureConnector, echoTool } from '../039-hp-agent-runtime/src/fixture.ts';
import { servePort, type Port } from '../039-hp-agent-runtime/src/protocol.ts';

declare const __HP_NATIVE__: { instructions: TextInput; codex: unknown; aiui: unknown; model: string };
const prompts = bindPrompts(content, operations);
export interface BrowserCapture {
  kind: 'prepared-not-sent' | 'socket-send';
  operation: ReturnType<typeof recordRequest>;
  prepared: ReturnType<typeof prepareRequest>;
  wire?: ReturnType<typeof prompts.captureWire>;
  verified?: boolean;
}
export interface BrowserOptions {
  live?: boolean;
  url?: string;
  /** Offline failure-injection seam used by build-browser --test; never supplies credentials. */
  factory?: ResponsesConnectionFactory;
  onEvidence?: (event: unknown) => void;
}

/** Actual Worker runtime with prompt preparation at the browser transport boundary. */
export function createBrowserRuntime(options: BrowserOptions = {}) {
  const captures: BrowserCapture[] = [];
  const publish = (capture: BrowserCapture) => {
    captures.push(capture);
    options.onEvidence?.({ kind: 'capture', capture });
  };
  const prepare = (event: NativeItem) => {
    const { type: _type, model, instructions, input, tools, ...fields } = event;
    if (instructions !== __HP_NATIVE__.instructions.text) throw new Error('Runtime prompt differs from imported native source');
    if (model !== 'gpt-6-luna') throw new Error('This bounded experiment uses gpt-6-luna');
    const operation = recordRequest(prompts, {
      instructions: __HP_NATIVE__.instructions,
      model: String(model), input: input as Json[], tools: tools as Json[], fields: fields as JsonObject,
      layout: 'responses',
    });
    const prepared = prepareRequest(prompts, operation);
    if (content.canonicalJson(prepared.payload) !== content.canonicalJson(event)) throw new Error('Fidelity adapter changed the runtime request');
    return { operation, prepared };
  };
  const factory = options.factory ?? (options.url ? browserConnectionFactory(options.url) : undefined);
  if (options.live && !factory) throw new Error('A WebSocket URL is required for live mode');
  const direct = options.live ? new DirectResponsesConnector(async (signal) => {
    const connection = await factory!(signal);
    return {
      close: () => connection.close(),
      events: connection.events,
      send(event) {
        if (event.type !== 'response.create') { connection.send(event); return; }
        const { operation, prepared } = prepare(event);
        // The real browser factory serializes this exact JSON value into socket.send.
        const payload = JSON.parse(JSON.stringify(prepared.payload));
        connection.send(payload);
        const wire = prompts.captureWire(prepared, payload, { capturedAt: new Date().toISOString(), transportId: 'browser-websocket-send' });
        const verified = prompts.verifyWire(operation, wire, [createFidelityAdapter()]).equal;
        if (!verified) throw new Error('Sent request failed semantic replay verification');
        publish({ kind: 'socket-send', operation, prepared, wire, verified });
      },
    };
  }, { max_output_tokens: 512, reasoning: { effort: 'none' }, service_tier: 'default' }) : undefined;
  const runtime = new AgentRuntime({
    connector: direct ?? new FixtureConnector(), model: 'gpt-6-luna',
    instructions: __HP_NATIVE__.instructions.text, tools: [echoTool],
    ...(!options.live ? { beforeModel(args: { model: string; instructions: string; input: NativeItem[]; tools: NativeItem[] }) {
      const operation = recordRequest(prompts, { instructions: __HP_NATIVE__.instructions, model: args.model, input: args.input as Json[], tools: args.tools as Json[], layout: 'responses' });
      publish({ kind: 'prepared-not-sent', operation, prepared: prepareRequest(prompts, operation) });
    } } : {}),
  });
  options.onEvidence?.({ kind: 'provenance', codex: __HP_NATIVE__.codex, aiui: __HP_NATIVE__.aiui,
    instructionUtf16: __HP_NATIVE__.instructions.text.length, live: options.live === true,
    framing: 'Public Responses translation; not native Responses Lite parity' });
  return { runtime, captures, close: () => direct?.close() };
}

let running: ReturnType<typeof createBrowserRuntime> | undefined;
let detach: (() => void) | undefined;
// This guard lets the exact Worker implementation participate in credential-free Node bundle tests.
if (typeof globalThis.addEventListener === 'function' && typeof document === 'undefined') {
  globalThis.addEventListener('message', ((event: MessageEvent) => {
    if (event.data?.type === 'stop') {
      detach?.(); running?.close(); running = undefined;
      globalThis.postMessage({ kind: 'stopped' }); return;
    }
    if (!event.data?.port) return;
    try {
      const { port, live, url } = event.data as { port: Port; live?: boolean; url?: string };
      running = createBrowserRuntime({ live: live === true, ...(url ? { url } : {}), onEvidence: (value) => globalThis.postMessage(value) });
      detach = servePort(running.runtime, port);
    } catch (error) { globalThis.postMessage({ kind: 'worker-error', error: String(error) }); }
  }) as EventListener);
}

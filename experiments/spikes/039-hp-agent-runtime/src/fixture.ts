import type { ModelConnector, ModelEvent, ModelRunArgs } from '../../038-hp-sdk-fit/src/connector.ts';
import type { Tool } from './runtime.ts';

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
});

/** Deterministic provider simulator. Proves runtime mechanics, never model/API compatibility. */
export class FixtureConnector implements ModelConnector {
  calls = 0;
  run(args: ModelRunArgs) {
    this.calls += 1; const steers: string[] = []; const responseId = `fixture-${this.calls}`;
    const events = async function* (): AsyncGenerator<ModelEvent> {
      yield { type: 'raw', event: { type: 'response.created', response: { id: responseId } } };
      const last = args.input.at(-1);
      const text = JSON.stringify(last);
      if (last?.type !== 'function_call_output' && text.includes('tool')) {
        const id = crypto.randomUUID();
        const item = { type: 'function_call', call_id: id, name: 'echo', arguments: JSON.stringify({ text: 'host tool result' }) };
        yield { type: 'outputItem', item };
        yield { type: 'toolCall', id, name: 'echo', arguments: item.arguments, kind: 'function' };
      } else {
        const itemId = crypto.randomUUID();
        yield { type: 'textDelta', itemId, delta: 'Working. ' };
        await pause(40, args.signal);
        for (const steer of steers) {
          yield { type: 'steering', state: 'committed', responseId, detail: { input: steer } };
          yield { type: 'inputItem', item: { role: 'user', content: steer } };
        }
        const answer = steers.length ? `Steered: ${steers.join('; ')}` : 'Done.';
        yield { type: 'textDelta', itemId, delta: answer };
        yield { type: 'outputItem', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Working. ${answer}` }] } };
      }
      yield { type: 'completed', responseId };
    };
    return { events: events(), steer: async (input: string) => { steers.push(input); } };
  }
}
export const echoTool: Tool = {
  definition: { type: 'function', name: 'echo', description: 'Echo text from the host application.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, strict: true },
  async execute(text) { return JSON.parse(text).text; },
};

export { agentTools, agentControlTools } from './tools/agent-tools.ts';

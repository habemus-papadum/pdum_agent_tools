import { AgentRuntime } from '../../039-hp-agent-runtime/src/runtime.ts';
import { echoTool } from '../../039-hp-agent-runtime/src/fixture.ts';
import type { ModelConnector, ModelEvent, ModelRunArgs } from '../../038-hp-sdk-fit/src/connector.ts';
import { captureArchive } from './archive.ts';
import { resumeArchive } from './runtime-restore.ts';

/** Scripted usage for local accounting checks, never evidence of provider execution. */
export function accountingConnector(): ModelConnector {
  return { run: (args: ModelRunArgs) => ({ events: (async function* (): AsyncGenerator<ModelEvent> {
    const responseId = crypto.randomUUID();
    yield { type: 'raw', event: { type: 'response.created', response: { id: responseId } } };
    const last = args.input.at(-1);
    if (last?.type !== 'function_call_output' && JSON.stringify(last).includes('call_echo')) {
      const id = crypto.randomUUID(), input = JSON.stringify({ text: 'real local tool output' });
      yield { type: 'outputItem', item: { type: 'function_call', call_id: id, name: 'echo', arguments: input } };
      yield { type: 'toolCall', id, name: 'echo', arguments: input, kind: 'function' };
    } else yield { type: 'outputItem', item: { type: 'message', id: crypto.randomUUID(), role: 'assistant',
      content: [{ type: 'output_text', text: 'Completed local accounting scenario.' }] } };
    yield { type: 'usage', responseId, model: args.model, inputTokens: 100, cachedInputTokens: 60,
      cacheWriteTokens: 10, outputTokens: 12 };
    yield { type: 'completed', responseId };
  })(), steer: async () => {} }) };
}

export async function createAccountingFixture() {
  const runtime = new AgentRuntime({ connector: accountingConnector(), tools: [echoTool], model: 'gpt-6-luna' });
  const parent = runtime.create();
  runtime.start(parent.id, 'call_echo'); await runtime.wait(parent.id);
  const child = runtime.spawn(parent.id, 'independent child'); await runtime.wait(child.threadId);
  const fork = runtime.fork(parent.id); runtime.start(fork.id, 'new fork input'); await runtime.wait(fork.id);
  const compact = { ...structuredClone(runtime.usages[0]!), originRunId: runtime.runId, turnId: null,
    afterTurnId: runtime.read(parent.id).turns.at(-1)!.id, endpoint: 'responses.compact' as const,
    disposition: 'discarded' as const };
  compact.usage.responseId = crypto.randomUUID();
  const before = captureArchive(runtime, { sourceId: 'spike-070-accounting-local', extraUsages: [compact] });
  runtime.dispose();
  const resumed = resumeArchive(before, parent.id, { connector: accountingConnector(), tools: [echoTool] });
  try {
    resumed.runtime.start(parent.id, 'continued after restore'); await resumed.runtime.wait(parent.id);
    return captureArchive(resumed.runtime, { previous: before });
  } finally { resumed.runtime.dispose(); }
}

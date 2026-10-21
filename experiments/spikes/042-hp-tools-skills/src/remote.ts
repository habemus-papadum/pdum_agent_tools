import type { Tool } from '../../039-hp-agent-runtime/src/runtime.ts';
export { createMcpTools, connectHttpMcp } from './mcp.ts';

/** Browser/application boundary. The host owns transport, execution, credentials and cancellation. */
export function createRemoteTools(definitions: Tool['definition'][], invoke: (call: { name: string; argumentsText: string; signal: AbortSignal }) => Promise<string>): Tool[] {
  return definitions.map((definition) => ({
    definition: structuredClone(definition),
    execute(argumentsText, context) {
      context.signal.throwIfAborted();
      return invoke({ name: String(definition.name), argumentsText, signal: context.signal });
    },
  }));
}

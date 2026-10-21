import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '../../039-hp-agent-runtime/src/runtime.ts';

export class McpToolFailure extends Error {
  constructor(readonly result: unknown) { super(JSON.stringify(result)); this.name = 'McpToolFailure'; }
  override toString() { return this.message; }
}
/** Portable adapter: the host supplies an official connected MCP Client and owns its lifetime. */
export async function createMcpTools(client: Pick<Client, 'listTools' | 'callTool'>, options: { serverName: string; signal?: AbortSignal }): Promise<Tool[]> {
  const result: Tool[] = []; const names = new Set<string>(); let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, options.signal ? { signal: options.signal } : {});
    for (const tool of page.tools) {
      const name = `mcp__${options.serverName}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      if (names.has(name)) throw new Error(`MCP generated name collision: ${name}`);
      names.add(name);
      result.push({
        definition: { type: 'function', name, description: tool.description ?? `MCP ${options.serverName}:${tool.name}`,
          parameters: structuredClone(tool.inputSchema), strict: false },
        async execute(text, context) {
          const parameters = JSON.parse(text) as Record<string, unknown>;
          const response = await client.callTool({ name: tool.name, arguments: parameters }, undefined, { signal: context.signal });
          if (response.isError) throw new McpToolFailure(response);
          // Preserve all content blocks, structuredContent, metadata and provider extension fields.
          return JSON.stringify(response);
        },
      });
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('MCP repeated pagination cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result;
}
/** Browser-compatible HTTP MCP connection. Headers/auth are supplied explicitly by the application. */
export async function connectHttpMcp(url: string, options: { signal?: AbortSignal; requestInit?: RequestInit } = {}) {
  const client = new Client({ name: 'hp-tools-spike-042', version: '0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(options.requestInit ? { requestInit: options.requestInit } : {}),
  });
  try {
    // SDK 1.32.1's concrete transport accessors declare undefined where its Transport
    // interface uses optional properties; reconcile that SDK-only declaration mismatch.
    await client.connect(transport as Parameters<Client['connect']>[0], options.signal ? { signal: options.signal } : {});
    return { client, close: () => client.close() };
  } catch (error) { await transport.close(); throw error; }
}

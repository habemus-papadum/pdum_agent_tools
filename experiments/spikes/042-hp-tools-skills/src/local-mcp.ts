import { createServer } from 'node:http';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Disposable actual HTTP MCP service, not a model response fixture. No auth or external network. */
export async function startLocalMcpServer() {
  const server = new Server({ name: 'hp-local-042', version: '0' }, { capabilities: { tools: {} } });
  const calls: { name: string; arguments: unknown }[] = []; let httpRequests = 0;
  const schema = { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'echo', description: 'Return text and structured content.', inputSchema: schema },
    { name: 'fail', description: 'Return a real MCP tool error.', inputSchema: { type: 'object' } },
    { name: 'wait', description: 'Wait until the request is cancelled.', inputSchema: { type: 'object' } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    calls.push({ name: request.params.name, arguments: request.params.arguments });
    if (request.params.name === 'fail') return { content: [{ type: 'text', text: 'deliberate server failure' }], isError: true };
    if (request.params.name === 'wait') {
      await new Promise<void>((resolve) => { extra.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { content: [{ type: 'text', text: 'cancelled' }], isError: true };
    }
    if (request.params.name !== 'echo') throw new Error('Unknown MCP tool');
    const text = String(request.params.arguments?.text);
    return { content: [{ type: 'text', text }, { type: 'resource', resource: { uri: 'memory://hp/echo', mimeType: 'text/plain', text } }], structuredContent: { text, source: 'local-mcp-server' } };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  // The SDK's concrete accessor types differ from its Transport optional properties.
  await server.connect(transport as Parameters<Server['connect']>[0]);
  const http = createServer((request, response) => {
    httpRequests++;
    void transport.handleRequest(request, response).catch((error) => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); });
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No TCP address');
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls, requests: () => httpRequests,
    async close() { await server.close(); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); } };
}

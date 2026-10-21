/** Verify the SDK's public manual-compaction adapter against a local HTTP peer. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { MemorySession, OpenAIResponsesCompactionSession } from '@openai/agents';
import OpenAI from 'openai';
let request: Record<string, unknown> | undefined;
let path: string | undefined;
const server = createServer(async (incoming, outgoing) => {
  path = incoming.url;
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  request = JSON.parse(Buffer.concat(chunks).toString());
  outgoing.setHeader('content-type', 'application/json');
  outgoing.end(JSON.stringify({ id: 'compact_fixture', object: 'response.compaction', created_at: 1, output: [{ type: 'compaction', id: 'compaction_fixture', encrypted_content: 'fixture-opaque-not-real', created_by: 'model' }], usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24, input_tokens_details: { cached_tokens: 0 } } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
try {
  const underlying = new MemorySession();
  await underlying.addItems([{ role: 'user', content: 'preserved history in external transcript' }, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'verbose reply' }] }]);
  const session = new OpenAIResponsesCompactionSession({ client: new OpenAI({ apiKey: 'local-only', baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 }), model: 'gpt-6-luna', underlyingSession: underlying, compactionMode: 'input', shouldTriggerCompaction: () => false });
  const result = await session.runCompaction({ force: true });
  assert.equal(path, '/v1/responses/compact');
  assert.equal(request?.model, 'gpt-6-luna');
  assert.equal((request?.input as unknown[]).length, 2);
  const items = await underlying.getItems();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.type, 'compaction');
  const summary = { evidence: 'Real SDK public manual-compaction API against a local scripted HTTP endpoint; no model compression validated', passed: true, requestPath: path, retainedItems: items.length, usage: result?.usage, implication: 'Compaction replaces the model-context store. Preserve a separate immutable transcript.' };
  const directory = new URL('../../../artifacts/038-hp-sdk-fit/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('compaction-local-summary.json', directory), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }

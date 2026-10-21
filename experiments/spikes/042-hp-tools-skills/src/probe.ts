import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeTools, createSkillContext } from './index.ts';
import { connectHttpMcp, createMcpTools } from './mcp.ts';
import { startLocalMcpServer } from './local-mcp.ts';
import type { Tool } from '../../039-hp-agent-runtime/src/runtime.ts';

const root = await mkdtemp(join(tmpdir(), 'hp-tools-probe-'));
const tools = createNodeTools({ cwd: root });
const context = { signal: AbortSignal.timeout(10000) } as Parameters<Tool['execute']>[1];
const invoke = (name: string, argumentsText: string) => tools.find((tool) => tool.definition.name === name)!.execute(argumentsText, context);
const result: Record<string, unknown> = { date: new Date().toISOString(), node: process.version, mcpSdk: '1.32.1', providerRequests: 0, estimatedUsd: 0 };
try {
  result.patch = JSON.parse(await invoke('apply_patch', '*** Begin Patch\n*** Add File: message.txt\n+HP tool probe 🧪\n*** End Patch'));
  result.exec = JSON.parse(await invoke('exec_command', JSON.stringify({ cmd: 'cat message.txt; exit 3', login: false })));
  assert.equal((result.exec as { exit_code: number }).exit_code, 3);
  await mkdir(join(root, 'skills/example'), { recursive: true });
  await writeFile(join(root, 'skills/example/SKILL.md'), '---\nname: example\ndescription: A local source-provenance probe.\n---\nExact skill body.\n');
  const skills = await createSkillContext({ roots: [join(root, 'skills')] });
  result.skills = { catalog: skills.catalog, loaded: await skills.load('example') };
  const service = await startLocalMcpServer();
  const connection = await connectHttpMcp(service.url);
  try {
    const adapters = await createMcpTools(connection.client, { serverName: 'probe' });
    const output = JSON.parse(await adapters.find((tool) => tool.definition.name === 'mcp__probe__echo')!.execute('{"text":"HP MCP probe"}', context));
    assert.equal(output.structuredContent.text, 'HP MCP probe');
    result.mcp = { transport: 'actual local HTTP / official SDK', calls: service.calls, httpRequests: service.requests(), output };
  } finally { await connection.close(); await service.close(); }
} finally {
  await tools.close(); await rm(root, { recursive: true, force: true });
}
const directory = fileURLToPath(new URL('../../../artifacts/042-hp-tools-skills/', import.meta.url));
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'local-summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AgentRuntime } from '../039-hp-agent-runtime/src/runtime.ts';
import { historyRows } from '../039-hp-agent-runtime/src/history.ts';
import { createNodeTools, createSkillContext, createSkillTools } from '../042-hp-tools-skills/src/index.ts';
import { modelHost } from './model-host.mjs';

// Research CLI. The eval preparation command owns the scratch project and manifest.
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--run-dir', 'Usage: cli.mjs --run-dir PREPARED_RUN_DIRECTORY');
const directory = resolve(args[1]);
const manifest = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
assert(manifest.agent === 'hp' && manifest.config.model === 'gpt-6-luna');
assert(!manifest.started_at, 'Use a fresh prepared run; never silently overwrite a measured run');
const cwd = resolve(manifest.worktree);
const skillContext = await createSkillContext({ roots: [join(cwd, '.agents/skills')] });
const agents = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
const suffix = `\n\n# Host environment\nWorking directory: ${cwd}\nReasoning effort: low.\n\n# Workspace instructions\n${agents}\n\n# Available skills\n${skillContext.renderCatalog()}\nLoad the relevant skill before applying its instructions.\n`;
const host = await modelHost({ suffix, maxRequests: 20, maxOutputTokens: 2048, effort: 'low', timeoutMs: 180000 });
const tools = createNodeTools({ cwd });
const runtime = new AgentRuntime({ connector: host.connector, instructions: host.instructions, tools: [...tools, ...createSkillTools(skillContext)] });
runtime.subscribe(event => appendFileSync(join(directory, 'events.jsonl'), JSON.stringify(event) + '\n'));
const thread = runtime.create({ cwd });
const start = performance.now();
manifest.started_at = new Date().toISOString(); manifest.root_thread_id = thread.id;
manifest.execution = 'one live HP task; scratch workspace; no automatic retries';
await writeFile(join(directory, 'run.json'), JSON.stringify(manifest, null, 2));
const abort = () => { try { const t = runtime.read(thread.id).turns.at(-1); if (t?.status === 'inProgress') runtime.interrupt(thread.id, t.id); } catch {} };
host.signal.addEventListener('abort', abort, { once: true });
let turn;
let failure;
try {
  runtime.start(thread.id, await readFile(join(directory, 'prompt.txt'), 'utf8'));
  turn = await runtime.wait(thread.id);
  if (turn.status !== 'completed') failure = JSON.stringify(turn.error);
} catch (error) { failure = String(error); }
finally {
  host.signal.removeEventListener('abort', abort);
  host.close(); await tools.close();
  manifest.seconds = (performance.now() - start) / 1000;
  manifest.completed_at = new Date().toISOString(); manifest.exit_code = failure ? 1 : 0;
  const evidence = host.evidence();
  const answer = turn?.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n') ?? '';
  await Promise.all([
    writeFile(join(directory, 'run.json'), JSON.stringify(manifest, null, 2)),
    writeFile(join(directory, 'journal.json'), JSON.stringify(runtime.journal)),
    writeFile(join(directory, 'history-rows.json'), JSON.stringify(historyRows(runtime))),
    writeFile(join(directory, 'wire.json'), JSON.stringify(evidence.wire)),
    writeFile(join(directory, 'prompts.json'), JSON.stringify(evidence.captures)),
    writeFile(join(directory, 'probe-ledger.json'), JSON.stringify(evidence.ledger, null, 2)),
    writeFile(join(directory, 'answer.txt'), answer),
    writeFile(join(directory, 'execution.json'), JSON.stringify({ status: turn?.status, failure, ...evidence.ledger }, null, 2)),
  ]);
  console.log(JSON.stringify({ runId: manifest.run_id, status: turn?.status, failure, seconds: manifest.seconds,
    requests: evidence.ledger.requests, estimatedUsd: evidence.ledger.estimatedUsd, directory }, null, 2));
}
process.exitCode = failure ? 1 : 0;

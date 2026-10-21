import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../039-hp-agent-runtime/src/runtime.ts';
import { historyRows } from '../039-hp-agent-runtime/src/history.ts';
import { createNodeTools } from '../042-hp-tools-skills/src/index.ts';

test('real command failure projects stdout bytes and exit status into evaluation history', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'hp-history-'));
  const tools = createNodeTools({ cwd });
  let calls = 0;
  const connector = { run() {
    const first = ++calls === 1;
    return { steer: async () => {}, events: (async function* () {
      if (first) {
        const item = { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: JSON.stringify({ cmd: "printf 'π'; exit 7", login: false }) };
        yield { type: 'outputItem', item };
        yield { type: 'toolCall', id: 'c', name: item.name, arguments: item.arguments, kind: 'function' };
      }
      yield { type: 'completed', responseId: `fixture-${calls}` };
    })() };
  } };
  try {
    const runtime = new AgentRuntime({ connector, tools });
    const thread = runtime.create({ cwd }); runtime.start(thread.id, 'Run command'); await runtime.wait(thread.id);
    runtime.fork(thread.id);
    const rows = historyRows(runtime);
    const items = rows.tables.items.filter(x => x.item_type === 'commandExecution');
    assert.equal(items.length, 2);
    assert.equal(items[0].exit_code, 7);
    assert.equal(items[0].output_bytes, 2);
    assert.equal(items[0].command, "printf 'π'; exit 7");
    assert.equal(items[1].origin, 'copied-context');
    assert.equal(rows.tables.responses.length, 0); // Scripted model does not invent usage.
  } finally { await tools.close(); await rm(cwd, { recursive: true, force: true }); }
});

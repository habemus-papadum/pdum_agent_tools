import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AgentRuntime } from '../039-hp-agent-runtime/src/runtime.ts';
import { historyRows } from '../039-hp-agent-runtime/src/history.ts';
import { modelHost } from './model-host.mjs';
import { APPLICATION_SUFFIX, DELEGATION_PROMPT, createStockApplication, validateDelegation } from './application.ts';

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--out-dir', 'Usage: delegate.mjs --out-dir FRESH_RUN_DIRECTORY');
const directory = resolve(args[1]);
await mkdir(dirname(directory), { recursive: true }); await mkdir(directory);
const host = await modelHost({ suffix: APPLICATION_SUFFIX, maxRequests: 12, timeoutMs: 120000, maxOutputTokens: 512, effort: 'none' });
const application = createStockApplication();
const runtime = new AgentRuntime({ connector: host.connector, model: 'gpt-6-luna', instructions: host.instructions, tools: application.tools });
const parent = runtime.create(); const started = performance.now();
const abort = () => {
  for (const thread of runtime.list()) {
    const turn = runtime.read(thread.id).turns.at(-1);
    if (turn?.status === 'inProgress') runtime.interrupt(thread.id, turn.id);
  }
};
host.signal.addEventListener('abort', abort, { once: true });
let report, failure;
try {
  runtime.start(parent.id, DELEGATION_PROMPT);
  await runtime.wait(parent.id);
  report = validateDelegation(runtime, application, parent.id);
} catch (error) { failure = String(error); }
finally {
  abort(); host.signal.removeEventListener('abort', abort); host.close();
  const evidence = host.evidence();
  const result = { ok: !failure, report, failure, seconds: (performance.now() - started) / 1000,
    model: 'gpt-6-luna', effort: 'none', directory, estimatedUsd: evidence.ledger.estimatedUsd,
    requests: evidence.ledger.requests, usageCoverage: evidence.ledger.usageCoverage };
  await Promise.all([
    writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)),
    writeFile(join(directory, 'application.json'), JSON.stringify({ rows: application.rows, calls: application.calls, annotation: application.annotation }, null, 2)),
    writeFile(join(directory, 'journal.json'), JSON.stringify(runtime.journal)),
    writeFile(join(directory, 'history-rows.json'), JSON.stringify(historyRows(runtime))),
    writeFile(join(directory, 'wire.json'), JSON.stringify(evidence.wire)),
    writeFile(join(directory, 'prompts.json'), JSON.stringify(evidence.captures)),
    writeFile(join(directory, 'probe-ledger.json'), JSON.stringify(evidence.ledger, null, 2)),
  ]);
  console.log(JSON.stringify(result, null, 2));
}
process.exitCode = failure ? 1 : 0;

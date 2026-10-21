import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../039-hp-agent-runtime/src/runtime.ts';
import { agentControlTools } from '../039-hp-agent-runtime/src/tools/agent-tools.ts';
import { modelHost } from '../045-hp-behavior/model-host.mjs';

assert(process.argv.includes('--live'), 'Explicit --live required; up to six short Luna responses');
const directory = fileURLToPath(new URL(`../../artifacts/049-hp-control-integration/live-${Date.now()}/`, import.meta.url));
await mkdir(directory, { recursive: true });
const host = await modelHost({ maxRequests: 6, maxOutputTokens: 512, timeoutMs: 120000, effort: 'none',
  suffix: '\n\n# Host control qualification\nWhen explicitly asked, call wait_agent exactly once with timeout_ms 30000. After it returns, obey the newest user guidance or queued agent note and answer only the requested short marker. Do not repeat the wait.\n' });
const runtime = new AgentRuntime({ connector: host.connector, instructions: host.instructions,
  tools: agentControlTools.filter(t => t.definition.name === 'wait_agent') });
const cases = [];
let failure;
const signalAbort = () => {
  for (const thread of runtime.list()) { const turn = runtime.read(thread.id).turns.at(-1); if (turn?.status === 'inProgress') runtime.interrupt(thread.id, turn.id); }
};
host.signal.addEventListener('abort', signalAbort, { once: true });
const answer = turn => turn.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n');
try {
  for (const mode of ['mailbox', 'steering', 'interrupt']) {
    const parent = runtime.create();
    const sender = runtime.create({ parentThreadId: parent.id }); // Host-controlled sender; no child inference in this probe.
    let dispatched = false;
    let deliveryError;
    let delivery;
    const stop = runtime.subscribe(event => {
      if (event.method !== 'item/started' || event.params.threadId !== parent.id || event.params.item.tool !== 'wait_agent' || dispatched) return;
      dispatched = true;
      // Exercise an already-entered asynchronous wait, not only admission-before-wait.
      delivery = new Promise(resolve => setTimeout(resolve, 0)).then(async () => {
        if (mode === 'mailbox') runtime.sendMessage(sender.id, parent.id, 'Reply with exactly MAIL_OK.');
        else if (mode === 'steering') await runtime.steer(parent.id, event.params.turnId, 'Reply with exactly STEER_OK.');
        else runtime.interrupt(parent.id, event.params.turnId);
      }).catch(error => { deliveryError = String(error); });
    });
    try {
      runtime.start(parent.id, 'Call wait_agent once with timeout_ms 30000, then follow the new host guidance.');
      const turn = await runtime.wait(parent.id);
      await delivery;
      assert(dispatched, 'Model did not call the real wait tool');
      assert(!deliveryError, deliveryError);
      if (mode !== 'interrupt') {
        assert.equal(turn.status, 'completed');
        assert(answer(turn).includes(mode === 'mailbox' ? 'MAIL_OK' : 'STEER_OK'));
        cases.push({ mode, passed: true, status: turn.status, answer: answer(turn), inputs: runtime.inspectInputs(parent.id) });
      } else {
        assert.equal(turn.status, 'interrupted');
        assert(runtime.context(parent.id).some(x => x.type === 'function_call_output' && String(x.output).includes('INTERRUPTED')));
        runtime.start(parent.id, 'Do not call tools. Reply with exactly RECOVERED.');
        const next = await runtime.wait(parent.id);
        assert.equal(next.status, 'completed'); assert(answer(next).includes('RECOVERED'));
        cases.push({ mode, passed: true, interrupted: turn.status, continuation: next.status, answer: answer(next) });
      }
    } finally { stop(); }
  }
} catch (error) { failure = String(error); }
finally {
  signalAbort(); host.signal.removeEventListener('abort', signalAbort); host.close();
  const evidence = host.evidence();
  const report = { passed: !failure, failure, cases, ledger: evidence.ledger, promptRequests: evidence.captures.length,
    limits: 'Node live only; child-sender message is host-injected. Actual model-selected child delegation was separately tested in045.' };
  await Promise.all([
    writeFile(`${directory}result.json`, JSON.stringify(report, null, 2)),
    writeFile(`${directory}wire.json`, JSON.stringify(evidence.wire)),
    writeFile(`${directory}prompts.json`, JSON.stringify(evidence.captures)),
    writeFile(`${directory}journal.json`, JSON.stringify(runtime.journal)),
  ]);
  console.log(JSON.stringify({ passed: !failure, failure, cases: cases.map(({ inputs, ...result }) => result),
    estimatedUsd: evidence.ledger.estimatedUsd, responses: evidence.ledger.responses.length, directory }, null, 2));
}
if (failure) process.exitCode = 1;

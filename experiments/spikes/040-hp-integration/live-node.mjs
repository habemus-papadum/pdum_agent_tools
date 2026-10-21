import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { AgentRuntime } from '../039-hp-agent-runtime/src/runtime.ts';
import { echoTool } from '../039-hp-agent-runtime/src/fixture.ts';
import { PortClient, servePort } from '../039-hp-agent-runtime/src/protocol.ts';
import { runDemo } from '../039-hp-agent-runtime/src/demo.ts';
import { historyRows } from '../039-hp-agent-runtime/src/history.ts';
import { DirectResponsesConnector } from '../038-hp-sdk-fit/src/direct.ts';
import { officialConnectionFactory } from '../038-hp-sdk-fit/src/official-connection.ts';
import { loadPrompts, loadNativeInputs } from '../041-hp-codex-fidelity/src/local.ts';
import { createFidelityAdapter, recordRequest, prepareRequest } from '../041-hp-codex-fidelity/src/core.ts';

assert(process.argv.includes('--live'), 'Pass --live explicitly: up to 12 client requests, Luna only');
assert(process.env.OPENAI_API_KEY, 'Supply OPENAI_API_KEY through the host environment');
const directory = fileURLToPath(new URL(`../../artifacts/040-hp-integration/node-${Date.now()}/`, import.meta.url));
await mkdir(directory, { recursive: true });
const { prompts, provenance } = await loadPrompts();
const native = await loadNativeInputs();
const preparedRequests = [];
const raw = [];
const responses = new Map();
let creates = 0;
let createdResponses = 0;
const deadline = AbortSignal.timeout(120_000);
const factory = officialConnectionFactory(() => new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 30_000 }));
const connector = new DirectResponsesConnector(async (signal) => {
  const connection = await factory(AbortSignal.any([signal, deadline]));
  return {
    close: () => connection.close(),
    send(event) {
      raw.push({ direction: 'client', ts: new Date().toISOString(), event });
      if (event.type === 'response.create') {
        assert(++creates <= 12, 'Experiment request bound');
        assert.equal(event.model, 'gpt-6-luna');
        const { type, model, instructions, input, tools, ...fields } = event;
        assert.equal(instructions, native.instructions.text);
        const operation = recordRequest(prompts, { instructions: native.instructions, model, input, tools, fields, layout: 'responses' });
        const prepared = prepareRequest(prompts, operation);
        assert.deepEqual(prepared.payload, event);
        connection.send(prepared.payload);
        const wire = prompts.captureWire(prepared, prepared.payload, { capturedAt: new Date().toISOString() });
        const verified = prompts.verifyWire(operation, wire, [createFidelityAdapter()]);
        assert.equal(verified.equal, true);
        preparedRequests.push({ operation, prepared, wire, verified });
      } else connection.send(event);
    },
    events: (async function* () {
      for await (const event of connection.events) {
        raw.push({ direction: 'server', ts: new Date().toISOString(), event });
        if (event.type === 'response.created') assert(++createdResponses <= 24, 'Experiment response bound');
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
          const r = event.response; const u = r.usage;
          if (u) {
            const input = u.input_tokens, output = u.output_tokens;
            const cached = u.input_tokens_details?.cached_tokens ?? 0;
            const writes = u.input_tokens_details?.cache_write_tokens ?? 0;
            assert.equal(r.model, 'gpt-6-luna');
            assert(input <= 272000 && cached + writes <= input && output <= 512);
            assert.equal(r.service_tier, 'default');
            responses.set(r.id, { responseId: r.id, status: r.status, input, cached, writes, output,
              estimatedUsd: ((input - cached - writes) * 0.10 + cached * 0.01 + writes * 0.125 + output * 0.50) / 1e6 });
          }
        }
        yield event;
      }
    })(),
  };
}, { max_output_tokens: 512, reasoning: { effort: 'none' }, service_tier: 'default' });
const runtime = new AgentRuntime({ connector, instructions: native.instructions.text, tools: [echoTool] });
const channel = new MessageChannel();
const stop = servePort(runtime, channel.port1);
const client = new PortClient(channel.port2);
let result;
let failure;
try {
  result = await runDemo(client, true);
  assert.equal(result.parentUnchanged, true);
  assert(preparedRequests.length > 0);
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  client.close(); stop(); channel.port1.close(); channel.port2.close(); connector.close();
  const ledger = {
    date: new Date().toISOString(), model: 'gpt-6-luna', actualBilledUsd: null,
    pricing: { checkedOn: '2026-10-18', source: 'https://developers.openai.com/api/docs/models/gpt-6-luna', usdPerMillion: { input: .10, cached: .01, writes: .125, output: .50 } },
    bounds: { clientRequests: 12, generatedResponses: 24, maxOutputPerResponse: 512, wallSeconds: 120, maxEstimatedUsd: .10 },
    clientRequests: creates, responsesCreated: createdResponses, responses: [...responses.values()],
    estimatedUsd: [...responses.values()].reduce((sum, r) => sum + r.estimatedUsd, 0),
    usageCoverage: responses.size === createdResponses ? 'all observed responses' : 'incomplete',
  };
  const report = { passed: !failure, failure, result, ledger, promptRequests: preparedRequests.length,
    promptsProvenance: provenance, codexProvenance: native.provenance, node: process.version };
  await Promise.all([
    writeFile(directory + 'result.json', JSON.stringify(report, null, 2)),
    writeFile(directory + 'wire.json', JSON.stringify(raw)),
    writeFile(directory + 'prompts.json', JSON.stringify(preparedRequests)),
    writeFile(directory + 'journal.json', JSON.stringify(runtime.journal)),
    writeFile(directory + 'history-rows.json', JSON.stringify(historyRows(runtime))),
  ]);
  console.log(JSON.stringify({ passed: !failure, failure, result, estimatedUsd: ledger.estimatedUsd, responses: responses.size, promptRequests: preparedRequests.length, directory }, null, 2));
  assert(ledger.estimatedUsd < .10);
}
if (failure) process.exitCode = 1;

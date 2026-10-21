import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { officialConnectionFactory } from '../038-hp-sdk-fit/src/official-connection.ts';
import { DirectResponsesConnector } from '../038-hp-sdk-fit/src/direct.ts';
import { loadPrompts, loadNativeInputs } from '../041-hp-codex-fidelity/src/local.ts';
import { recordRequest, prepareRequest, createFidelityAdapter } from '../041-hp-codex-fidelity/src/core.ts';

/** Experiment host: bounds and credentials belong here, never in the portable agent. */
export async function modelHost({ maxRequests = 20, timeoutMs = 180000, maxOutputTokens = 2048, effort = 'low', suffix = '' } = {}) {
  assert(process.env.OPENAI_API_KEY, 'Supply OPENAI_API_KEY through the host environment');
  const { prompts, provenance } = await loadPrompts();
  const native = await loadNativeInputs();
  const instructions = { ...native.instructions, text: native.instructions.text + suffix,
    origin: { component: 'hp-experiment-instructions', base: native.instructions.origin },
    spans: [{ start: 0, end: native.instructions.text.length, origin: native.instructions.origin },
      ...(suffix ? [{ start: native.instructions.text.length, end: native.instructions.text.length + suffix.length,
        origin: { component: 'host-environment-and-skill-catalog' } }] : [])] };
  const wire = [], captures = [], responses = new Map();
  const limiter = new AbortController();
  const clock = setTimeout(() => limiter.abort(Error('Experiment wall-time bound exceeded')), timeoutMs);
  let requests = 0;
  let created = 0;
  let allModelsMatch = true;
  const factory = officialConnectionFactory(() => new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 60000 }));
  const connector = new DirectResponsesConnector(async (signal) => {
    const connection = await factory(AbortSignal.any([signal, limiter.signal]));
    return {
      close: () => connection.close(),
      send(event) {
        wire.push({ direction: 'client', ts: new Date().toISOString(), event });
        if (event.type !== 'response.create') { connection.send(event); return; }
        assert(++requests <= maxRequests, 'Experiment request bound exceeded');
        assert.equal(event.model, 'gpt-6-luna');
        const { type, model, instructions: text, input, tools, ...fields } = event;
        assert.equal(text, instructions.text);
        const operation = recordRequest(prompts, { instructions, model, input, tools, fields, layout: 'responses' });
        const prepared = prepareRequest(prompts, operation);
        assert.deepEqual(prepared.payload, event);
        connection.send(prepared.payload);
        const sent = prompts.captureWire(prepared, prepared.payload, { capturedAt: new Date().toISOString(), transportId: 'node-responses' });
        const verified = prompts.verifyWire(operation, sent, [createFidelityAdapter()]);
        assert.equal(verified.equal, true);
        captures.push({ operation, prepared, sent, verified });
      },
      events: (async function* () {
        for await (const event of connection.events) {
          wire.push({ direction: 'server', ts: new Date().toISOString(), event });
          if (event.type === 'response.created') created++;
          if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
            const r = event.response;
            if (r.usage) {
              const u = r.usage;
              allModelsMatch &&= r.model === 'gpt-6-luna';
              const input = u.input_tokens, output = u.output_tokens;
              const cached = u.input_tokens_details?.cached_tokens ?? 0;
              const writes = u.input_tokens_details?.cache_write_tokens ?? 0;
              const reasoning = u.output_tokens_details?.reasoning_tokens ?? null;
              const short = input <= 272000;
              const valid = Number.isFinite(input) && Number.isFinite(output) && input >= cached + writes && r.service_tier === 'default';
              const estimate = valid ? ((input - cached - writes) * .10 * (short ? 1 : 2)
                + cached * .01 * (short ? 1 : 2) + writes * .125 * (short ? 1 : 2)
                + output * .50 * (short ? 1 : 1.5)) / 1e6 : null;
              responses.set(r.id, { responseId: r.id, model: r.model, status: r.status, input, cached, writes, output, reasoning,
                serviceTier: r.service_tier, estimatedUsd: estimate });
              if (!valid || !allModelsMatch || [...responses.values()].reduce((sum, x) => sum + (x.estimatedUsd ?? 0), 0) > .10)
                limiter.abort(Error('Experiment usage needs review'));
            }
          }
          yield event;
        }
      })(),
    };
  }, { max_output_tokens: maxOutputTokens, reasoning: { effort }, service_tier: 'default' });
  return {
    connector, instructions: instructions.text, signal: limiter.signal,
    evidence: () => ({ wire, captures, ledger: {
      checkedOn: '2026-10-18', model: 'gpt-6-luna', effort,
      pricingSource: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
      ratesPerMillion: { input: .10, cached: .01, writes: .125, output: .50, longInputMultiplier: 2, longOutputMultiplier: 1.5 },
      bounds: { maxRequests, timeoutMs, maxOutputTokens, estimatedUsd: .10 }, requests, created,
      responses: [...responses.values()], allModelsMatch,
      estimatedUsd: [...responses.values()].reduce((sum, x) => sum + (x.estimatedUsd ?? 0), 0),
      usageCoverage: responses.size === created ? 'all observed responses' : 'incomplete', actualBilledUsd: null,
    }, provenance, codexProvenance: native.provenance }),
    close() { clearTimeout(clock); connector.close(); },
  };
}

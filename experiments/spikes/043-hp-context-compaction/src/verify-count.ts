/** One explicit count-only provider request to verify saved request-shape accounting. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import OpenAI from 'openai';
assert(process.argv.includes('--live'), 'Count-only provider verification requires --live');
const directory = process.argv.find((arg) => arg.startsWith('--directory='))?.slice('--directory='.length);
assert(directory, 'Supply --directory=existing-run-artifact');
assert(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY required');
const captured = JSON.parse(await readFile(resolve(directory, 'raw.json'), 'utf8'));
const saved = JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8'));
const request = captured.requests.find((row: any) => row.event.type === 'response.create').event;
assert.equal(request.model, 'gpt-6-luna');
assert(!request.previous_response_id, 'This check uses full supplied input');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 60_000 });
const count = await client.responses.inputTokens.count({
  model: request.model, input: request.input, instructions: request.instructions,
  tools: request.tools, text: request.text, reasoning: request.reasoning,
}, { signal: AbortSignal.timeout(60_000), maxRetries: 0 });
const reported = saved.ledger.responses.find((row: any) => row.endpoint === 'responses.create').input;
const result = { date: new Date().toISOString(), generatedResponses: 0, countCalls: 1,
  previouslyCountedWithoutOutputFormat: saved.tokenCounts[0].inputTokens,
  countedWithOutputFormat: count.input_tokens, observedResponseInputTokens: reported,
  matches: count.input_tokens === reported, actualBilling: 'unknown' };
await writeFile(resolve(directory, 'count-validation.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
assert(result.matches);

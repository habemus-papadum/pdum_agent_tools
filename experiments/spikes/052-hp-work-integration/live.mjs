import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { modelHost } from '../045-hp-behavior/model-host.mjs';
import { LIVE_SUFFIX, runWorkLive } from './src/live.ts';

assert(process.argv.includes('--live'), 'Explicit --live required; eight short Luna responses maximum');
const directory = fileURLToPath(new URL(`../../artifacts/052-hp-work-integration/live-${Date.now()}/`, import.meta.url));
await mkdir(directory, { recursive: true });
const host = await modelHost({ maxRequests: 8, timeoutMs: 100000, maxOutputTokens: 512, effort: 'none', suffix: LIVE_SUFFIX });
let result;
try { result = await runWorkLive(host.connector, host.instructions, host.signal); }
finally {
  host.close();
  const evidence = host.evidence();
  await Promise.all([
    writeFile(`${directory}result.json`, JSON.stringify(result, null, 2)),
    writeFile(`${directory}ledger.json`, JSON.stringify(evidence.ledger, null, 2)),
    writeFile(`${directory}wire.json`, JSON.stringify(evidence.wire)),
    writeFile(`${directory}prompts.json`, JSON.stringify(evidence.captures)),
  ]);
  console.log(JSON.stringify({ passed: result?.passed, failure: result?.failure, cases: result?.cases,
    responses: evidence.ledger.responses.length, estimatedUsd: evidence.ledger.estimatedUsd, directory }, null, 2));
}
if (!result?.passed) process.exitCode = 1;

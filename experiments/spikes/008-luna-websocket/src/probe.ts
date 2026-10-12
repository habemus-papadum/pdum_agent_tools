import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Data = Record<string, any>;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = "gpt-6-luna";
const argumentsList = process.argv.slice(2);
assert(argumentsList.length === 0 || (argumentsList.length === 2 && argumentsList[0] === "--capture"), "Use no arguments for live mode, or --capture <004-artifact-directory>");
process.umask(0o077);
const artifacts = join(root, "artifacts/008-luna-websocket", `run-${Date.now()}`);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
let capture = argumentsList[1] ? resolve(argumentsList[1]) : undefined;
if (!capture) {
  console.log("One live gpt-6-luna turn; expected API-equivalent cost below $0.01. No model fallback.");
  const result = spawnSync("pnpm", ["--filter", "@agent-spike/004-codex-traffic", "probe", "--live"], {
    cwd: root,
    env: { ...process.env, SPIKE_MODEL: model },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  writeFileSync(join(artifacts, "runner.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }), { mode: 0o600 });
  assert.equal(result.status, 0, "Live runner failed; inspect private runner.json");
  const lastRecord = result.stdout.split("\n").findLast((line) => line.startsWith("{"));
  assert(lastRecord, "Runner did not return its artifact directory");
  capture = String(JSON.parse(lastRecord).artifacts);
}
const summary = JSON.parse(readFileSync(join(capture, "result.json"), "utf8")) as Data;
const stats = JSON.parse(readFileSync(join(capture, "capture-stats.json"), "utf8")) as Data;
const records = readFileSync(join(capture, "level2.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Data);
assert.equal(summary.live, true);
assert.equal(summary.passed, true);
assert.equal(summary.model, model);
assert.equal(summary.sourceAuthUnchanged, true);
assert.equal(summary.level1.dropped, 0);
assert.equal(stats.events_dropped, 0);
const requests = records.filter((entry) => entry.kind === "request" && new URL(entry.url).pathname.endsWith("/responses"));
const flows = new Set(requests.map((entry) => entry.flow_id));
const messages = records.filter((entry) => entry.kind === "websocket" && flows.has(entry.flow_id));
assert(requests.length > 0 && messages.length > 0, "No model WebSocket traffic captured");
assert(requests.every((entry) => entry.method === "GET"), "HTTP inference fallback occurred");
assert(!records.some((entry) => entry.kind === "sse" && flows.has(entry.flow_id)), "SSE inference fallback occurred");
assert(messages.every((entry) => !entry.truncated && entry.body), "Incomplete WebSocket capture");
for (const flow of flows) assert(records.some((entry) => entry.flow_id === flow && entry.kind === "response" && entry.status === 101), "Missing successful WebSocket upgrade");
const pending = new Map<string, Data[]>();
const responseRequests = new Map<string, Data>();
const responses = new Map<string, Data>();
for (const message of messages) {
  const body = message.body as Data;
  if (message.from_client && body.type === "response.create") {
    assert.equal(body.model, model);
    const queue = pending.get(message.flow_id) ?? [];
    queue.push(body);
    pending.set(message.flow_id, queue);
  }
  if (!message.from_client && body.type === "response.created") {
    const request = pending.get(message.flow_id)?.shift();
    assert(request, "Could not correlate response to captured request");
    responseRequests.set(body.response.id, request);
  }
  if (!message.from_client && body.type === "response.completed") responses.set(body.response.id, body.response);
}
assert(responses.size > 0);
const pricing = {
  checkedOn: "2026-10-12",
  source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
  usdPerMillion: { input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50 },
  basis: "Standard short-context API-equivalent estimate, not a subscription bill. Warmup accounting is reported separately.",
};
const usage = [...responses.values()].map((response) => {
  const request = responseRequests.get(response.id);
  assert(request, "Missing response request mapping");
  assert.equal(response.model, model);
  const input = Number(response.usage?.input_tokens);
  const cached = Number(response.usage?.input_tokens_details?.cached_tokens ?? 0);
  const cacheWrite = Number(response.usage?.input_tokens_details?.cache_write_tokens ?? 0);
  const output = Number(response.usage?.output_tokens);
  assert([input, cached, cacheWrite, output].every((value) => Number.isFinite(value) && value >= 0));
  assert(input <= 272_000 && cached + cacheWrite <= input, "Usage requires a different pricing calculation");
  assert(request.generate === false || response.service_tier === "default", "Non-standard generated response tier; update pricing");
  const rates = pricing.usdPerMillion;
  const estimatedUsd = ((input - cached - cacheWrite) * rates.input + cached * rates.cachedInput + cacheWrite * rates.cacheWrite + output * rates.output) / 1_000_000;
  return { responseId: response.id, warmup: request.generate === false, previousResponseId: request.previous_response_id ?? null, serviceTier: response.service_tier, input, cached, cacheWrite, output, estimatedUsd };
});
const generated = usage.filter((entry) => !entry.warmup);
assert.equal(generated.length, 1, "Expected one generated response");
assert(messages.some((entry) => !entry.from_client && entry.body.type === "response.output_text.done" && entry.body.text.trim() === "REGULAR_OK"));
const sumCost = (entries: typeof usage) => entries.reduce((total, entry) => total + entry.estimatedUsd, 0);
const report = {
  passed: true,
  sourceCapture: capture,
  liveCallMadeByThisInvocation: argumentsList.length === 0,
  version: summary.version,
  sourceRevision: summary.sourceRevision,
  model,
  connections: requests.map((entry) => ({ endpoint: entry.url.replace(/^https:/, "wss:"), flowId: entry.flow_id })),
  websocketMessages: messages.length,
  clientMessages: messages.filter((entry) => entry.from_client).length,
  serverMessages: messages.filter((entry) => !entry.from_client).length,
  sseInferenceObserved: false,
  captureBytes: stats.bytes_written,
  captureEventsDropped: stats.events_dropped,
  sourceAuthUnchanged: summary.sourceAuthUnchanged,
  pricing,
  usage,
  generatedEstimatedUsd: sumCost(generated),
  warmupEstimatedUsd: sumCost(usage.filter((entry) => entry.warmup)),
  includingWarmupEstimatedUsd: sumCost(usage),
};
writeFileSync(join(artifacts, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, artifacts }, null, 2));
assert(report.includingWarmupEstimatedUsd < 0.50, "Review spend before any further live calls");

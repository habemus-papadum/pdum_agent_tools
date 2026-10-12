import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Data = Record<string, any>;
export const prices: Record<string, { input: number; cachedInput: number; cacheWrite: number; output: number }> = {
  "gpt-6-luna": { input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50 },
  "gpt-6-sol": { input: 2, cachedInput: 0.20, cacheWrite: 2.50, output: 10 },
};
export function estimateUsd(model: string, input: number, cached: number, cacheWrite: number, output: number): number {
  const rates = prices[model];
  assert(rates, `No price configured for ${model}; no silent model fallback`);
  assert([input, cached, cacheWrite, output].every((value) => Number.isFinite(value) && value >= 0));
  assert(input <= 272_000 && cached + cacheWrite <= input, "Usage requires a different pricing calculation");
  return ((input - cached - cacheWrite) * rates.input + cached * rates.cachedInput + cacheWrite * rates.cacheWrite + output * rates.output) / 1_000_000;
}
export function readJsonLines(path: string): Data[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Data) : [];
}
export function analyzeCapture(directory: string, options = { requireComplete: true }): Data {
  const records = readJsonLines(join(directory, "level2.jsonl"));
  const level1 = readJsonLines(join(directory, "level1.jsonl"));
  const statsPath = join(directory, "capture-stats.json");
  const stats = existsSync(statsPath) ? JSON.parse(readFileSync(statsPath, "utf8")) as Data : null;
  const invocations: Data[] = [];
  const responses = new Map<string, Data>();
  const queue = new Map<string, Data[]>();
  const requests = new Map<string, Data>();
  const websocket = records.filter((entry) => entry.kind === "websocket");
  for (const entry of websocket) {
    const body = entry.body as Data | null;
    assert(!entry.truncated && body, "Incomplete WebSocket capture");
    if (entry.from_client && body.type === "response.create") {
      const invocation = { time: entry.time, flowId: entry.flow_id, body };
      invocations.push(invocation);
      const pending = queue.get(entry.flow_id) ?? [];
      pending.push(invocation);
      queue.set(entry.flow_id, pending);
    }
    if (!entry.from_client && body.type === "response.created") {
      const invocation = queue.get(entry.flow_id)?.shift();
      assert(invocation, "Could not correlate upstream response to request");
      requests.set(body.response.id, invocation);
    }
    if (!entry.from_client && body.type === "response.completed") responses.set(body.response.id, { ...body.response, completedAt: entry.time });
  }
  const usage = [...responses.values()].map((response) => {
    const invocation = requests.get(response.id);
    assert(invocation, "Missing upstream request mapping");
    const request = invocation.body;
    assert.equal(response.model, request.model, "Upstream changed model");
    const input = Number(response.usage?.input_tokens);
    const cached = Number(response.usage?.input_tokens_details?.cached_tokens ?? 0);
    const cacheWrite = Number(response.usage?.input_tokens_details?.cache_write_tokens ?? 0);
    const output = Number(response.usage?.output_tokens);
    assert(request.generate === false || response.service_tier === "default", "Unexpected service tier; update prices");
    return {
      responseId: response.id, flowId: invocation.flowId, startedAt: invocation.time, completedAt: response.completedAt,
      model: response.model, warmup: request.generate === false, previousResponseId: request.previous_response_id ?? null,
      threadId: request.client_metadata?.thread_id ?? null, turnId: request.client_metadata?.turn_id ?? null,
      inputItems: request.input?.length ?? 0, input, cached, cacheWrite, output,
      reasoningOutput: Number(response.usage?.output_tokens_details?.reasoning_tokens ?? 0),
      total: Number(response.usage?.total_tokens), serviceTier: response.service_tier,
      estimatedUsd: estimateUsd(response.model, input, cached, cacheWrite, output),
    };
  });
  const usageEvents = level1.filter((entry) => entry.message.method === "thread/tokenUsage/updated").map((entry, index) => ({ index, time: entry.time, ...entry.message.params }));
  const turns = [...new Set(usageEvents.map((entry) => String(entry.turnId)))].map((turnId) => {
    const events = usageEvents.filter((entry) => entry.turnId === turnId);
    const upstream = usage.filter((entry) => !entry.warmup && entry.turnId === turnId);
    const signatures = events.map((entry) => JSON.stringify(entry.tokenUsage));
    const complete = level1.find((entry) => entry.message.method === "turn/completed" && entry.message.params.turn.id === turnId);
    const firstDelta = level1.find((entry) => /\/delta$/.test(String(entry.message.method)) && entry.message.params?.turnId === turnId);
    return { turnId, events, repeatedSnapshots: signatures.length - new Set(signatures).size, upstreamResponses: upstream.map((entry) => entry.responseId), model: [...new Set(upstream.map((entry) => entry.model))], completedAt: complete?.time ?? null, firstDeltaAt: firstDelta?.time ?? null, finalTurnKeys: Object.keys(complete?.message.params.turn ?? {}) };
  });
  const generated = usage.filter((entry) => !entry.warmup);
  const snapshotFor = (response: typeof usage[number]) => ({ totalTokens: response.total, inputTokens: response.input, cachedInputTokens: response.cached, cacheWriteInputTokens: response.cacheWrite, outputTokens: response.output, reasoningOutputTokens: response.reasoningOutput });
  const running: Record<string, number> = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  const accountingMatches = generated.map((response) => {
    const expectedLast = snapshotFor(response);
    for (const [key, value] of Object.entries(expectedLast)) running[key] = (running[key] ?? 0) + value;
    const match = usageEvents.find((entry) => entry.turnId === response.turnId && Object.entries(expectedLast).every(([key, value]) => entry.tokenUsage.last[key] === value));
    const expectedTotal = { ...running };
    return { responseId: response.responseId, turnId: response.turnId, expectedLast, expectedTotal, notificationIndex: match?.index ?? null, totalMatches: Boolean(match) && Object.entries(expectedTotal).every(([key, value]) => match.tokenUsage.total[key] === value), completionToNotificationMs: match ? Date.parse(match.time) - response.completedAt * 1000 : null };
  });
  const sumCost = (entries: typeof usage) => entries.reduce((total, entry) => total + entry.estimatedUsd, 0);
  if (options.requireComplete) {
    const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) as Data;
    assert.equal(result.level1.dropped, 0);
    assert.equal(result.sourceAuthUnchanged, true);
    assert.equal(stats?.events_dropped, 0);
    assert(generated.length >= 6 && generated.length <= 12, "Expected bounded multi-step Luna work and two short Sol completions");
    assert.equal(turns.length, 3);
    assert.deepEqual(turns.map((turn) => turn.model), [["gpt-6-luna"], ["gpt-6-sol"], ["gpt-6-sol"]]);
    assert(!records.some((entry) => entry.kind === "sse"), "Unexpected HTTP/SSE inference fallback");
    assert.equal(usage.length, invocations.length, "An upstream response did not complete");
    assert(accountingMatches.every((entry) => entry.totalMatches), "L1 cumulative/last usage differs from completed L2 responses");
    assert(turns.every((turn) => !turn.finalTurnKeys.some((key) => /usage|token|cost/i.test(key))), "Final turn shape changed; review telemetry conclusions");
  }
  return {
    pricing: { checkedOn: "2026-10-12", basis: "Standard short-context API-equivalent estimate, not subscription billing; warmups separately reported", sources: ["https://developers.openai.com/api/docs/models/gpt-6-luna", "https://developers.openai.com/api/docs/models/gpt-6-sol"], usdPerMillion: prices },
    usage, turns, usageEvents, accountingMatches, generatedTokenTotals: running, settingsEvents: level1.filter((entry) => entry.message.method === "thread/settings/updated"),
    messageCounts: Object.fromEntries([...new Set(level1.map((entry) => entry.message.method).filter(Boolean))].map((method) => [method, level1.filter((entry) => entry.message.method === method).length])),
    stats, websocketMessages: websocket.length, generatedEstimatedUsd: sumCost(generated), warmupEstimatedUsd: sumCost(usage.filter((entry) => entry.warmup)), includingWarmupEstimatedUsd: sumCost(usage),
  };
}

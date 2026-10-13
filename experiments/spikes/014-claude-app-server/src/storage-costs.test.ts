import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { readStorageCostBaseline, storageAttemptAccounting } from "./storage-costs.js";

const model = "claude-haiku-5-5";
const root = resolve(import.meta.dirname, "../../../artifacts/014-claude-app-server/storage-tests");

function costState(sessionId: string, cost: number, input: number) {
  return {
    type: "cost-state", sessionId, totalCostUSD: cost,
    totalAPIDuration: 1, totalAPIDurationWithoutRetries: 1, totalToolDuration: 0,
    totalLinesAdded: 0, totalLinesRemoved: 0, totalDuration: 1, startTime: 1,
    modelUsage: { [model]: { inputTokens: input, outputTokens: 10, cacheReadInputTokens: 20, cacheCreationInputTokens: 30, webSearchRequests: 0, costUSD: cost } },
  };
}

test("cost baseline uses last valid matching transcript state and ignores malformed later metadata", () => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(mkdtempSync(join(root, "cost-")), "fixture.jsonl");
  const sessionId = "fixture-session";
  writeFileSync(path, [
    costState(sessionId, 0.1, 100), costState(sessionId, 0.2, 200),
    costState("other-session", 0.8, 800),
    { ...costState(sessionId, 0.9, 900), totalDuration: -1 },
  ].map((item) => JSON.stringify(item)).join("\n") + '\n{"type":"cost-state"');
  const baseline = readStorageCostBaseline(path, sessionId);
  assert.equal(baseline.origin, "transcript-cost-state");
  assert.equal(baseline.lastValidLine, 2);
  assert.equal(baseline.totalCostUsd, 0.2);
  assert.equal(baseline.modelUsage[model]?.inputTokens, 200);
  assert.equal(readStorageCostBaseline(path, "absent-session").origin, "transcript-no-cost-state");
});

test("resumed accounting differences saved totals and refuses zeroed error/reset results", () => {
  const prior = costState("fixture", 0.2, 200);
  const current = costState("fixture", 0.3, 350);
  const baseline = { origin: "transcript-cost-state" as const, totalCostUsd: prior.totalCostUSD, modelUsage: prior.modelUsage };
  const result = {
    total_cost_usd: current.totalCostUSD,
    modelUsage: { [model]: { ...current.modelUsage[model]!, contextWindow: 200_000, maxOutputTokens: 256 } },
    usage: {} as SDKResultMessage["usage"], is_error: false,
  };
  const accounting = storageAttemptAccounting(baseline, result);
  assert(Math.abs((accounting.sdkIncrementalCostUsd as number) - 0.1) < 1e-12);
  assert.equal((accounting.incrementalModelUsage as typeof current.modelUsage)[model]?.inputTokens, 150);
  const price = accounting.priceEstimate as { incrementalTokens: { input: number; output: number } };
  assert.deepEqual(price.incrementalTokens, { input: 150, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(storageAttemptAccounting(baseline, { ...result, is_error: true }).sdkIncrementalCostUsd, undefined);
  assert.equal(storageAttemptAccounting(baseline, { ...result, total_cost_usd: 0, modelUsage: {} }).sdkIncrementalCostUsd, undefined);
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ModelUsage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

const tokenFields = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const;
const modelFields = [...tokenFields, "webSearchRequests", "costUSD"] as const;
type StoredModelUsage = Pick<ModelUsage, typeof modelFields[number]>;

export type StorageCostBaseline = {
  origin: "fresh-query" | "transcript-cost-state" | "transcript-no-cost-state";
  totalCostUsd: number;
  modelUsage: Record<string, StoredModelUsage>;
  transcriptSha256?: string;
  lastValidLine?: number;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validNumber(value: unknown, maximum = 1e15): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

// This deliberately matches the pinned native cost-state schema, not a guessed
// sum of assistant messages. Native loader: last valid record per session wins.
function validCostState(value: unknown, sessionId: string): value is {
  totalCostUSD: number; modelUsage: Record<string, StoredModelUsage>;
} {
  if (!object(value) || value.type !== "cost-state" || value.sessionId !== sessionId) return false;
  if (!validNumber(value.totalCostUSD, 1e9) || !object(value.modelUsage)) return false;
  if (!["totalAPIDuration", "totalAPIDurationWithoutRetries", "totalToolDuration", "totalLinesAdded", "totalLinesRemoved", "totalDuration", "startTime"].every((key) => validNumber(value[key]))) return false;
  if (value.hasUnknownModelCost !== undefined && typeof value.hasUnknownModelCost !== "boolean") return false;
  const models = Object.entries(value.modelUsage);
  if (!models.every(([name, usage]) => /^[^\p{Cc}\p{Cf}]+$/u.test(name) && object(usage)
    && modelFields.every((key) => validNumber(usage[key]))
    && (usage.thinkingTokens === undefined || validNumber(usage.thinkingTokens)))) return false;
  return tokenFields.every((key) => models.reduce((sum, [, usage]) => sum + (usage as StoredModelUsage)[key], 0) <= 1e15);
}

/** Read the cumulative ledger that this stopped transcript will restore. */
export function readStorageCostBaseline(path?: string, sessionId?: string): StorageCostBaseline {
  if (path === undefined) return { origin: "fresh-query", totalCostUsd: 0, modelUsage: {} };
  const raw = readFileSync(path);
  const baseline: StorageCostBaseline = {
    origin: "transcript-no-cost-state", totalCostUsd: 0, modelUsage: {},
    transcriptSha256: createHash("sha256").update(raw).digest("hex"),
  };
  for (const [index, line] of raw.toString("utf8").split("\n").entries()) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (sessionId !== undefined && validCostState(parsed, sessionId)) {
      baseline.origin = "transcript-cost-state";
      baseline.totalCostUsd = parsed.totalCostUSD;
      baseline.modelUsage = parsed.modelUsage;
      baseline.lastValidLine = index + 1;
    }
  }
  return baseline;
}

/** Difference result totals against persisted history; never add history twice. */
export function storageAttemptAccounting(baseline: StorageCostBaseline, result: Pick<SDKResultMessage, "total_cost_usd" | "modelUsage" | "usage" | "is_error">): Record<string, unknown> {
  const record: Record<string, unknown> = {
    baseline,
    sdkCumulativeCostUsd: result.total_cost_usd,
    sdkCumulativeModelUsage: result.modelUsage,
    mainLoopTurnUsage: result.usage,
    actualBilling: "Unknown; SDK costs and list-price estimates are not subscription billing.",
  };
  const incrementalModels: Record<string, StoredModelUsage> = {};
  let valid = !result.is_error && validNumber(result.total_cost_usd);
  const delta = result.total_cost_usd - baseline.totalCostUsd;
  if (delta < -1e-12) valid = false;
  for (const name of new Set([...Object.keys(baseline.modelUsage), ...Object.keys(result.modelUsage)])) {
    const previous = baseline.modelUsage[name];
    const current = result.modelUsage[name];
    const values = {} as StoredModelUsage;
    for (const field of modelFields) {
      const difference = (current?.[field] ?? 0) - (previous?.[field] ?? 0);
      if (!Number.isFinite(difference) || difference < (field === "costUSD" ? -1e-12 : 0)) valid = false;
      values[field] = Math.max(0, difference);
    }
    incrementalModels[name] = values;
  }
  if (!valid) {
    record.incrementalAccounting = "unknown: error result or cumulative counters regressed; may omit accepted provider work";
    return record;
  }
  record.incrementalAccounting = "result cumulative totals minus persisted source baseline";
  record.sdkIncrementalCostUsd = Math.max(0, delta);
  record.incrementalModelUsage = incrementalModels;
  if (!Object.entries(result.modelUsage).every(([name, usage]) => (usage.canonicalModel ?? name).startsWith("claude-haiku-5-5"))) {
    record.priceEstimate = { status: "unavailable", reason: "Usage includes a model outside the explicit Haiku 5.5 rate table." };
    return record;
  }
  const counts = Object.values(incrementalModels).reduce((sum, item) => ({
    input: sum.input + item.inputTokens, output: sum.output + item.outputTokens,
    cacheRead: sum.cacheRead + item.cacheReadInputTokens, cacheWrite: sum.cacheWrite + item.cacheCreationInputTokens,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  record.priceEstimate = {
    asOf: "2026-10-13", source: "https://platform.claude.com/docs/en/models/haiku-5-5/overview",
    usdPerMillion: { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.20 },
    incrementalTokens: counts,
    usdRange: [
      (counts.input * 0.10 + counts.output * 0.50 + counts.cacheRead * 0.01 + counts.cacheWrite * 0.125) / 1_000_000,
      (counts.input * 0.10 + counts.output * 0.50 + counts.cacheRead * 0.01 + counts.cacheWrite * 0.20) / 1_000_000,
    ],
    assumption: "Haiku 5.5 prompt below 100k; cache-write TTL absent from modelUsage, so estimate range is 5m to 1h.",
  };
  return record;
}

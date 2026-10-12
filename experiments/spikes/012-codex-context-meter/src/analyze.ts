import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baselineTokens, footerMeter, remainingPercent, usableWindow, type TokenSnapshot } from "./meter.js";

type Data = Record<string, any>;
const root = fileURLToPath(new URL("../../../", import.meta.url));
assert(process.argv.length <= 3, "Usage: probe [009-capture-directory]");
const sourceCapture = resolve(process.argv[2] ?? join(root, "artifacts/009-codex-turn-telemetry/run-1791818262957"));
const capturePath = join(sourceCapture, "level1.jsonl");
assert(existsSync(capturePath), "Recorded live capture not found. Supply a 009 capture directory; this analyzer never makes model calls");
const text = readFileSync(capturePath, "utf8");
const records = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Data);
const invocation = JSON.parse(readFileSync(join(sourceCapture, "level0.json"), "utf8")) as Data;
assert.equal(invocation.version, "codex-cli 0.162.1", "Formula is release-pinned; review source before applying to a different executable");
const rows = records.filter((record) => record.message?.method === "thread/tokenUsage/updated").map((record) => {
  const params = record.message.params as Data;
  const snapshot = params.tokenUsage as TokenSnapshot;
  const meter = footerMeter(snapshot);
  const window = snapshot.modelContextWindow;
  const naiveRemainingPercent = window !== null && window > 0 ? Math.round(Math.min(100, Math.max(0, (1 - snapshot.last.totalTokens / window) * 100))) : null;
  const unadjustedEstimatedHeadroomPercent = window !== null && window > 0 ? Math.round(Math.min(100, Math.max(0, (1 - snapshot.last.totalTokens / window) * 100)) * 100) / 100 : null;
  return {
    time: record.time, threadId: params.threadId, turnId: params.turnId,
    lastTotalTokens: snapshot.last.totalTokens, cumulativeTotalTokens: snapshot.total.totalTokens,
    modelContextWindow: window, cliRemainingPercent: meter.percent, cliUsedPercent: meter.percent === null ? null : 100 - meter.percent,
    footerFallbackUsedTokens: meter.fallbackUsedTokens, naiveRemainingPercent, unadjustedEstimatedHeadroomPercent,
    incorrectCumulativeMeterPercent: window === null ? null : remainingPercent(snapshot.total.totalTokens, window),
  };
});
assert(rows.length > 0, "No context inputs were recorded");
const resultPath = join(sourceCapture, "result.json");
const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) as Data : null;
const catalogPath = result?.isolated ? join(result.isolated, "home/.codex/models_cache.json") : null;
let catalogEvidence: Data[] = [];
if (catalogPath && existsSync(catalogPath)) {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Data;
  catalogEvidence = (catalog.models as Data[]).filter((model) => ["gpt-6-luna", "gpt-6-sol"].includes(model.slug)).map((model) => ({
    model: model.slug, contextWindow: model.context_window, maxContextWindow: model.max_context_window,
    effectivePercent: model.effective_context_window_percent,
    usableWindow: usableWindow(model.context_window, model.max_context_window, model.effective_context_window_percent),
  }));
}
process.umask(0o077);
const artifacts = join(root, "artifacts/012-codex-context-meter", `replay-${Date.now()}`);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const localSource = join(root, "vendor/codex/codex-rs/tui/src/token_usage.rs");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const report = {
  sourceCapture, sourceCaptureSha256: sha256(text), executableVersion: invocation.version,
  executableSha256: invocation.sha256, releaseRevision: "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d",
  localSourceRevision: spawnSync("git", ["-C", join(root, "vendor/codex"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  localMeterSourceSha256: existsSync(localSource) ? sha256(readFileSync(localSource)) : null,
  baselineTokens, rows, catalogEvidence,
  evidence: "CLI-equivalent calculations from existing LIVE app-server captures plus release source; no TUI screenshot or new inference",
  newModelCalls: 0, incrementalEstimatedUsd: 0,
};
writeFileSync(join(artifacts, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ artifacts, version: report.executableVersion, baselineTokens, cliAdjustedPercentages: rows.map((row) => row.cliRemainingPercent), unadjustedEstimatedHeadroomPercentages: rows.map((row) => row.unadjustedEstimatedHeadroomPercent), catalogEvidence, newModelCalls: 0, incrementalEstimatedUsd: 0 }, null, 2));

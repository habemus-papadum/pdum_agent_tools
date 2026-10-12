import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeCapture } from "./usage.js";

const directory = process.argv[2];
assert(directory, "Usage: pnpm --filter @agent-spike/009-codex-turn-telemetry analyze <artifact-directory>");
const report = analyzeCapture(resolve(directory));
writeFileSync(join(resolve(directory), "analysis.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ turns: report.turns.length, upstreamResponses: report.usage.length, generatedEstimatedUsd: report.generatedEstimatedUsd, warmupEstimatedUsd: report.warmupEstimatedUsd, includingWarmupEstimatedUsd: report.includingWarmupEstimatedUsd }, null, 2));

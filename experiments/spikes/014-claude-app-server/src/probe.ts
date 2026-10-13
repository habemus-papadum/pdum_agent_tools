import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { liveAuthentication } from "./auth.js";
import { runConcurrencyProbe } from "./concurrency-probe.js";
import { writeCostLedger } from "./cost.js";
import { runLaunchProbe } from "./launch-probe.js";
import { writeJson } from "./launch.js";
import { runManagerProbe } from "./manager-probe.js";
import { runRecoveryProbe } from "./recovery-probe.js";
import { runStorageProbe } from "./storage.js";

const args = new Set(process.argv.slice(2));
const supported = ["--live", "--keychain", "--skip-launch", "--skip-storage", "--skip-manager", "--skip-concurrency"];
for (const arg of args) if (!supported.includes(arg)) throw new Error(`Unknown option: ${arg}`);
if (args.has("--keychain") && !args.has("--live")) throw new Error("--keychain requires --live");
const live = args.has("--live");
const auth = live ? liveAuthentication(args.has("--keychain")) : undefined;
const base = resolve(import.meta.dirname, "../../../artifacts/014-claude-app-server");
mkdirSync(base, { recursive: true, mode: 0o700 });
const directory = mkdtempSync(join(base, "run-"));
const checks: Record<string, unknown> = {};
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(), directory, live, model: "claude-haiku-5-5",
  authentication: auth?.provenance ?? "none", checks,
  limitations: [
    "No manager restart event journal", "One protocol controller per worker",
    "Native terminal attach is a distinct transport; see spike015",
  ],
};
writeJson(join(directory, "report.json"), report);

async function check(name: string, run: () => Promise<unknown>): Promise<void> {
  console.log(`Running ${name} (${live ? "live enabled" : "credential-free"})`);
  try { checks[name] = await run(); }
  catch (error) { checks[name] = { status: "fail", error: String(error) }; process.exitCode = 1; }
  writeJson(join(directory, "report.json"), report);
}

try {
  if (!args.has("--skip-launch")) {
    await check("launch", () => runLaunchProbe(join(directory, "launch"), auth
      ? { live: true, authEnv: auth.environment, model: "claude-haiku-5-5" }
      : { model: "claude-haiku-5-5" }));
  }
  if (!args.has("--skip-storage")) {
    await check("storage", () => runStorageProbe(join(directory, "storage"), auth
      ? { live: { environment: auth.environment, provenance: auth.provenance }, maxBudgetUsdPerTurn: 0.05 }
      : {}));
  }
  if (auth && !args.has("--skip-concurrency")) {
    await check("concurrency", () => runConcurrencyProbe(join(directory, "concurrency"), auth));
  }
  if (!args.has("--skip-manager")) {
    await check("manager", () => runManagerProbe(join(directory, "manager")));
    await check("recovery", () => runRecoveryProbe(join(directory, "recovery")));
  }
} finally {
  report.finishedAt = new Date().toISOString();
  const cost = writeCostLedger(directory, auth?.provenance ?? "none");
  report.cost = cost;
  const failures = JSON.stringify(checks).match(/"status":"fail"/g)?.length ?? 0;
  report.status = failures ? "fail" : "pass-with-limitations";
  if (failures) process.exitCode = 1;
  writeJson(join(directory, "report.json"), report);
  console.log(JSON.stringify({
    status: report.status, artifacts: directory, modelAttempts: cost.attempts.length,
    sdkEstimatedUsd: cost.observedSdkTotalUsd, priceEstimateUsdRange: cost.observedPriceEstimateUsdRange,
    unknownCosts: cost.attemptsWithoutFinalUsage,
  }, null, 2));
}

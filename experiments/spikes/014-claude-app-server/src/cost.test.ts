import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeCostLedger } from "./cost.js";

test("ledger counts final streaming totals and incremental resumed costs, retaining unknown failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "spike014-ledger-"));
  try {
    mkdirSync(join(directory, "launch")); mkdirSync(join(directory, "storage"));
    writeFileSync(join(directory, "launch", "summary.json"), JSON.stringify({
      name: "live-browser", status: "pass", selectedModel: "claude-haiku-5-5",
      usage: [{ totalCostUsd: 0.01 }, { totalCostUsd: 0.03 }],
    }));
    writeFileSync(join(directory, "storage", "storage-live.json"), JSON.stringify({ attempts: [
      { name: "fork", status: "success", sdkCumulativeCostUsd: 5.01, sdkIncrementalCostUsd: 0.01 },
      { name: "failed", status: "failed", unknownCost: "connection failed before usage" },
    ] }));
    const ledger = writeCostLedger(directory, "test metadata only; no provider requests");
    assert.equal(ledger.attempts.length, 3);
    assert.equal(ledger.observedSdkTotalUsd, 0.04);
    assert.equal(ledger.attemptsWithoutFinalUsage, 1);
    assert.match(ledger.actualBilling, /Not measured/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

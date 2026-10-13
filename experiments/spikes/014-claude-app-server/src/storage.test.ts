import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runStorageProbe } from "./storage.js";

test("SDK storage isolates two profiles sharing a workspace and forks at a chosen message", async () => {
  const root = resolve(import.meta.dirname, "../../../artifacts/014-claude-app-server/storage-tests");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const report = await runStorageProbe(mkdtempSync(join(root, "run-")));
  assert.equal(report.status, "pass");
  assert.deepEqual(report.fixtureCounts, { original: 4, full: 4, selected: 2 });
  assert(Object.values(report.checks as Record<string, boolean>).every(Boolean));
  assert.deepEqual(report.fixtureCost, { providerRequests: 0, estimatedUsd: 0, actualBilling: "No provider requests" });
});

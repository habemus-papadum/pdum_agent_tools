import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { footerMeter, remainingPercent, statusLinePercent, usableWindow, type TokenSnapshot } from "./meter.js";

test("matches the release TUI's 12700-of-13000 source expectation", () => {
  assert.equal(remainingPercent(12_700, 13_000), 30);
});

test("subtracts the fixed baseline, clamps, and rounds positive halves upward", () => {
  assert.equal(remainingPercent(10_674, 258_400), 100);
  assert.equal(remainingPercent(14_647, 258_400), 99);
  assert.equal(remainingPercent(12_990, 14_000), 51);
  assert.equal(remainingPercent(0, 12_000), 0);
  assert.equal(remainingPercent(200_000, 100_000), 0);
  assert.equal(remainingPercent(-100, 100_000), 100);
  assert.throws(() => remainingPercent(Number.NaN, 100_000));
});

test("known footer windows use last, not cumulative totals or cache counters", () => {
  const snapshot = { last: { totalTokens: 14_647 }, total: { totalTokens: 71_515 }, modelContextWindow: 258_400 };
  assert.deepEqual(footerMeter(snapshot), { percent: 99, fallbackUsedTokens: null });
  assert.equal(remainingPercent(snapshot.total.totalTokens, 258_400), 76);
});

test("preserves footer and configurable status-line unknown-window differences", () => {
  const snapshot = { last: { totalTokens: 12_700 }, total: { totalTokens: 99_000 }, modelContextWindow: null };
  assert.deepEqual(footerMeter(snapshot), { percent: null, fallbackUsedTokens: 99_000 });
  assert.equal(statusLinePercent(snapshot, 13_000, false), 30);
  assert.equal(statusLinePercent(snapshot, null, false), 100);
  assert.equal(statusLinePercent(snapshot, 13_000, true), null);
  assert.equal(statusLinePercent(null, 258_400, false), 100);
});

test("runtime window prefers catalog context_window and applies its headroom", () => {
  assert.equal(usableWindow(272_000, 872_000, 95), 258_400);
  assert.equal(usableWindow(null, 872_000, 95), 828_400);
  assert.equal(usableWindow(null, null, 95), null);
});

const capturePath = new URL("../../../artifacts/009-codex-turn-telemetry/run-1791818262957/level1.jsonl", import.meta.url);
test("replays all six recorded LIVE usage snapshots without another model call", { skip: !existsSync(capturePath) }, () => {
  const records = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { message: { method?: string; params?: { tokenUsage?: TokenSnapshot } } });
  const percentages = records.filter((record) => record.message.method === "thread/tokenUsage/updated").map((record) => {
    const usage = record.message.params?.tokenUsage;
    assert(usage);
    return footerMeter(usage).percent;
  });
  assert.deepEqual(percentages, [100, 100, 100, 100, 99, 99]);
});

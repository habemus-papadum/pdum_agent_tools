import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateUsd } from "./usage.js";

test("price cached input as part of input, and reasoning as part of output", () => {
  assert.equal(estimateUsd("gpt-6-luna", 10_000, 9_000, 0, 100), 0.00024);
  assert.equal(estimateUsd("gpt-6-sol", 10_000, 9_000, 0, 100), 0.0048);
});

test("reject unknown models, impossible usage, and unpriced long contexts", () => {
  assert.throws(() => estimateUsd("unknown-model", 100, 0, 0, 1));
  assert.throws(() => estimateUsd("gpt-6-luna", 100, 101, 0, 1));
  assert.throws(() => estimateUsd("gpt-6-luna", 300_000, 0, 0, 1));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeUsage } from '../src/usage.mjs';

test('summarizes one uncached request', () => {
  const result = summarizeUsage([{ sessionId: 'a', requestId: 'r', revision: 1, origin: 'runtime', inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 }]);
  assert.equal(result.totals.inputTokens, 10);
  assert.equal(result.totals.requests, 1);
});

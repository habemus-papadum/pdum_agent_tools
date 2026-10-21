import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkScenarios } from './scenarios.ts';
test('portable job/runtime/client integration', { timeout: 10000 }, async () => {
  const result = await runWorkScenarios(); assert.equal(result.passed, true); assert.equal(result.cases.length, 4);
});

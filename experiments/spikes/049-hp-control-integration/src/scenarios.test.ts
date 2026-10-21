import test from 'node:test';
import assert from 'node:assert/strict';
import { runControlScenarios } from './scenarios.ts';
test('portable dynamic-control cases', async () => {
  const report = await runControlScenarios();
  assert.equal(report.cases.length, 6);
  assert.equal(report.passed, true);
});

import test from 'node:test';
import { parallelScenarios } from './scenarios.ts';
for (const scenario of parallelScenarios) test(scenario.name, { timeout: 5000 }, scenario.run);

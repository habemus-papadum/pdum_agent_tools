import { test } from 'node:test';
import { controlChecks } from './checks.ts';
for (const [name, run] of Object.entries(controlChecks)) test(name, { timeout: 3000 }, run);

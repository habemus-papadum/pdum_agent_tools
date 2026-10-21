import test from 'node:test';
import { jobCases } from './cases.ts';
for (const [name, run] of Object.entries(jobCases)) test(name, run);

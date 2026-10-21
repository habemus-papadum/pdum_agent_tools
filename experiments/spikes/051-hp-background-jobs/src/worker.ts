import { runJobCases } from './cases.ts';
void runJobCases().then(results => globalThis.postMessage({ results, passed: results.every(result => result.passed) }));

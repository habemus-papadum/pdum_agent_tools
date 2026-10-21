import { runControlChecks } from './checks.ts';
console.log(JSON.stringify(await runControlChecks(), null, 2));

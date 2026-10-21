import { runControlScenarios } from './scenarios.ts';
import { runControlChecks } from '../../047-hp-dynamic-control/checks.ts';
globalThis.addEventListener('message', async () => {
  try { globalThis.postMessage({ report: { integration: await runControlScenarios(), dynamic: await runControlChecks() } }); }
  catch (error) { globalThis.postMessage({ error: String(error) }); }
});

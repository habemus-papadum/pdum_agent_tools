import { runParallelScenarios } from './scenarios.ts';
globalThis.addEventListener('message', async () => {
  try { globalThis.postMessage({ report: await runParallelScenarios() }); }
  catch (error) { globalThis.postMessage({ error: String(error) }); }
});

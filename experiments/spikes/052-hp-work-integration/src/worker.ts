import { runWorkScenarios } from './scenarios.ts';
import { runWorkLive } from './live.ts';
import { DirectResponsesConnector } from '../../038-hp-sdk-fit/src/direct.ts';
import { browserConnectionFactory } from '../../039-hp-agent-runtime/src/browser-connection.ts';
globalThis.addEventListener('message', async ({ data }) => {
  let connector: DirectResponsesConnector | undefined;
  try {
    if (!data.live) { globalThis.postMessage({ report: await runWorkScenarios() }); return; }
    const host = await (await fetch('/__spike')).json();
    if (!host.live) throw Error('Restart host with --live');
    const instructions = await (await fetch('/instructions.json')).json();
    connector = new DirectResponsesConnector(browserConnectionFactory(data.url), { max_output_tokens: 512, reasoning: { effort: 'none' }, service_tier: 'default' });
    const report = await runWorkLive(connector, instructions, AbortSignal.timeout(100000));
    globalThis.postMessage({ report });
  } catch (error) { globalThis.postMessage({ error: String(error) }); }
  finally { connector?.close(); }
});

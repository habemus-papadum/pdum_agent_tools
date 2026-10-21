import { AgentRuntime } from './runtime.ts';
import { FixtureConnector, echoTool } from './fixture.ts';
import { servePort } from './protocol.ts';
import { browserConnectionFactory } from './browser-connection.ts';
import { DirectResponsesConnector } from '../../038-hp-sdk-fit/src/direct.ts';

// A transferred MessagePort separates UI lifetime from the worker-owned loop.
globalThis.addEventListener('message', ((event: MessageEvent) => {
  const { port, url, live, instructions } = event.data;
  const connector = live ? new DirectResponsesConnector(browserConnectionFactory(url), { max_output_tokens: 512, reasoning: { effort: 'none' }, service_tier: 'default' }) : new FixtureConnector();
  const runtime = new AgentRuntime({ connector, model: 'gpt-6-luna', instructions: instructions ?? 'You are a concise assistant. Use the provided tools when requested.', tools: [echoTool] });
  servePort(runtime, port);
}) as EventListener);

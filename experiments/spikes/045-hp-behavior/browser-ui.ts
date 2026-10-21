import { InspectorController, canonicalText } from '@habemus-papadum/aiui-prompts-inspector/model';
import { createFidelityAdapter } from '../041-hp-codex-fidelity/src/core.ts';
import { PortClient } from '../039-hp-agent-runtime/src/protocol.ts';
import { STOCK_ROWS, DELEGATION_PROMPT, type Annotation } from './application.ts';
import type { Capture } from './browser-worker.ts';

interface Evidence {
  captures: Capture[]; notifications: string[]; provenance?: unknown; annotation?: Annotation;
  recording?: unknown; report?: unknown; calls?: unknown; error?: string; inspector?: unknown;
}
declare global { interface Window {
  runHPDelegation: (options?: { url?: string }) => Promise<unknown>;
  hpDelegationEvidence: Evidence;
} }
const result = document.querySelector<HTMLPreElement>('#result')!;
const total = document.querySelector<HTMLElement>('#total')!;
const text = document.querySelector<HTMLPreElement>('#prompt-text')!;
const provenance = document.querySelector<HTMLPreElement>('#provenance')!;
const selector = document.querySelector<HTMLSelectElement>('#requests')!;
let inspector: InspectorController | undefined;
let running = false;
window.hpDelegationEvidence = { captures: [], notifications: [] };
for (const row of STOCK_ROWS) {
  const tr = document.createElement('tr');
  for (const value of [row.item, row.units]) { const td = document.createElement('td'); td.textContent = String(value); tr.append(td); }
  document.querySelector('tbody')!.append(tr);
}
function inspect(index: number) {
  const capture = window.hpDelegationEvidence.captures[index]; if (!capture) return;
  inspector?.dispose();
  inspector = new InspectorController(capture.wire, { operation: capture.operation, adapters: [createFidelityAdapter()] as never });
  if (inspector.error || !inspector.compiled) throw new Error(inspector.error ?? 'Missing compiled prompt');
  text.textContent = canonicalText(inspector.compiled);
  const detail = { package: '@habemus-papadum/aiui-prompts-inspector/model', verification: inspector.document?.verification,
    fingerprint: inspector.record?.fingerprint, occurrences: inspector.compiled.occurrences };
  window.hpDelegationEvidence.inspector = detail; provenance.textContent = JSON.stringify(detail, null, 2);
}
selector.addEventListener('change', () => inspect(Number(selector.value)));

window.runHPDelegation = async (options = {}) => {
  if (running) throw new Error('A delegation run is already active'); running = true;
  const url = options.url ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/responses`;
  const worker = new Worker(new URL('./browser-worker.js', import.meta.url), { type: 'module' });
  const channel = new MessageChannel(); const client = new PortClient(channel.port2);
  window.hpDelegationEvidence = { captures: [], notifications: [] }; selector.replaceChildren(); total.textContent = 'Pending child calculation';
  let resolveReport!: (value: unknown) => void; let rejectReport!: (error: Error) => void;
  const reportPromise = new Promise<unknown>((resolve, reject) => { resolveReport = resolve; rejectReport = reject; });
  // Observe failure immediately even if it occurs before report is requested.
  void reportPromise.catch(() => {});
  let resolveStopped!: () => void; const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  worker.addEventListener('message', (event) => {
    const value = event.data;
    if (value.kind === 'capture') {
      const index = window.hpDelegationEvidence.captures.push(value.capture) - 1;
      const option = document.createElement('option'); option.value = String(index); option.textContent = `${index + 1}: request · replay verified`;
      selector.append(option); selector.value = String(index); inspect(index);
    } else if (value.kind === 'provenance') window.hpDelegationEvidence.provenance = value;
    else if (value.kind === 'annotation') {
      window.hpDelegationEvidence.annotation = value.annotation;
      total.textContent = `${value.annotation.total} units · calculated by child ${value.annotation.childThreadId}`;
    } else if (value.kind === 'report') {
      window.hpDelegationEvidence.calls = value.calls; window.hpDelegationEvidence.report = value.report; resolveReport(value.report);
    } else if (value.kind === 'report-error' || value.kind === 'worker-error') rejectReport(new Error(value.error));
    else if (value.kind === 'stopped') resolveStopped();
  });
  worker.addEventListener('error', (event) => rejectReport(new Error(event.message)));
  client.subscribe((event) => { window.hpDelegationEvidence.notifications.push(event.method); result.textContent = window.hpDelegationEvidence.notifications.slice(-12).join('\n'); });
  worker.postMessage({ port: channel.port1, url, rows: structuredClone(STOCK_ROWS) }, [channel.port1]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const execute = async () => {
      await client.request('initialize', { clientInfo: { name: 'hp-stock-dashboard', version: 'spike-045' }, capabilities: { experimentalApi: true } });
      const { thread } = await client.request<{ thread: { id: string } }>('thread/start');
      await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: DELEGATION_PROMPT }] });
      await client.request('hp/agent/wait', { threadId: thread.id });
      window.hpDelegationEvidence.recording = await client.request('hp/recording/read');
      worker.postMessage({ type: 'report', rootThreadId: thread.id });
      return reportPromise;
    };
    const report = await Promise.race([
      execute(),
      // Reject on a Worker failure during initialization instead of waiting on a stranded RPC.
      reportPromise.then(() => new Promise<never>(() => {})),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Delegation exceeded 125 seconds')), 125000); }),
    ]);
    result.textContent = JSON.stringify({ report, promptCaptures: window.hpDelegationEvidence.captures.length,
      verifiedSends: window.hpDelegationEvidence.captures.filter((capture) => capture.verified).length }, null, 2);
    return report;
  } catch (error) { window.hpDelegationEvidence.error = String(error); result.textContent = String(error); throw error; }
  finally {
    clearTimeout(timer); client.close(); channel.port2.close(); worker.postMessage({ type: 'stop' });
    await Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, 500))]); worker.terminate(); running = false;
  }
};
document.querySelector('#run')!.addEventListener('click', () => { void window.runHPDelegation().catch(() => {}); });

import { InspectorController, canonicalText } from '@habemus-papadum/aiui-prompts-inspector/model';
import { createFidelityAdapter } from '../041-hp-codex-fidelity/src/core.ts';
import { PortClient } from '../039-hp-agent-runtime/src/protocol.ts';
import { runDemo } from '../039-hp-agent-runtime/src/demo.ts';
import type { BrowserCapture } from './browser-worker.ts';

interface Evidence {
  mode: string; captures: BrowserCapture[]; provenance?: unknown; notifications: string[];
  report?: unknown; recording?: unknown; error?: string; inspector?: unknown;
}
declare global {
  interface Window {
    runHPDemo: (options?: { live?: boolean; url?: string }) => Promise<unknown>;
    hpEvidence: Evidence;
    hpResult?: unknown;
  }
}
const output = document.querySelector<HTMLPreElement>('#result')!;
const promptText = document.querySelector<HTMLPreElement>('#prompt-text')!;
const provenance = document.querySelector<HTMLPreElement>('#prompt-provenance')!;
const snapshot = document.querySelector<HTMLPreElement>('#snapshot')!;
const requests = document.querySelector<HTMLSelectElement>('#request')!;
let inspector: InspectorController | undefined;
let active = false;
window.hpEvidence = { mode: 'idle', captures: [], notifications: [] };

function inspect(index: number) {
  const capture = window.hpEvidence.captures[index];
  if (!capture) return;
  inspector?.dispose();
  inspector = new InspectorController(capture.wire ?? capture.operation, {
    ...(capture.wire ? { operation: capture.operation } : {}),
    adapters: [createFidelityAdapter()] as never,
  });
  if (inspector.error || !inspector.compiled) throw new Error(inspector.error ?? 'Inspector has no compiled prompt');
  promptText.textContent = canonicalText(inspector.compiled);
  const inspection = {
    package: '@habemus-papadum/aiui-prompts-inspector/model', kind: inspector.document?.kind,
    verification: inspector.document?.verification ?? { status: 'prepared-only; no socket send' },
    recordFingerprint: inspector.record?.fingerprint,
    occurrences: inspector.compiled.occurrences,
  };
  window.hpEvidence.inspector = inspection;
  provenance.textContent = JSON.stringify(inspection, null, 2);
  snapshot.textContent = JSON.stringify(capture.operation, null, 2);
}
requests.addEventListener('change', () => inspect(Number(requests.value)));

window.runHPDemo = async (options = {}) => {
  if (active) throw new Error('A demonstration is already running');
  active = true;
  const live = options.live === true;
  const url = options.url ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/responses`;
  const worker = new Worker(new URL('./browser-worker.js', import.meta.url), { type: 'module' });
  const channel = new MessageChannel();
  window.hpEvidence = { mode: live ? 'live-provider' : 'deterministic-provider-fixture', captures: [], notifications: [] };
  requests.replaceChildren();
  let stopped!: () => void;
  const stoppedPromise = new Promise<void>((resolve) => { stopped = resolve; });
  worker.addEventListener('message', (event) => {
    const value = event.data;
    if (value.kind === 'capture') {
      const index = window.hpEvidence.captures.push(value.capture) - 1;
      const option = document.createElement('option'); option.value = String(index);
      option.textContent = `${index + 1}: ${value.capture.kind}${value.capture.verified ? ' · replay verified' : ''}`;
      requests.append(option); requests.value = String(index); inspect(index);
    } else if (value.kind === 'provenance') window.hpEvidence.provenance = value;
    else if (value.kind === 'worker-error') { window.hpEvidence.error = value.error; output.textContent = value.error; }
    else if (value.kind === 'stopped') stopped();
  });
  worker.postMessage({ port: channel.port1, live, url }, [channel.port1]);
  const client = new PortClient(channel.port2);
  const unsubscribe = client.subscribe((event) => {
    window.hpEvidence.notifications.push(event.method);
    output.textContent = window.hpEvidence.notifications.slice(-12).join('\n');
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    output.textContent = live ? 'Running bounded live Luna demonstration…' : 'Running deterministic fixture demonstration…';
    const report = await Promise.race([
      runDemo(client, live),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Demonstration exceeded 120 seconds')), 120000); }),
    ]);
    window.hpEvidence.recording = await client.request('hp/recording/read');
    window.hpEvidence.report = report; window.hpResult = report;
    output.textContent = JSON.stringify({ ...report, promptCaptures: window.hpEvidence.captures.length,
      verifiedSends: window.hpEvidence.captures.filter((capture) => capture.verified).length }, null, 2);
    return report;
  } catch (error) {
    window.hpEvidence.error = String(error); output.textContent = String(error); throw error;
  } finally {
    clearTimeout(timer); unsubscribe(); client.close(); channel.port2.close();
    worker.postMessage({ type: 'stop' });
    await Promise.race([stoppedPromise, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    worker.terminate(); active = false;
  }
};
document.querySelector('#fixture')!.addEventListener('click', () => { void window.runHPDemo().catch(() => {}); });
document.querySelector('#live')!.addEventListener('click', () => { void window.runHPDemo({ live: true }).catch(() => {}); });

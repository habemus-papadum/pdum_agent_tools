import { PortClient } from './protocol.ts';
import { runDemo } from './demo.ts';
declare global { interface Window { runHPDemo: (options?: { live?: boolean; url?: string; instructions?: string }) => Promise<unknown>; hpResult?: unknown } }

const output = document.querySelector('pre')!;
window.runHPDemo = async (options = {}) => {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const channel = new MessageChannel();
  worker.postMessage({ port: channel.port1, ...options }, [channel.port1]);
  const client = new PortClient(channel.port2);
  output.textContent = 'Running…';
  const notifications: string[] = [];
  client.subscribe((event) => { notifications.push(event.method); output.textContent = notifications.slice(-15).join('\n'); });
  try {
    const report = await runDemo(client, options.live === true);
    window.hpResult = report; output.textContent = JSON.stringify(report, null, 2); return report;
  } catch (error) { output.textContent = String(error); throw error; }
  finally { client.close(); channel.port2.close(); worker.terminate(); }
};
document.querySelector('button')!.addEventListener('click', () => { void window.runHPDemo().catch(() => {}); });

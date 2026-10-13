import { query } from "@anthropic-ai/claude-agent-sdk/browser";
import { fullProbe, probe } from "./common.js";

const output = document.querySelector("#output");
let running = false;
async function run(options = {}) {
  if (running) throw new Error("A browser probe is already running");
  running = true;
  output.textContent = "Running…";
  try {
    const selectedProbe = options.otherProfileId ? fullProbe : probe;
    const report = await selectedProbe((worker, prompt, hooks) => query({
      prompt, hooks, websocket: { url: worker.websocketUrl },
    }), {
      baseUrl: location.origin,
      profileId: document.querySelector("#profile").value,
      ...options,
    });
    report.client = "official browser SDK in " + navigator.userAgent;
    report.sdkVersion = "0.3.296";
    globalThis.pdumClaudeProbe.report = report;
    output.textContent = JSON.stringify(report, null, 2);
    return report;
  } catch (error) {
    globalThis.pdumClaudeProbe.report = error.report ?? { status: "failed", error: String(error) };
    output.textContent = JSON.stringify(globalThis.pdumClaudeProbe.report, null, 2);
    throw error;
  } finally { running = false; }
}
globalThis.pdumClaudeProbe = { run, runFull: options => run(options), report: null };
document.querySelector("#initialize").addEventListener("click", () => { void run(); });
document.querySelector("#live").addEventListener("click", () => { void run({ live: true }); });

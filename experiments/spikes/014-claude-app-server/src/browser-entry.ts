import { query } from "@anthropic-ai/claude-agent-sdk/browser";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/browser";

// Build this entry with esbuild --bundle --platform=browser. It uses the published export unchanged.
const page = globalThis as unknown as {
  document: { querySelector(selector: string): { textContent: string | null } | null };
  location: { search: string };
  spike014: Record<string, unknown>;
};
const parameters = new URLSearchParams(page.location.search);
const endpoint = parameters.get("ws");
const frames: unknown[] = [];
const callbacks: unknown[] = [];
let pending: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
const queued: SDKUserMessage[] = [];
let closed = false;
function render(value: unknown): void {
  const output = page.document.querySelector("#output");
  if (output) output.textContent = JSON.stringify(value, null, 2);
}
if (!endpoint) throw new Error("Pass ?ws=ws://... to the browser probe page");
const input: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]() { return { next: async () => {
    const value = queued.shift();
    if (value) return { done: false, value };
    if (closed) return { done: true, value: undefined };
    return new Promise<IteratorResult<SDKUserMessage>>((done) => { pending = done; });
  } }; },
};
const session = query({
  websocket: { url: endpoint }, prompt: input,
  canUseTool: async (name, toolInput) => {
    callbacks.push({ type: "permission", name });
    return { behavior: "allow", updatedInput: toolInput };
  },
  hooks: {
    PreToolUse: [{ hooks: [async (hook) => {
      callbacks.push({ type: "hook", event: hook.hook_event_name });
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "ask" as const, permissionDecisionReason: "Browser permission probe" } };
    }] }],
    UserPromptSubmit: [{ hooks: [async (hook) => {
      callbacks.push({ type: "hook", event: hook.hook_event_name });
      return parameters.get("block") === "1"
        ? { decision: "block" as const, reason: "Browser probe blocks before inference" }
        : {};
    }] }],
  },
});
page.spike014 = {
  frames, callbacks, session, initialized: false,
  send(text: string) {
    const value: SDKUserMessage = {
      type: "user", message: { role: "user", content: text }, parent_tool_use_id: null,
      session_id: "", uuid: crypto.randomUUID(),
    };
    if (pending) { const done = pending; pending = undefined; done({ done: false, value }); }
    else queued.push(value);
  },
  interrupt: () => session.interrupt(),
  close() { closed = true; pending?.({ done: true, value: undefined }); session.close(); },
};
void session.initializationResult().then((initialization) => {
  page.spike014.initialized = true;
  page.spike014.initialization = initialization;
  render({ initialized: true, initialization, frames, callbacks });
}).catch((error: unknown) => { page.spike014.error = String(error); render({ error: String(error) }); });
void (async () => {
  try {
    for await (const frame of session) { frames.push(frame); render({ initialized: true, frames, callbacks }); }
  } catch (error) { page.spike014.error = String(error); render({ error: String(error), frames, callbacks }); }
})();

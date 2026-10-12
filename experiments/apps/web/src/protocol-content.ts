import { protocolPurposes } from "./protocol-purposes.js";

export const purposes: Record<string, string> = {
  ...protocolPurposes,
  initialize: "Identify this client and negotiate connection capabilities before other requests.",
  initialized: "Complete the documented startup choreography after initialize succeeds.",
  "server/diagnostics": "Read process-local diagnostics such as process identity and gauges.",
  "thread/start": "Create a conversation and subscribe this connection to its live events.",
  "thread/resume": "Load an existing conversation for more work; a live instance may already own its settings.",
  "thread/fork": "Branch history into a new thread ID; explicitly select the branch's policy.",
  "thread/read": "Read a conversation snapshot without making it ready for another turn.",
  "thread/list": "Page through persisted thread metadata with filters and cursors.",
  "thread/loaded/list": "List threads currently loaded into this app-server's memory.",
  "thread/turns/list": "Page through a thread's turns without loading all its history at once.",
  "thread/items/list": "Page through a turn's items for incremental history loading.",
  "thread/search": "Search persisted conversation metadata and content.",
  "thread/archive": "Move a conversation out of the active history list; this is not deletion.",
  "thread/delete": "Remove a thread; treat this as a distinct destructive lifecycle operation.",
  "thread/unsubscribe": "Detach this connection's subscription; this is not a general suspend primitive.",
  "thread/revert": "Revert conversation history; filesystem changes are a separate concern.",
  "thread/compact/start": "Ask the runtime to compact context for a conversation.",
  "thread/shellCommand": "Run an explicit shell command as thread-associated work.",
  "thread/goal/set": "Assign or change an objective and its budget for continued agent work.",
  "thread/goal/get": "Inspect the current goal and its status.",
  "thread/queue/add": "Add pending work to the thread's queue through an experimental surface.",
  "thread/tokenUsage/updated": "Observe aggregate and last-turn token accounting, including cached input.",
  "turn/start": "Submit input and begin a turn; the response acknowledges the initial turn.",
  "turn/steer": "Send additional input to the in-flight turn, guarded by expectedTurnId.",
  "turn/interrupt": "Request interruption; wait for the terminal turn event to learn the outcome.",
  "turn/settings/update": "Change running-turn settings through the experimental protocol.",
  "turn/completed": "Observe the terminal status: completed, interrupted, or failed.",
  "turn/diff/updated": "Receive an updated aggregate diff for the turn.",
  "turn/plan/updated": "Receive the runtime's structured plan and progress.",
  "item/started": "Open an input/output/tool item in the current turn.",
  "item/completed": "Receive the completed item and reconcile earlier deltas.",
  "item/agentMessage/delta": "Append assistant text to the matching thread/turn/item.",
  "item/commandExecution/requestApproval": "Ask the host to approve or reject a particular command.",
  "item/fileChange/requestApproval": "Ask whether a proposed file change may proceed.",
  "item/permissions/requestApproval": "Ask for an additional permission profile with explicit scope.",
  "item/tool/requestUserInput": "Ask structured questions for a human or host to answer.",
  "item/tool/call": "Invoke a host-provided dynamic tool and await its result.",
  "serverRequest/resolved": "Retire a host question resolved or canceled elsewhere.",
  "mcpServer/elicitation/request": "Forward an MCP server's elicitation request to the host.",
  "account/chatgptAuthTokens/refresh": "Request token refresh from an external auth host; source marks this path internal/unstable.",
  "account/read": "Read account state; choose whether a refresh is allowed.",
  "account/login/start": "Begin a login flow; completion can arrive asynchronously.",
  "account/login/cancel": "Cancel a pending login attempt.",
  "account/logout": "Clear the runtime's login; account state is shared at process/config scope.",
  "account/rateLimits/read": "Read account limits, distinct from per-thread token usage.",
  "account/usage/read": "Read account usage reporting exposed by this release.",
  "config/read": "Inspect resolved configuration and optionally its layers.",
  "configRequirements/read": "Inspect the requirements constraining configuration choices.",
  "config/value/write": "Persist a configuration change, distinct from transient thread options.",
  "config/batchWrite": "Persist a batch of configuration edits.",
  "model/list": "Discover models and capabilities available to this runtime/account.",
  "permissionProfile/list": "Discover named permission profiles.",
  "command/exec": "Run a process outside a conversation, with its own policy scope.",
  "process/spawn": "Create a process through the experimental long-lived process interface.",
  "mcpServerStatus/list": "Inspect MCP servers and their capabilities/status.",
  "mcpServer/tool/call": "Call an MCP tool directly instead of initiating an agent turn.",
  "config/mcpServer/reload": "Reload the runtime's MCP configuration.",
  "review/start": "Start a review workflow, optionally in its own conversation.",
  "fs/watch": "Register a filesystem watch that emits fs/changed events.",
  "thread/realtime/start": "Create a realtime session with a separate experimental lifecycle.",
  error: "Report an asynchronous runtime error; inspect retry state and the eventual turn result.",
};

export type MessageSummary = {
  method: string;
  description: string;
  category: string;
  paramsType: string | null;
  fields: { name: string }[];
};

export function messagePurpose(entry: Pick<MessageSummary, "method" | "description">): string {
  const purpose = purposes[entry.method] ?? entry.description.trim().split("\n")[0];
  if (!purpose?.trim()) throw new Error(`Missing method-specific summary for ${entry.method}`);
  return purpose;
}

export function matchesMessageQuery(entry: MessageSummary, query: string): boolean {
  const text = `${entry.method} ${entry.description} ${entry.category} ${messagePurpose(entry)} ${entry.paramsType ?? ""} ${entry.fields.map((field) => field.name).join(" ")}`.toLowerCase();
  return text.includes(query.trim().toLowerCase());
}


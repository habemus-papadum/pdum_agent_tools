import "./style.css";
import { matchesMessageQuery, messagePurpose } from "./protocol-content.js";

type Field = { name: string; type: string; description: string; required?: boolean; experimentalOnly?: boolean };
type ProtocolEntry = {
  method: string;
  kind: string;
  category: string;
  description: string;
  gate: string;
  paramsType: string | null;
  fields: Field[];
  variants: { type: string; fields: string[]; required: string[]; description: string }[];
  responseType: string | null;
  responseFields: Field[];
  sourceUrl: string | null;
};
type Inventory = {
  version: string;
  sourceRevision: string;
  generatedAt: string;
  counts: Record<string, { stable: number; full: number }>;
  inventory: ProtocolEntry[];
};

const revision = "6c372fbef45f730b6d8aa727b0ec8332365588db";
const source = (path: string) => `https://github.com/openai/codex/blob/${revision}/codex-rs/${path}`;
const docs = "https://learn.chatgpt.com/docs/app-server";
const kindLabels: Record<string, string> = {
  ClientRequest: "Client request",
  ClientNotification: "Client notification",
  ServerRequest: "Server request",
  ServerNotification: "Server notification",
};
const categoryNotes: Record<string, string> = {
  "Connection & diagnostics": "Connection setup, runtime diagnostics, warnings, and feedback.",
  "Threads & history": "Create, load, branch, inspect, and organize conversations; follow lifecycle events.",
  "Turns & items": "Start and steer work; inspect messages, tool execution, plans, diffs, and progress.",
  "Goals & queues": "Objectives and pending work; distinguish continued work from idle state.",
  "Projects & organization": "Project metadata, sections, attachments, and their lifecycle.",
  "Approvals & callbacks": "Codex needs a host answer. Respond using the server's request ID.",
  "Account & auth": "Login and account state, usage, rate limits, and provider authentication.",
  "Tools & extensions": "MCP, apps, skills, plugins, hooks, and their discovery and configuration.",
  "Host & filesystem": "Commands, processes, files, watches, search, and environment connections.",
  "Configuration & discovery": "Configuration, requirements, models, permission profiles, and feature discovery.",
  "Remote & verification": "Remote-control connections, pairing, clients, and native verification flows.",
  "Memory & storage": "Memory state and rollout maintenance; these methods are not storage adapters.",
  Realtime: "Realtime sessions, text/audio inputs, transcripts, audio outputs, and completion.",
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing application root");
app.innerHTML = `
<a class="skip-link" href="#overview">Skip to guide</a>
<aside class="rail" aria-label="Guide navigation">
  <a href="#overview" class="wordmark"><span class="brand-icon">a<span>↗</span></span><span>agent-spike<small>ENGINEERING FIELD NOTES</small></span></a>
  <div class="rail-label">FIELD GUIDE <span>007</span></div>
  <nav>${[["overview", "The mental model"], ["messages", "Messages on the wire"], ["architecture", "SDK boundaries"], ["choreography", "A turn, end to end"], ["edges", "Design constraints"], ["reference", "Protocol explorer"], ["evidence", "Evidence & sources"]].map(([anchor, title], index) => `<a href="#${anchor}"><span>0${index + 1}</span>${title}</a>`).join("")}</nav>
  <div class="rail-bottom"><span class="status-dot"></span> Codex 0.162.1<br><span>Inspected 12 October 2026</span><a href="${docs}" target="_blank" rel="noreferrer">Official protocol docs ↗</a></div>
</aside>
<main class="page">
  <header class="topbar"><span>RESEARCH / CODEX APP-SERVER</span><a href="#reference">Open protocol explorer ↗</a></header>
  <section id="overview" class="hero">
    <div class="eyebrow"><span class="status-dot"></span> ARCHITECTURE NOTE <span class="eyebrow-divider">/</span> 5 MINUTE READ</div>
    <h1>Codex, behind<br>the terminal.</h1>
    <p class="lede">A guide to the app-server protocol—and the boundaries of a small SDK for controlling an agent runtime.</p>
    <div class="hero-actions"><a class="button primary" href="#architecture">Explore the architecture <span>↓</span></a><a class="button secondary" href="#reference">Browse all messages <span>↗</span></a></div>
    <div class="hero-insight"><span class="insight-mark">↔</span><div><strong>The connection carries a conversation in both directions.</strong><p>You send commands and receive progress. Codex can also ask your application for approvals, tool results, or user input while a turn is running.</p></div></div>
    <div class="stat-row"><div><strong id="request-count">170</strong><span>client requests</span></div><div><strong id="callback-count">11</strong><span>server callbacks</span></div><div><strong id="event-count">84</strong><span>server notifications</span></div><div><strong>1</strong><span>client notification</span></div></div>
    <p class="caption">Generated from the installed binary’s schema, including experimental surfaces. Counts describe the inventory, not tested feature availability.</p>
  </section>
  <section id="messages" class="guide-section">
    <div class="section-heading"><span class="section-number">02</span><div><p class="eyebrow">THE WIRE CONTRACT</p><h2>Three shapes. Both directions.</h2></div></div>
    <p>Requests have a method and an ID. Responses echo that ID with a result or error. Notifications have no ID and expect no answer. Dispatch on <code>method</code> before treating an incoming ID as a reply: it may be a request from Codex.</p>
    <div class="message-grid">
      <article class="message-card"><span class="direction client">APP → CODEX</span><h3>Request</h3><code>{ id, method, params }</code><p>Start a thread, steer a turn, inspect configuration.</p><small>Example: <b>turn/start</b></small></article>
      <article class="message-card"><span class="direction server">CODEX → APP</span><h3>Response</h3><code>{ id, result | error }</code><p>Resolve one pending client request.</p><small>An acknowledgment may precede all agent work.</small></article>
      <article class="message-card"><span class="direction server">CODEX → APP</span><h3>Notification</h3><code>{ method, params }</code><p>Stream lifecycle events, text, tool progress, and usage.</p><small>Example: <b>item/agentMessage/delta</b></small></article>
      <article class="message-card"><span class="direction server">CODEX → APP → CODEX</span><h3>Server request + answer</h3><code>{ id, method, params }<br>↳ { id, result | error }</code><p>Handle a question or tool call, then echo the server’s ID.</p></article>
    </div>
    <p class="margin-note"><strong>One client notification:</strong> send <code>initialized</code> after <code>initialize</code> succeeds. The envelope omits <code>jsonrpc: "2.0"</code>. <a href="${source("app-server-protocol/src/rpc.rs")}" target="_blank" rel="noreferrer">Wire types ↗</a></p>
  </section>
  <section id="architecture" class="guide-section">
    <div class="section-heading"><span class="section-number">03</span><div><p class="eyebrow">PROPOSED SDK SHAPE</p><h2>Separate the process from the protocol.</h2></div></div>
    <p>The Node launcher owns a local child process. Everything above the connection should also work when the process lives elsewhere. A <strong>thread</strong> contains <strong>turns</strong>; each turn contains <strong>items</strong>.</p>
    <div class="architecture" aria-label="Proposed SDK boundaries">
      <div class="launch-row"><div><span class="layer-kicker">OPTIONAL · NODE ONLY</span><strong>Process launcher</strong><span>binary · argv · env · stderr · exit</span></div><span class="launch-join">or connect remotely →</span></div>
      <div class="connection-layer"><div><span class="layer-kicker">SHARED FOUNDATION</span><strong>Connection & RPC engine</strong></div><span>framing · IDs · handshake · routing · backpressure</span><div class="transport-chips"><code>stdio</code><code>WebSocket</code><code>Unix socket</code></div></div>
      <div class="domain-layers">
        <div><span class="layer-kicker">SERVER SCOPE</span><h3>Admin & discovery</h3><p>Account, models, config, requirements, diagnostics.</p><code>account/read<br>config/read<br>model/list</code></div>
        <div><span class="layer-kicker">REGISTRY SCOPE</span><h3>Threads & history</h3><p>Create, find, load, fork, archive, subscribe.</p><code>thread/start<br>thread/resume<br>thread/list</code></div>
        <div><span class="layer-kicker">ONE THREAD</span><h3>Interactive session</h3><p>Run, steer, interrupt; assemble turns and items.</p><code>turn/start<br>turn/steer<br>turn/interrupt</code></div>
      </div>
      <div class="crosscut"><strong>Across every layer</strong><span>Host callbacks</span><span>Event reduction</span><span>Recording & recovery</span></div>
    </div>
    <details class="deep-dive"><summary>What each layer owns <span>6 design boundaries</span></summary><div class="detail-body"><dl class="ownership-list">
      <div><dt>Launcher</dt><dd>Resolve and fingerprint the binary, isolate its config/environment, launch or stop it, and retain stderr. A future distribution layer can pin binaries with DotSlash, as Codex does; this spike does not implement packaging. The launcher produces a transport; domain APIs do not import Node process primitives.</dd></div>
      <div><dt>Connection</dt><dd>Frame messages, maintain request IDs and timeouts, route server requests separately, negotiate capabilities, and reject pending calls on disconnect. Use distinct namespaces for outgoing calls and incoming host callbacks.</dd></div>
      <div><dt>Admin</dt><dd>Expose account, config, requirements, model/tool discovery, and diagnostics. Distinguish connected, initialized, authenticated, and ready for this model. HTTP <code>/readyz</code> and <code>/healthz</code> belong to a WebSocket listener and both return unconditional 200 responses in the pinned source: listener liveness, not auth/model readiness. Experimental <code>server/diagnostics</code> is not a universal health check.</dd></div>
      <div><dt>Registry</dt><dd>Track known and loaded threads, cursor-based history, subscriptions, and lifecycle. Reading history is different from loading a runtime. Preserve explicit thread policy when creating branches.</dd></div>
      <div><dt>Thread handle</dt><dd>Own the active turn ID, input queue, item map, and scoped events. A <code>turn/start</code> reply gives an initial turn, not the finished answer. Check <code>turn/completed</code> and its status.</dd></div>
      <div><dt>Callbacks + reducer</dt><dd>Adapt human questions, approvals, and dynamic tools to the product. Reduce events into shared state independently of UI rendering. Journal direction, IDs, timestamps, and lifecycle; distinguish durable history from transient deltas.</dd></div>
    </dl><p class="caption">These are proposed boundaries, not an SDK implemented by this spike. <a href="${source("app-server-protocol/src/protocol/common.rs")}" target="_blank" rel="noreferrer">RPC definitions ↗</a></p></div></details>
  </section>
  <section id="choreography" class="guide-section">
    <div class="section-heading"><span class="section-number">04</span><div><p class="eyebrow">FOLLOW ONE TURN</p><h2>Acknowledged is not completed.</h2></div></div>
    <p>Initialize each connection once. Create or resume a thread, then start work. Keep reading while handling callbacks; waiting for a turn before reading its approval request can deadlock your application.</p>
    <div class="walkthrough"><div class="step-list" role="group" aria-label="Select protocol step" id="step-list"></div><div class="wire-preview"><div class="preview-heading"><span id="step-direction"></span><span>ABRIDGED WIRE SHAPES</span></div><h3 id="step-title"></h3><p id="step-description"></p><pre id="step-code" tabindex="0"></pre></div></div>
    <div class="id-strip"><span><code>id</code> request correlation</span><span><code>threadId</code> conversation</span><span><code>turnId</code> unit of work</span><span><code>itemId</code> streamed object</span></div>
  </section>
  <section id="edges" class="guide-section">
    <div class="section-heading"><span class="section-number">05</span><div><p class="eyebrow">WHERE THE DESIGN GETS INTERESTING</p><h2>Make scope and uncertainty explicit.</h2></div></div>
    <div class="constraint-grid">
      <article><span class="constraint-icon">↳</span><h3>Policy has several scopes.</h3><p>Process defaults, loaded thread state, and per-turn changes interact. A second client can change a shared thread. Fork, resume, and <code>command/exec</code> each need deliberate policy handling.</p></article>
      <article><span class="constraint-icon">⇄</span><h3>A connection is not a session.</h3><p>Transport loss does not tell you whether a request took effect. Reconnect, initialize, inspect state, and resume deliberately. Do not blindly replay a mutation after a timeout.</p></article>
      <article><span class="constraint-icon">≋</span><h3>Events need a reducer.</h3><p>Several threads share a stream. Route by IDs, append deltas, reconcile completed items, and bound queues. Keep the receive loop fast; render and record behind it.</p></article>
      <article><span class="constraint-icon">◷</span><h3>Idle is a lifecycle decision.</h3><p>An ended turn can coexist with background processes, queued work, or a goal. Unsubscribe, interrupt, archive, and process shutdown differ. “Safe to sleep” needs its own policy.</p></article>
    </div>
    <details class="deep-dive"><summary>Transport, errors, and version drift <span>Operational details</span></summary><div class="detail-body"><div class="two-columns">
      <div><h3>Transport boundaries</h3><p>Stdio is newline-delimited JSON. WebSocket carries one JSON-RPC message per text message; fragmentation into frames is a transport detail. Unix listeners carry WebSocket over an HTTP Upgrade, not raw JSON lines. Keep diagnostic stderr separate from protocol stdout.</p><p>The pinned listener rejects every <code>Origin</code> header with HTTP 403. A browser cannot directly connect using its native WebSocket API; use a trusted host bridge. Transport-independent domain APIs do not imply direct browser-to-process access.</p><p>Client transport and outbound model traffic are independent. Spike 004 captured a live model response over WSS and verified both SSE and WebSocket fixtures through a spawned child. Choosing WebSocket for the client does not choose the model transport.</p><p>Listener authentication protects access to the process; account authentication pays for inference. They are separate credentials and states.</p></div>
      <div><h3>Failure boundaries</h3><p>A response <code>error</code> rejects one call. An <code>error</code> notification can describe an asynchronous problem or retry. The terminal turn has its own status/error. Process exit is another channel.</p><p>WebSocket ingress overload returns <code>-32001</code>. Back off with jitter for rejected calls; an ambiguous disconnect needs reconciliation. Respect write/drain backpressure, cap pending calls, and avoid unbounded capture buffers.</p><p>Experimental methods and fields require <code>initialize.capabilities.experimentalApi</code>. Schema presence is not a support or entitlement guarantee. Pin binary + schemas; compare method lists and field shapes on upgrades.</p></div>
    </div><p class="caption"><a href="${docs}#protocol" target="_blank" rel="noreferrer">Transport contract ↗</a> · <a href="${source("app-server-transport/src/transport/websocket.rs")}" target="_blank" rel="noreferrer">Listener security & health ↗</a> · <a href="${source("app-server/src/transport.rs")}" target="_blank" rel="noreferrer">Outbound gating ↗</a> · <a href="${source("app-server/src/message_processor.rs")}" target="_blank" rel="noreferrer">Dispatch ↗</a></p></div></details>
    <details class="deep-dive"><summary>Authentication, persistence, and full access <span>Related investigations</span></summary><div class="detail-body">
      <h3>Separate auth from runtime state</h3><p>One process has shared account/configuration state. Spike 005 exercised browser-login start/cancel, file-backed API-key replacement, and a custom-provider auth command that refreshed between turns. Native Codex workload identity also exists, with a ChatGPT/Codex federation flow distinct from API WIF; no real federation exchange was tested. The external <code>chatgptAuthTokens</code> source contract is internal/unstable.</p>
      <h3>Storage has an internal extension point</h3><p><code>ThreadStore</code> is a storage-neutral Rust trait. Stock configuration selects local or test in-memory storage; it does not ship a general remote database adapter. A simulated conversation survived restart/resume/fork using the normal local store. Experimental <code>thread/resume.history</code> imported raw history, but its source contract is cloud-specific, not a general persistence callback.</p>
      <h3>Effective policy changes across versions</h3><p>Spike 006 found that installed <strong>0.162.1</strong> reverted to the process’s read-only default on cold resume when sandbox was omitted. The newer source build preserved full access. Both showed fork fallback and shared-client turn mutations. Warm resume did not replace settings for the tested loaded thread with another subscriber; this is not a claim about every warm resume. <code>command/exec</code> used process policy independently. Supply and verify policy at lifecycle boundaries.</p><p>The root CLI’s bypass flag did not configure the app-server’s policy in those probes. Set app-server config explicitly. Also distinguish <code>thread/start.sandbox</code> from <code>turn/start.sandboxPolicy</code>: the wrong field was silently ignored.</p>
      <p class="caption">Version-specific details are in repository spike summaries 004–006. <a href="${source("login/src/auth/workload_identity.rs")}" target="_blank" rel="noreferrer">Native WIF ↗</a> · <a href="${source("thread-store/src/store.rs")}" target="_blank" rel="noreferrer">ThreadStore ↗</a> · <a href="${source("app-server-protocol/src/protocol/v2/thread.rs")}" target="_blank" rel="noreferrer">Thread types ↗</a></p>
    </div></details>
  </section>
  <section id="reference" class="guide-section reference-section">
    <div class="section-heading"><span class="section-number">06</span><div><p class="eyebrow">THE COMPLETE NAMED SURFACE</p><h2>Protocol explorer<span class="count-tag" id="inventory-count">266</span></h2></div></div>
    <p>Search a method, field, or category. Expand a row for parameter and result shapes. Categories are editorial; names and fields are generated from the binary.</p>
    <div class="explorer-controls"><label class="search-field"><span>⌕</span><input id="search" type="search" placeholder="Search methods, parameters, or concepts…" aria-label="Search protocol inventory"></label><div class="filter-row"><label>Kind<select id="kind-filter"><option value="">All message kinds</option>${Object.entries(kindLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label><label>Category<select id="category-filter"><option value="">All categories</option>${Object.keys(categoryNotes).sort().map((category) => `<option>${escapeHtml(category)}</option>`).join("")}</select></label><label>Surface<select id="gate-filter"><option value="">All surfaces</option><option value="stable export">Stable export</option><option value="experimental export">Experimental export</option><option value="source experimental">Source experimental</option></select></label></div></div>
    <div class="reference-meta"><p id="result-count" aria-live="polite">Loading inventory…</p><button class="text-button" id="reset-filters" type="button">Reset filters</button></div>
    <p class="caption surface-note"><strong>Read the badges carefully.</strong> “Experimental export” is absent from the default schema. “Source experimental” has a gate in the pinned source, even when exported by default. Fields can also be experimental. The source revision and installed release can differ.</p>
    <div id="inventory-results"></div>
  </section>
  <section id="evidence" class="guide-section evidence-section">
    <div class="section-heading"><span class="section-number">07</span><div><p class="eyebrow">HOW TO READ THESE FINDINGS</p><h2>A map, with provenance.</h2></div></div>
    <div class="evidence-grid"><article><span class="evidence-label observed">GENERATED / OBSERVED</span><p><strong>Codex 0.162.1</strong> exported stable and experimental schemas. Related probes exercised initialization, account/history isolation, command execution, capture, auth, persistence, and policy. Exporting a schema does not exercise every method.</p></article><article><span class="evidence-label inspected">SOURCE-INSPECTED</span><p>Envelopes, dispatch, gates, and internal interfaces are linked to <code>${revision.slice(0, 12)}</code>. The diagram proposes SDK boundaries; this spike does not implement that SDK.</p></article></div>
    <div class="source-links"><a href="${docs}" target="_blank" rel="noreferrer">Official documentation ↗</a><a href="${source("app-server-protocol/src/protocol/common.rs")}" target="_blank" rel="noreferrer">Pinned RPC definitions ↗</a><a href="${import.meta.env.BASE_URL}protocol-inventory.json" download>Download inventory ↓</a></div>
    <details class="deep-dive"><summary>Reproduce this guide <span>Local commands</span></summary><div class="detail-body"><pre>pnpm --filter @agent-spike/007-codex-protocol-guide generate
pnpm --filter @agent-spike/web dev --host 127.0.0.1
pnpm --filter @agent-spike/web build</pre><p>The generator defaults to <code>~/.local/bin/codex</code>; set <code>SPIKE_CODEX_BIN</code> for another explicit binary. It isolates schema generation, fingerprints the executable, and writes both schema surfaces under <code>artifacts/007-codex-protocol-guide/</code>. Upgrading the schemas does not automatically update the narrative conclusions.</p><p class="caption" id="generated-metadata"></p></div></details>
  </section>
  <footer><span>agent-spike</span><span>Understand the runtime. Then design the interface.</span><a href="#overview">Back to top ↑</a></footer>
</main>`;

const steps = [
  { title: "Initialize the connection", direction: "APP → CODEX → APP", description: "Identify the client, negotiate capabilities, and wait for the response. These are abridged examples, not a complete executable transcript.", messages: [{ id: "c1", method: "initialize", params: { clientInfo: { name: "agent_spike", version: "0.0.0" }, capabilities: { experimentalApi: true } } }, { id: "c1", result: { userAgent: "codex/…" } }, { method: "initialized" }] },
  { title: "Create a thread", direction: "APP → CODEX → APP", description: "Save the returned thread ID. This connection is subscribed to the thread’s events. The later callback example assumes a dynamic tool was registered here.", messages: [{ id: "c2", method: "thread/start", params: { cwd: "/work/experiment", approvalPolicy: "never", sandbox: "read-only" } }, { id: "c2", result: { thread: { id: "thr_1" } } }] },
  { title: "Start a turn", direction: "APP → CODEX → APP", description: "The reply contains an initial turn. Notifications carry the work that happens afterward.", messages: [{ id: "c3", method: "turn/start", params: { threadId: "thr_1", input: [{ type: "text", text: "Explain this circuit." }] } }, { id: "c3", result: { turn: { id: "turn_1", status: "inProgress" } } }] },
  { title: "Reduce streamed items", direction: "CODEX → APP", description: "Route by item, turn, and thread. Multiple threads may interleave on one connection.", messages: [{ method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "The feedback network…" } }] },
  { title: "Answer a host callback", direction: "CODEX → APP → CODEX", description: "Return a result using the server’s request ID. Dynamic-tool registration requires experimental fields; an approval request follows the same envelope pattern.", messages: [{ id: "s1", method: "item/tool/call", params: { threadId: "thr_1", turnId: "turn_1", callId: "call_1", tool: "show_diagram", arguments: { circuit: "example" } } }, { id: "s1", result: { success: true, contentItems: [{ type: "inputText", text: "Diagram displayed." }] } }] },
  { title: "Steer or interrupt", direction: "APP → CODEX", description: "Guard steering with the expected active turn. Interruption is a separate request and does not itself prove completion.", messages: [{ id: "c4", method: "turn/steer", params: { threadId: "thr_1", expectedTurnId: "turn_1", input: [{ type: "text", text: "Focus on stability." }] } }] },
  { title: "Observe the outcome", direction: "CODEX → APP", description: "A turn can complete, fail, or be interrupted. Reconcile items before deciding whether the agent can sleep.", messages: [{ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed", items: [] } } }] },
];
const stepList = requiredElement("#step-list");
stepList.innerHTML = steps.map((step, index) => `<button type="button" class="step-button" data-step="${index}" aria-pressed="false"><span>${String(index + 1).padStart(2, "0")}</span>${step.title}<b>→</b></button>`).join("");
stepList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-step]");
  if (button) selectStep(Number(button.dataset.step));
});
selectStep(0);

const search = requiredElement<HTMLInputElement>("#search");
const kindFilter = requiredElement<HTMLSelectElement>("#kind-filter");
const categoryFilter = requiredElement<HTMLSelectElement>("#category-filter");
const gateFilter = requiredElement<HTMLSelectElement>("#gate-filter");
let inventory: Inventory | undefined;
for (const input of [search, kindFilter, categoryFilter, gateFilter]) input.addEventListener("input", renderInventory);
requiredElement("#reset-filters").addEventListener("click", () => {
  search.value = "";
  kindFilter.value = "";
  categoryFilter.value = "";
  gateFilter.value = "";
  renderInventory();
});
fetch(`${import.meta.env.BASE_URL}protocol-inventory.json`).then(async (response) => {
  if (!response.ok) throw new Error(`Inventory request failed (${response.status})`);
  inventory = await response.json() as Inventory;
  for (const entry of inventory.inventory) messagePurpose(entry);
  requiredElement("#inventory-count").textContent = String(inventory.inventory.length);
  requiredElement("#request-count").textContent = String(inventory.counts.ClientRequest?.full ?? 0);
  requiredElement("#callback-count").textContent = String(inventory.counts.ServerRequest?.full ?? 0);
  requiredElement("#event-count").textContent = String(inventory.counts.ServerNotification?.full ?? 0);
  requiredElement("#generated-metadata").textContent = `${inventory.version} · Generated ${inventory.generatedAt.slice(0, 10)} · Source ${inventory.sourceRevision}`;
  renderInventory();
}).catch(() => { requiredElement("#result-count").textContent = "Inventory could not be loaded. Run the generator, then reload."; });

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    document.querySelectorAll(".rail nav a").forEach((link) => {
      if (link.getAttribute("href") === `#${entry.target.id}`) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }
}, { rootMargin: "-10% 0px -70% 0px" });
document.querySelectorAll("section[id]").forEach((section) => observer.observe(section));

function selectStep(index: number): void {
  const step = steps[index];
  if (!step) return;
  stepList.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.step) === index)));
  requiredElement("#step-direction").textContent = step.direction;
  requiredElement("#step-title").textContent = step.title;
  requiredElement("#step-description").textContent = step.description;
  requiredElement("#step-code").textContent = step.messages.map((message) => JSON.stringify(message, null, 2)).join("\n\n");
}

function renderInventory(): void {
  if (!inventory) return;
  const query = search.value.trim().toLowerCase();
  const filtered = inventory.inventory.filter((entry) => {
    return matchesMessageQuery(entry, query) && (!kindFilter.value || entry.kind === kindFilter.value) && (!categoryFilter.value || entry.category === categoryFilter.value) && (!gateFilter.value || entry.gate === gateFilter.value);
  });
  requiredElement("#result-count").textContent = `${filtered.length} of ${inventory.inventory.length} named messages`;
  const grouped = Map.groupBy(filtered, (entry) => entry.category);
  requiredElement("#inventory-results").innerHTML = filtered.length === 0
    ? '<div class="empty-state"><strong>No matching messages.</strong><p>Try thread/, a field such as threadId, or clear the filters.</p></div>'
    : [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([category, entries]) => `<div class="inventory-group"><div class="group-heading"><h3>${escapeHtml(category)} <span>${entries.length}</span></h3><p>${escapeHtml(categoryNotes[category] ?? "")}</p></div>${entries.map(renderEntry).join("")}</div>`).join("");
}

function renderEntry(entry: ProtocolEntry): string {
  const purpose = messagePurpose(entry);
  return `<details class="method-row"><summary><span class="method-name"><code>${escapeHtml(entry.method)}</code><span>${escapeHtml(purpose)}</span></span><span class="method-badges"><span class="kind-badge">${escapeHtml(kindLabels[entry.kind] ?? entry.kind)}</span><span class="gate-badge ${entry.gate === "stable export" ? "stable" : "experimental"}">${escapeHtml(entry.gate)}</span></span></summary><div class="method-body"><p class="method-direction">${entry.kind.startsWith("Client") ? "Application → Codex" : "Codex → application"}${entry.kind.endsWith("Request") ? " · Expects a response with the same ID" : " · No response expected"}</p>${entry.description && entry.description !== purpose ? `<p class="schema-description">${escapeHtml(entry.description)}</p>` : ""}<h4>Parameters ${entry.paramsType ? `<code>${escapeHtml(entry.paramsType)}</code>` : ""}</h4>${fieldTable(entry.fields)}${entry.variants.length ? `<h4>Payload variants</h4><div class="variant-list">${entry.variants.map((variant) => `<p><code>${escapeHtml(variant.type)}</code><span>${escapeHtml(variant.fields.join(", ") || "No fields")}</span>${variant.description ? `<small>${escapeHtml(variant.description)}</small>` : ""}</p>`).join("")}</div>` : ""}${entry.responseType ? `<h4>Result <code>${escapeHtml(entry.responseType)}</code></h4>${fieldTable(entry.responseFields)}` : ""}<p class="caption">${entry.sourceUrl ? `<a href="${entry.sourceUrl}" target="_blank" rel="noreferrer">Pinned source ↗</a> · ` : ""}Fields come from the installed release; nested type names are references, not full recursive schemas.</p></div></details>`;
}

function fieldTable(fields: Field[]): string {
  if (!fields.length) return '<p class="no-fields">No top-level object fields. Check variants when present.</p>';
  return `<div class="table-scroll"><table class="field-table"><thead><tr><th>Field</th><th>Shape</th><th>Notes</th></tr></thead><tbody>${fields.map((field) => `<tr><td><code>${escapeHtml(field.name)}</code>${field.required ? '<small class="required-field">required</small>' : ""}${field.experimentalOnly ? '<small class="experimental-field">experimental field</small>' : ""}</td><td><code>${escapeHtml(field.type)}</code></td><td>${escapeHtml(field.description || "—")}</td></tr>`).join("")}</tbody></table></div>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function requiredElement<ElementType extends HTMLElement = HTMLElement>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

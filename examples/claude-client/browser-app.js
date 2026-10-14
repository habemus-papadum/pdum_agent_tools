import { query } from "@anthropic-ai/claude-agent-sdk/browser";
import { api, InputQueue } from "./common.js";

/** A small UI over public management operations and the official browser Query. */
export function createBrowserClient() {
  const element = id => document.getElementById(id);
  const baseUrl = location.origin;
  const state = {
    profiles: [], selected: null, active: null, loading: false, probeRunning: false,
    historyRequest: 0, sessions: [], messages: new Map(), lastAssistant: null,
    cancelCallbacks: new Set(),
  };
  const profileId = () => element("profile").value;
  const historyPath = id => `/api/profiles/${encodeURIComponent(profileId())}/sessions${id ? `/${encodeURIComponent(id)}` : ""}`;

  function error(value) {
    element("error").hidden = !value;
    element("error").textContent = value ? String(value.message ?? value) : "";
  }
  function status(text, kind = "idle") {
    element("connection").textContent = text;
    element("connection").dataset.state = kind;
  }
  function event(text) {
    const entry = document.createElement("li");
    entry.textContent = `${new Date().toLocaleTimeString()} · ${text}`;
    element("event-list").append(entry);
  }
  function updateControls() {
    const active = state.active;
    const locked = state.loading || state.probeRunning;
    const configured = state.profiles.length > 0;
    const ready = active?.initialized && !active.closing;
    element("profile").disabled = locked || Boolean(active) || !configured;
    element("new").disabled = locked || Boolean(active) || !configured;
    element("refresh").disabled = locked;
    for (const id of ["resume", "fork", "rename"]) element(id).disabled = locked || Boolean(active) || !state.selected;
    for (const id of ["rename-title", "rename-save"]) element(id).disabled = locked || Boolean(active) || !state.selected;
    if (active || !state.selected) element("rename-form").hidden = true;
    element("end").disabled = !active || active.closing;
    element("interrupt").disabled = !ready || !active.busy;
    // A saved transcript must be explicitly resumed or forked before sending.
    const writable = configured && !locked && (active ? ready && !active.busy : !state.selected);
    element("prompt").disabled = !writable;
    element("send").disabled = !writable || !element("prompt").value.trim();
    for (const id of ["initialize", "live"]) element(id).disabled = locked || Boolean(active) || !configured;
    for (const button of element("sessions").querySelectorAll("button")) button.disabled = locked || Boolean(active);
  }
  function clearMessages() {
    element("messages").replaceChildren();
    state.messages.clear();
    state.lastAssistant = null;
    element("usage").textContent = "";
  }
  function detail(parent, title, value) {
    const disclosure = document.createElement("details");
    const summary = document.createElement("summary");
    const content = document.createElement("pre");
    summary.textContent = title;
    content.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    disclosure.append(summary, content);
    parent.append(disclosure);
  }
  function renderContent(parent, content) {
    parent.replaceChildren();
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
    for (const block of blocks) {
      if (block.type === "text") {
        const text = document.createElement("div");
        text.className = "text";
        text.textContent = block.text;
        parent.append(text);
      } else if (block.type === "tool_use") detail(parent, `Tool · ${block.name}`, block.input);
      else if (block.type === "tool_result") detail(parent, block.is_error ? "Tool error" : "Tool result", block.content);
      else if (block.type === "thinking") detail(parent, "Thinking", block.thinking);
      else if (block.type === "image") detail(parent, "Image", "Image content is retained in history; this example has no image viewer.");
      else detail(parent, block.type ?? "Content", block);
    }
  }
  function message(role, content, id = crypto.randomUUID()) {
    element("empty")?.remove();
    let entry = state.messages.get(id);
    if (!entry) {
      const article = document.createElement("article");
      const label = document.createElement("strong");
      const body = document.createElement("div");
      article.className = "message";
      article.dataset.role = role;
      label.textContent = role === "assistant" ? "Claude" : role === "user" ? "You" : role;
      article.append(label, body);
      element("messages").append(article);
      entry = { article, body, id };
      state.messages.set(id, entry);
    }
    renderContent(entry.body, content);
    if (role === "assistant") state.lastAssistant = entry;
    return entry;
  }
  function renderSessions() {
    element("sessions").replaceChildren();
    for (const session of state.sessions) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const title = document.createElement("span");
      const date = document.createElement("small");
      title.className = "session-title";
      title.textContent = session.custom_title || session.summary || session.first_prompt || session.session_id;
      date.textContent = session.last_modified ? new Date(session.last_modified).toLocaleString() : session.session_id;
      button.setAttribute("aria-current", String(session.session_id === state.selected?.session_id));
      button.dataset.sessionId = session.session_id;
      button.append(title, date);
      button.addEventListener("click", () => void action(() => selectSession(session.session_id)));
      item.append(button);
      element("sessions").append(item);
    }
    updateControls();
  }
  async function refreshSessions() {
    const request = ++state.historyRequest;
    const path = historyPath();
    element("history-state").textContent = "Loading saved conversations…";
    try {
      const sessions = await api(baseUrl, path);
      if (request !== state.historyRequest) return;
      state.sessions = sessions.sort((a, b) => b.last_modified - a.last_modified);
      const selected = sessions.find(session => session.session_id === state.selected?.session_id);
      if (selected) {
        state.selected = selected;
        element("conversation-title").textContent = selected.custom_title || selected.summary || "Conversation";
      }
      element("history-state").textContent = sessions.length ? `${sessions.length} saved` : "No saved conversations yet.";
      renderSessions();
    } catch (cause) {
      if (request !== state.historyRequest) return;
      element("history-state").textContent = "Could not load saved conversations.";
      throw cause;
    }
  }
  function selectedTitle(info) {
    element("conversation-title").textContent = info?.custom_title || info?.summary || "New conversation";
    element("conversation-detail").textContent = info?.session_id || "Send your first message to begin.";
  }
  async function selectSession(id) {
    const saved = await api(baseUrl, historyPath(id));
    state.selected = saved.info;
    element("rename-form").hidden = true;
    clearMessages();
    for (const frame of saved.messages) message(frame.type, frame.message.content, frame.uuid);
    selectedTitle(saved.info);
    status("Saved history · no worker running");
    renderSessions();
  }
  async function action(operation) {
    if (state.loading || state.probeRunning) return;
    state.loading = true;
    error(null);
    updateControls();
    try { await operation(); }
    catch (cause) {
      error(cause);
      if (!state.profiles.length) status("Manager unavailable · refresh to retry");
    }
    finally { state.loading = false; updateControls(); }
  }

  // The SDK routes these callbacks and writes their answers over its own transport.
  // No management endpoint accepts or interprets conversation control messages.
  async function permission(toolName, input, { signal }) {
    if (signal.aborted) return { behavior: "deny", message: "Request cancelled" };
    if (toolName === "AskUserQuestion") {
      event("AskUserQuestion forms are not supported by this example; cancelled. Reply in chat instead.");
      return { behavior: "deny", message: "This client cannot render AskUserQuestion. Ask in chat so the operator can reply." };
    }
    return new Promise(resolve => {
      const card = document.createElement("div");
      card.className = "callback";
      const title = document.createElement("h2");
      title.textContent = `Claude requests ${toolName}`;
      card.append(title);
      detail(card, "Tool input", input);
      const buttons = document.createElement("div");
      buttons.className = "row";
      const finish = answer => {
        signal.removeEventListener("abort", cancel);
        state.cancelCallbacks.delete(cancel);
        card.remove();
        resolve(answer);
      };
      const cancel = () => finish({ behavior: "deny", message: "Request cancelled" });
      state.cancelCallbacks.add(cancel);
      for (const [label, answer] of [
        ["Allow once", { behavior: "allow", updatedInput: input }],
        ["Deny", { behavior: "deny", message: "The operator declined this request" }],
      ]) {
        const button = document.createElement("button");
        button.textContent = label;
        button.addEventListener("click", () => finish(answer), { once: true });
        buttons.append(button);
      }
      card.append(buttons);
      element("callbacks").append(card);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  function frameReceived(active, frame) {
    if (state.active !== active) return;
    if (frame.type === "stream_event" && !frame.parent_tool_use_id) {
      const update = frame.event;
      if (update.type === "message_start") active.partial = { id: update.message.id, text: "" };
      if (update.type === "content_block_delta" && update.delta.type === "text_delta") {
        active.partial ??= { id: `stream-${crypto.randomUUID()}`, text: "" };
        active.partial.text += update.delta.text;
        message("assistant", active.partial.text, active.partial.id);
      }
    } else if (frame.type === "assistant" && !frame.parent_tool_use_id) {
      // Final SDK messages replace their displayed partial without duplicating text.
      const partial = active.partial && state.messages.get(active.partial.id);
      if (partial) { partial.article.remove(); state.messages.delete(active.partial.id); }
      active.partial = null;
      message("assistant", frame.message.content, frame.uuid);
    } else if (frame.type === "user" && !frame.parent_tool_use_id) {
      if (frame.uuid === active.submittedId || state.messages.has(frame.uuid)) return;
      message("user", frame.message.content, frame.uuid);
    } else if (frame.type === "result") {
      active.busy = false;
      if (frame.is_error || frame.subtype !== "success") error(frame.errors?.join("\n") || `Turn ended: ${frame.subtype}`);
      else if (!state.lastAssistant && frame.result) message("assistant", frame.result);
      const cost = frame.total_cost_usd;
      element("usage").textContent = Number.isFinite(cost) ? `Conversation estimate: $${cost.toFixed(6)}` : "Usage estimate unavailable";
      element("usage").title = "SDK cumulative conversation estimate, including prior turns on resume; not subscription billing.";
      status("Connected · ready", "ready");
      event(`Turn ended: ${frame.subtype}`);
      void refreshSessions().catch(error);
      updateControls();
    } else if (frame.type === "system" && frame.subtype === "init") {
      event(`Connected using ${frame.model ?? "the profile model"}`);
    } else if (["tool_progress", "tool_use_summary", "auth_status", "permission_denied", "notification"].includes(frame.type)) {
      event(frame.summary || frame.message || frame.error || frame.tool_name || frame.type);
    }
  }
  async function finish(active, reason, quiet = false) {
    if (active.finishPromise) return active.finishPromise;
    active.closing = true;
    for (const cancel of state.cancelCallbacks) cancel();
    active.input.close();
    try { active.query?.close(); }
    catch (cause) { if (!quiet) error(`SDK close failed; stopping through management: ${cause.message}`); }
    updateControls();
    active.finishPromise = (async () => {
      let stopped;
      try { stopped = await api(baseUrl, `/api/workers/${encodeURIComponent(active.worker.id)}`, "DELETE"); }
      catch (cause) { if (!quiet) error(`Could not confirm worker cleanup: ${cause.message}`); }
      if (state.active !== active) return;
      state.active = null;
      element("callbacks").replaceChildren();
      if (!quiet) {
        status(stopped?.state === "stopped" ? "Disconnected · worker stopped" : "Disconnected · cleanup unconfirmed");
        event(reason);
        if (stopped?.cleanup_errors) error(`Worker cleanup reported ${stopped.cleanup_errors} failure(s). ${stopped.reason || "Inspect host status."}`);
        else if (stopped?.state === "failed" && stopped.reason) error(stopped.reason);
        await refreshSessions().catch(error);
        updateControls();
      }
    })();
    return active.finishPromise;
  }
  async function start(resume) {
    if (state.active) throw new Error("End the current session before starting another.");
    status("Starting worker…");
    const worker = await api(baseUrl, "/api/workers", "POST", { profileId: profileId(), ...(resume ? { resume } : {}) });
    const active = { worker, input: new InputQueue(), initialized: false, closing: false, busy: false, partial: null };
    state.active = active;
    state.selected = { ...state.selected, session_id: worker.conversationId };
    selectedTitle(state.selected);
    element("conversation-detail").textContent = `Conversation ${worker.conversationId} · Worker ${worker.id}`;
    updateControls();
    try {
      active.query = query({
        prompt: active.input, websocket: { url: worker.websocketUrl }, canUseTool: permission,
        hooks: { UserPromptSubmit: [{ hooks: [async () => { event("Prompt accepted by Claude"); return {}; }] }] },
        onUserDialog: async request => {
          event(`Dialog ${request.dialogKind} is not supported by this example; cancelled.`);
          return { behavior: "cancelled" };
        },
        onElicitation: async () => {
          event("MCP input forms are not supported by this example; cancelled.");
          return { action: "cancel" };
        },
      });
      active.completion = (async () => {
        try { for await (const frame of active.query) frameReceived(active, frame); }
        catch (cause) { if (!active.closing) error(cause); }
        finally {
          if (!active.closing) {
            const reason = active.busy ? "Connection ended during a turn. Its outcome may be incomplete; no prompt was replayed." : "The SDK connection ended.";
            if (active.busy) error(reason);
            await finish(active, reason);
          }
        }
      })();
      await active.query.initializationResult();
      if (active.closing) throw new Error("The worker ended during initialization.");
      active.initialized = true;
      status("Connected · ready", "ready");
    } catch (cause) {
      await finish(active, "Worker initialization failed.");
      throw cause;
    }
    updateControls();
  }
  async function newConversation() {
    state.selected = null;
    clearMessages();
    selectedTitle(null);
    await start();
  }
  async function send() {
    const text = element("prompt").value.trim();
    if (!text || state.active?.busy) return;
    if (!state.active) await newConversation();
    const active = state.active;
    if (!active?.initialized || active.closing) throw new Error("The connection is no longer ready. Resume explicitly to continue.");
    active.busy = true;
    // Display the same UUID that goes into the official SDK's input iterable.
    active.submittedId = active.input.push(text);
    message("user", text, active.submittedId);
    state.lastAssistant = null;
    element("prompt").value = "";
    error(null);
    status("Claude is working…", "working");
    updateControls();
  }

  element("profile").addEventListener("change", () => void action(async () => {
    state.selected = null;
    clearMessages();
    selectedTitle(null);
    showProfile();
    await refreshSessions();
  }));
  element("refresh").addEventListener("click", () => void action(state.profiles.length ? refreshSessions : initialize));
  element("new").addEventListener("click", () => void action(newConversation));
  element("resume").addEventListener("click", () => void action(() => start(state.selected.session_id)));
  element("fork").addEventListener("click", () => void action(async () => {
    const fork = await api(baseUrl, `${historyPath(state.selected.session_id)}/fork`, "POST", {});
    await selectSession(fork.session_id);
    await refreshSessions();
    await start(fork.session_id);
  }));
  element("rename").addEventListener("click", () => {
    element("rename-title").value = state.selected.custom_title || state.selected.summary || "";
    element("rename-form").hidden = false;
    element("rename-title").focus();
  });
  element("rename-cancel").addEventListener("click", () => { element("rename-form").hidden = true; });
  element("rename-form").addEventListener("submit", event => {
    event.preventDefault();
    void action(async () => {
      state.selected = await api(baseUrl, historyPath(state.selected.session_id), "PATCH", { title: element("rename-title").value });
      element("rename-form").hidden = true;
      selectedTitle(state.selected);
      await refreshSessions();
    });
  });
  element("end").addEventListener("click", () => { if (state.active) void finish(state.active, "Session ended by the operator."); });
  element("interrupt").addEventListener("click", () => void action(async () => {
    await state.active.query.interrupt();
    event("Interrupt acknowledged; waiting for the turn to end.");
  }));
  element("prompt").addEventListener("input", updateControls);
  element("prompt").addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !element("send").disabled) {
      event.preventDefault(); element("composer").requestSubmit();
    }
  });
  element("composer").addEventListener("submit", event => { event.preventDefault(); void action(send); });
  window.addEventListener("pagehide", () => {
    const active = state.active;
    if (!active) return;
    active.closing = true;
    for (const cancel of state.cancelCallbacks) cancel();
    active.input.close();
    try { active.query?.close(); } catch { /* The management stop below still runs. */ }
    // Also covers a worker allocated before its WebSocket was established.
    void fetch(`/api/workers/${encodeURIComponent(active.worker.id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    state.active = null;
    state.loading = false;
    status("Disconnected · page restored; resume explicitly to continue");
    void refreshSessions().catch(error);
    updateControls();
  });
  function showProfile() {
    const profile = state.profiles.find(item => item.id === profileId());
    element("profile-detail").textContent = profile ? `${profile.model || "Native model default"} · ${profile.workspace}` : "No profiles are configured on this manager.";
    status(profile ? "Disconnected · ready to start" : "No profiles configured");
  }
  async function initialize() {
    state.profiles = await api(baseUrl, "/api/profiles");
    element("profile").replaceChildren(...state.profiles.map(profile => new Option(profile.id, profile.id)));
    showProfile();
    if (state.profiles.length) await refreshSessions();
  }
  void action(initialize);
  return {
    get active() { return Boolean(state.active); },
    setProbeRunning(value) { state.probeRunning = value; updateControls(); },
  };
}

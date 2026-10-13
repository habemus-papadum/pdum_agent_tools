/** The SDK owns messages and callbacks; this queue only feeds its prompt input. */
export class InputQueue {
  values = [];
  waiting;
  closed = false;

  push(text) {
    if (this.closed) throw new Error("Prompt input is closed");
    const value = {
      type: "user", message: { role: "user", content: text },
      parent_tool_use_id: null, session_id: "", uuid: crypto.randomUUID(),
    };
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting({ done: false, value });
    } else this.values.push(value);
  }

  close() {
    this.closed = true;
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator]() {
    return { next: async () => {
      if (this.values.length) return { done: false, value: this.values.shift() };
      if (this.closed) return { done: true, value: undefined };
      return new Promise(resolve => { this.waiting = resolve; });
    } };
  }
}

export async function api(baseUrl, path, method = "GET", body) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}

async function waitFor(check, label, milliseconds = 90_000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** One bounded qualification turn, or just initialization and control by default. */
export async function probe(connect, {
  baseUrl, profileId, live = false, resume,
  prompt = "Reply exactly CLAUDE_LAUNCHER_OK.",
}) {
  const report = { startedAt: new Date().toISOString(), client: "", live, checks: [], modelRequests: 0 };
  const worker = await api(baseUrl, "/api/workers", "POST", {
    profileId, ...(resume ? { resume } : {}),
    options: { tools: [], max_turns: 1, max_budget_usd: 0.05 },
  });
  report.worker = worker;
  const input = new InputQueue();
  const frames = [];
  const hooks = [];
  let streamError;
  let session;
  let completion;
  let initialized = false;
  try {
    session = connect(worker, input, {
      UserPromptSubmit: [{ hooks: [async () => {
        hooks.push("UserPromptSubmit");
        return {};
      }] }],
    });
    completion = (async () => {
      try { for await (const frame of session) frames.push(frame); }
      catch (error) { streamError = error; }
    })();
    await session.initializationResult();
    initialized = true;
    report.checks.push("Official SDK initialization completed through the Python relay");
    await session.interrupt();
    report.checks.push("Official SDK interrupt control round trip completed");
    if (live) {
      input.push(prompt);
      report.modelRequests = 1;
      await waitFor(() => frames.some(frame => frame.type === "result") || streamError, "model result");
      if (streamError) throw streamError;
      const result = frames.find(frame => frame.type === "result");
      report.result = result;
      if (result.is_error || result.subtype !== "success") throw new Error(`Provider result: ${result.subtype}`);
      if (!hooks.length) throw new Error("The client UserPromptSubmit callback was not invoked");
      report.checks.push("Provider result and client-owned hook callback received");
      report.partialEvents = frames.filter(frame => frame.type === "stream_event").length;
      report.sdkReportedCostUsd = result.total_cost_usd;
      report.costScope = resume ? "Cumulative conversation total, not this attempt's incremental cost" : "New conversation total";
      report.usage = result.usage;
      report.modelUsage = result.modelUsage;
      report.billing = "SDK-reported usage estimate; not subscription billing";
    }
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
    report.billing = report.result ? "See recorded result usage; subscription billing is not measured" :
      report.modelRequests ? "Unknown: a submitted input has no final result" : "No model request submitted";
    error.report = report;
    throw error;
  } finally {
    session?.close();
    input.close();
    if (completion) await completion;
    if (initialized) {
      try {
        await waitFor(async () => {
          const status = await api(baseUrl, `/api/workers/${worker.id}`);
          return status.state === "stopped";
        }, "worker process reaped after disconnect", 15_000);
      } catch (error) {
        await api(baseUrl, `/api/workers/${worker.id}`, "DELETE");
        throw error;
      }
    } else {
      // A failure before WebSocket connection still needs explicit cleanup.
      await api(baseUrl, `/api/workers/${worker.id}`, "DELETE");
    }
    report.endedAt = new Date().toISOString();
  }
  report.checks.push("Worker stopped after client disconnect");
  if (live) {
    const saved = await api(baseUrl, `/api/profiles/${profileId}/sessions/${worker.conversationId}`);
    if (!saved.messages.length) throw new Error("Saved conversation was not readable through management");
    report.historyMessageCount = saved.messages.length;
    report.checks.push("Official Python SDK reads saved history after worker exit");
  }
  report.status = "passed";
  return report;
}

/** Four explicit paid turns exercising concurrency, profile isolation and history. */
export async function fullProbe(connect, { baseUrl, profileId, otherProfileId, live = false }) {
  if (!live) throw new Error("The four-turn qualification requires live: true");
  if (!profileId || !otherProfileId || profileId === otherProfileId) {
    throw new Error("Choose two distinct isolated profiles for the full qualification");
  }
  const report = {
    startedAt: new Date().toISOString(), status: "running", checks: [], turns: [],
    modelRequests: 0,
    billing: "Each reported total is conversation cumulative. Price each result.usage separately; subscription billing is not measured.",
  };
  const opened = [];
  let releaseGate = () => {};
  function check(condition, message) {
    if (!condition) throw new Error(message);
    report.checks.push(message);
  }
  async function open(resume, hook) {
    const worker = await api(baseUrl, "/api/workers", "POST", {
      profileId, ...(resume ? { resume } : {}),
      options: { tools: [], max_turns: 1, max_budget_usd: 0.05 },
    });
    const input = new InputQueue();
    const frames = [];
    const state = { worker, input, frames, error: null, closed: false };
    opened.push(state);
    state.session = connect(worker, input, {
      UserPromptSubmit: [{ hooks: [async () => { if (hook) await hook(); return {}; }] }],
    });
    state.completion = (async () => {
      try { for await (const frame of state.session) frames.push(frame); }
      catch (error) { state.error = error; }
    })();
    await state.session.initializationResult();
    state.initialized = true;
    return state;
  }
  async function close(state) {
    if (state.closed) return;
    state.closed = true;
    state.session?.close();
    state.input.close();
    if (state.completion) await state.completion;
    if (!state.initialized) {
      await api(baseUrl, `/api/workers/${state.worker.id}`, "DELETE");
      return;
    }
    try {
      await waitFor(async () => (await api(baseUrl, `/api/workers/${state.worker.id}`)).state === "stopped",
        "disconnected worker reaped", 15_000);
    } catch (error) {
      await api(baseUrl, `/api/workers/${state.worker.id}`, "DELETE");
      throw error;
    }
  }
  async function turn(state, prompt) {
    const prior = state.frames.filter(frame => frame.type === "result").length;
    state.input.push(prompt);
    report.modelRequests++;
    await waitFor(() => state.error || state.frames.filter(frame => frame.type === "result").length > prior,
      "Haiku result");
    if (state.error) throw state.error;
    const result = state.frames.filter(frame => frame.type === "result").at(-1);
    report.turns.push({ workerId: state.worker.id, conversationId: state.worker.conversationId, result });
    check(result.subtype === "success" && !result.is_error, `Successful Haiku result for ${state.worker.id}`);
    return result;
  }
  try {
    let arrivals = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    releaseGate = release;
    const hook = async () => { if (++arrivals === 2) release(); await gate; };
    const [first, second] = await Promise.all([open(undefined, hook), open(undefined, hook)]);
    check(first.worker.id !== second.worker.id && first.worker.conversationId !== second.worker.conversationId,
      "Two same-profile SDK clients have independent workers and conversations");
    const marker = "PDUM_CLAUDE_MEMORY_2026";
    const [saved, independent] = await Promise.all([
      turn(first, `Remember this exact marker: ${marker}. Reply exactly SAVED.`),
      turn(second, "Reply exactly SECOND."),
    ]);
    check(saved.result.includes("SAVED") && independent.result.includes("SECOND"),
      "Concurrent hook-controlled prompts return independent replies");
    await close(first);
    await second.session.interrupt();
    check((await api(baseUrl, `/api/workers/${second.worker.id}`)).state === "connected",
      "Disconnecting one same-profile worker preserves the other's controls");
    await close(second);
    const sourcePath = `/api/profiles/${profileId}/sessions/${first.worker.conversationId}`;
    await api(baseUrl, sourcePath, "PATCH", { title: "Python launcher source" });
    const source = await api(baseUrl, sourcePath);
    check(source.info.custom_title === "Python launcher source", "Official Python SDK renames saved history");
    const otherHistory = await api(baseUrl, `/api/profiles/${otherProfileId}/sessions`);
    check(!otherHistory.some(item => item.session_id === first.worker.conversationId || item.session_id === second.worker.conversationId),
      "Other profile cannot list these conversations");
    const branch = source.messages.findLast(message => message.type === "assistant");
    check(Boolean(branch), "Saved history exposes a branchable assistant message");
    const fork = await api(baseUrl, `${sourcePath}/fork`, "POST", {
      title: "Python launcher fork", upToMessageId: branch.uuid,
    });
    check(fork.session_id !== first.worker.conversationId, "Fork creates an independent conversation ID");
    check(JSON.stringify((await api(baseUrl, sourcePath)).messages) === JSON.stringify(source.messages),
      "Fork preserves source messages");
    const forked = await open(fork.session_id);
    const forkResult = await turn(forked, "What exact marker did I ask you to remember? Reply only with that marker.");
    check(forkResult.result.includes(marker), "Fork resumes inherited context in a new worker");
    await close(forked);
    const resumed = await open(first.worker.conversationId);
    const resumeResult = await turn(resumed, "What exact marker did I ask you to remember? Reply only with that marker.");
    check(resumeResult.result.includes(marker), "Explicit resume recalls original context in a new worker");
    await close(resumed);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
    report.missingResults = report.modelRequests - report.turns.length;
    error.report = report;
    throw error;
  } finally {
    releaseGate();
    const cleanup = await Promise.allSettled(opened.map(close));
    report.endedAt = new Date().toISOString();
    if (cleanup.some(result => result.status === "rejected")) {
      report.status = "failed";
      const error = new Error("One or more probe workers failed cleanup");
      error.report = report;
      throw error;
    }
  }
  return report;
}

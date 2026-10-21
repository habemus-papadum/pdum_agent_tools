/** Fixture transformations only. This module is not a provider adapter or SDK. */
export const reference = Object.freeze({
  host: "atlas.local",
  cwd: "/work/projects/relay",
  relativePath: "src/retry.ts",
  resolvedPath: "/work/projects/relay/src/retry.ts",
  sourceItemId: "item-read-121",
  capturedAt: "2026-10-19T14:08:21Z",
});

export const capturedLines = [
  "export async function retry<T>(",
  "  run: () => Promise<T>,",
  "  options: RetryOptions,",
  ") : Promise<T> {",
  "  const { signal, attempts = 3 } = options;",
  "  signal.throwIfAborted();",
  "  for (let attempt = 0; attempt < attempts; attempt++) {",
  "    try {",
  "      return await run();",
  "    } catch (error) {",
  "      if (attempt === attempts - 1) throw error;",
  "      await delay(backoff(attempt));",
  "    }",
  "  }",
  "  throw new Error('Retry attempts exhausted');",
  "}",
  "",
  "// Source content invented for this interaction study.",
];

export function fileView(source, scenario) {
  if (source === "current" && scenario === "missing") {
    return { source, available: false, lines: [], version: null };
  }
  const changed = source === "current" && scenario === "changed";
  const lines = [...capturedLines];
  if (changed) lines.splice(12, 0, "      signal.throwIfAborted(); // added after this tool read");
  return {
    source,
    available: true,
    lines,
    version: changed ? "fixture:retry-v2" : "fixture:retry-v1",
  };
}

export function makeExcerpt(view, selection, comment, id) {
  if (!view.available || !selection) throw new Error("No source selection is available.");
  const start = Math.min(...selection);
  const end = Math.max(...selection);
  if (start < 1 || end > view.lines.length) throw new Error("Selection is outside this source version.");
  return {
    id,
    ...reference,
    source: view.source,
    contentVersion: view.version,
    observedAt: view.source === "captured" ? reference.capturedAt : "2026-10-19T14:10:00Z",
    lines: { start, end },
    text: view.lines.slice(start - 1, end).join("\n"),
    comment: comment.trim(),
  };
}

export function makeSubmission({ mode, text, excerpts, settings, scenario, id }) {
  if (!["steer", "queue"].includes(mode)) throw new Error("Choose an explicit delivery mode.");
  if (!text.trim() && excerpts.length === 0) throw new Error("Add prompt text or a source excerpt.");
  return structuredClone({
    id,
    fixture: true,
    intent: "explicit",
    mode,
    sessionId: "session-retry-07",
    targetTurn: mode === "steer" ? "turn-12" : null,
    afterTurn: mode === "queue" ? "turn-12" : null,
    settings: mode === "steer" ? { model: "gpt-6", effort: "medium", tier: "priority", origin: "active-turn" } : { ...settings, origin: "explicit-next-turn" },
    text: text.trim(),
    excerpts,
    scenario,
  });
}

export function initialReceipt(submission) {
  return { submission, stage: "requested", terminal: false, message: "The request snapshot is frozen. No acceptance or execution has been confirmed." };
}

export function advanceReceipt(receipt) {
  if (receipt.terminal) return receipt;
  const { submission } = receipt;
  if (receipt.stage === "requested") {
    if (submission.scenario === "turn-ended" && submission.mode === "steer") return {
      ...receipt, stage: "not-applied", terminal: true,
      message: "Turn 12 ended before dispatch. This steer was not sent. It was not changed into a new turn. Choose a new intent explicitly if you still want to send it.",
    };
    if (submission.scenario === "rejected") return {
      ...receipt, stage: "rejected", terminal: true,
      message: "The fixture rejected the request. No input was applied. Your draft remains available; nothing will retry automatically.",
    };
    if (submission.scenario === "unknown") return {
      ...receipt, stage: "unknown", terminal: true,
      message: "The acknowledgement was lost. Acceptance and delivery are unknown. Do not assume this failed or resubmit blindly; inspect the session before deciding. This mock cannot reconcile a real request.",
    };
    return {
      ...receipt, stage: "queued", terminal: false,
      message: submission.mode === "steer"
        ? "Accepted in this fixture; waiting for a supported input boundary in turn 12. The running tool is not interrupted. This is not a promise of token-level timing."
        : "Accepted into the simulated application queue. No new turn has started. The active turn keeps its existing settings.",
    };
  }
  return {
    ...receipt, stage: submission.mode === "steer" ? "applied" : "turn-started", terminal: true,
    message: submission.mode === "steer"
      ? "The fixture confirms this input was applied within turn 12. This does not mean the agent has completed the requested work."
      : "The fixture ends turn 12 and starts turn 13 with this frozen prompt and its selected settings. The new turn is not yet complete.",
  };
}

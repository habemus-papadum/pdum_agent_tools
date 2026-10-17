import { cell, type HistoryDb, num, type Row } from "./db.ts";
import { pricesCte, USD_EXPRESSION } from "./pricing.ts";

/** One thread in the session list, with usage and a list-price estimate. */
export interface SessionSummary {
  threadId: string;
  title: string | null;
  sourceKind: string | null;
  cwd: string | null;
  repo: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  model: string | null;
  turns: number;
  responses: number;
  totalTokens: number;
  usd: number | null;
  children: number;
  parentThreadId: string | null;
}

export interface ItemView {
  itemId: string;
  type: string;
  at: Date | null;
  durationMs: number | null;
  status: string | null;
  label: string;
  text: string | null;
  origin: string | null;
  added: number | null;
  deleted: number | null;
  paths: string[];
  outputBytes: number | null;
  exitCode: number | null;
}

export interface TurnView {
  turnId: string;
  index: number;
  status: string | null;
  startedAt: Date | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  model: string | null;
  effort: string | null;
  responses: number;
  tokens: number;
  usd: number | null;
  origin: string | null;
  items: ItemView[];
}

export interface SessionView {
  thread: Row;
  turns: TurnView[];
  children: Row[];
  events: Row[];
  /** `key=value` tags from the annotations file, when one was attached. */
  tags?: string[];
}

const USAGE_PER_THREAD = `
  WITH ${pricesCte()},
  u AS (SELECT thread_id, turn_id, model, input_tokens, cached_input_tokens, cache_write_input_tokens,
               cache_write_1h_input_tokens, output_tokens, total_tokens
        FROM usage_events)
  SELECT u.thread_id, count(*) AS responses, sum(u.total_tokens) AS total_tokens,
         sum(${USD_EXPRESSION}) AS usd,
         count(*) FILTER (WHERE p.model IS NULL) AS unpriced
  FROM u LEFT JOIN turns t USING (thread_id, turn_id) LEFT JOIN prices p ON p.model = COALESCE(u.model, t.model)
  GROUP BY 1`;

/** Recent threads with their size and estimated list-price cost. */
export async function listSessions(
  db: HistoryDb,
  options: {
    limit?: number;
    includeChildren?: boolean;
    like?: string;
    tag?: { key: string; value: string | null };
  } = {},
): Promise<SessionSummary[]> {
  const limit = options.limit ?? 20;
  const filters = [options.includeChildren ? "true" : "h.parent_thread_id IS NULL"];
  const values: unknown[] = [];
  if (options.like) {
    filters.push("(h.title ILIKE ? OR h.cwd ILIKE ? OR h.repo ILIKE ? OR h.thread_id ILIKE ?)");
    const pattern = `%${options.like}%`;
    values.push(pattern, pattern, pattern, pattern);
  }
  if (options.tag) {
    filters.push(
      options.tag.value === null
        ? "EXISTS (SELECT 1 FROM tagsdb.tags g WHERE g.subject_kind = 'thread' AND g.subject_id = h.thread_id AND g.key = ?)"
        : "EXISTS (SELECT 1 FROM tagsdb.tags g WHERE g.subject_kind = 'thread' AND g.subject_id = h.thread_id AND g.key = ? AND g.value = ?)",
    );
    values.push(options.tag.key);
    if (options.tag.value !== null) {
      values.push(options.tag.value);
    }
  }
  const rows = await db.query(
    `WITH usage AS (${USAGE_PER_THREAD}),
          turn_counts AS (SELECT thread_id, count(*) AS turns FROM turns WHERE origin IS DISTINCT FROM 'copied-context' GROUP BY 1),
          kids AS (SELECT parent_thread_id AS thread_id, count(*) AS children FROM threads WHERE parent_thread_id IS NOT NULL GROUP BY 1)
     SELECT h.thread_id, h.title, h.source_kind, h.cwd, h.repo, h.created_at, h.updated_at, h.model, h.parent_thread_id,
            COALESCE(tc.turns, 0) AS turns, COALESCE(u.responses, 0) AS responses, COALESCE(u.total_tokens, 0) AS total_tokens,
            CASE WHEN u.unpriced = 0 THEN u.usd END AS usd, COALESCE(k.children, 0) AS children
     FROM threads h LEFT JOIN usage u USING (thread_id) LEFT JOIN turn_counts tc USING (thread_id) LEFT JOIN kids k USING (thread_id)
     WHERE h.in_window AND ${filters.join(" AND ")}
     ORDER BY COALESCE(h.updated_at, h.created_at) DESC NULLS LAST LIMIT ${Math.max(1, Math.floor(limit))}`,
    values,
  );
  return rows.map((row) => ({
    threadId: String(row.thread_id),
    title: (row.title as string | null) ?? null,
    sourceKind: (row.source_kind as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    repo: (row.repo as string | null) ?? null,
    createdAt: (row.created_at as Date | null) ?? null,
    updatedAt: (row.updated_at as Date | null) ?? null,
    model: (row.model as string | null) ?? null,
    turns: num(row.turns),
    responses: num(row.responses),
    totalTokens: num(row.total_tokens),
    usd: row.usd === null || row.usd === undefined ? null : num(row.usd),
    children: num(row.children),
    parentThreadId: (row.parent_thread_id as string | null) ?? null,
  }));
}

/** Resolve a thread id or unique prefix. */
export async function resolveThread(db: HistoryDb, prefix: string): Promise<string> {
  const rows = await db.query<{ thread_id: string }>(
    "SELECT thread_id FROM threads WHERE thread_id = ? OR thread_id LIKE ? ORDER BY thread_id = ? DESC LIMIT 3",
    [prefix, `${prefix}%`, prefix],
  );
  if (rows.length === 0) {
    throw new Error(`no thread matches ${prefix}`);
  }
  if (rows.length > 1 && rows[0]?.thread_id !== prefix) {
    throw new Error(`${prefix} is ambiguous: ${rows.map((r) => r.thread_id).join(", ")}`);
  }
  return String(rows[0]?.thread_id);
}

/** Load one thread with its turns, items, usage, children and notable events. */
export async function loadSession(db: HistoryDb, threadId: string): Promise<SessionView> {
  const [thread] = await db.query("SELECT * FROM threads WHERE thread_id = ?", [threadId]);
  if (!thread) {
    throw new Error(`no thread ${threadId}`);
  }
  const turnRows = await db.query(
    `WITH ${pricesCte()},
          usage AS (
            SELECT u.turn_id, count(*) AS responses, sum(u.total_tokens) AS tokens,
                   sum(${USD_EXPRESSION}) AS usd,
                   count(*) FILTER (WHERE p.model IS NULL) AS unpriced
            FROM usage_events u LEFT JOIN turns t USING (thread_id, turn_id)
            LEFT JOIN prices p ON p.model = COALESCE(u.model, t.model)
            WHERE u.thread_id = ? GROUP BY 1)
     SELECT t.turn_id, t.status, t.started_at, t.duration_ms, t.time_to_first_token_ms, t.model, t.reasoning_effort, t.origin,
            COALESCE(u.responses, 0) AS responses, COALESCE(u.tokens, 0) AS tokens,
            CASE WHEN COALESCE(u.unpriced, 0) = 0 THEN u.usd END AS usd
     FROM turns t LEFT JOIN usage u USING (turn_id)
     WHERE t.thread_id = ? ORDER BY COALESCE(t.started_at, TIMESTAMP '9999-01-01'), t.rollout_ordinal`,
    [threadId, threadId],
  );
  const itemRows = await db.query(
    `SELECT item_id, turn_id, item_type, COALESCE(started_at, created_at) AS at, duration_ms, status, text, origin,
            command_program, tool, server, agent_kind, agent_path, added_lines, deleted_lines, paths, output_bytes, exit_code,
            exec_duration_ms, n_parts
     FROM items WHERE thread_id = ? ORDER BY COALESCE(started_at, created_at), rollout_ordinal`,
    [threadId],
  );
  const children = await db.query(
    `SELECT thread_id, agent_path, agent_nickname, model, created_at FROM threads WHERE parent_thread_id = ? ORDER BY created_at`,
    [threadId],
  );
  const events = await db.query(
    `SELECT event_type, turn_id, ts, detail FROM rollout_events
     WHERE thread_id = ? AND (event_type IN ('compacted', 'api-error', 'cost-state', 'turn_aborted', 'continued-in', 'fork-context-ref')
                              OR event_type LIKE 'system:%' AND event_type NOT IN ('system:turn_duration'))
     ORDER BY rollout_ordinal`,
    [threadId],
  );
  const byTurn = new Map<string, ItemView[]>();
  for (const row of itemRows) {
    const key = String(row.turn_id ?? "");
    const list = byTurn.get(key) ?? [];
    list.push(itemView(row));
    byTurn.set(key, list);
  }
  const turns: TurnView[] = turnRows.map((row, index) => ({
    turnId: String(row.turn_id),
    index: index + 1,
    status: (row.status as string | null) ?? null,
    startedAt: (row.started_at as Date | null) ?? null,
    durationMs: row.duration_ms === null ? null : num(row.duration_ms),
    timeToFirstTokenMs:
      row.time_to_first_token_ms === null ? null : num(row.time_to_first_token_ms),
    model: (row.model as string | null) ?? null,
    effort: (row.reasoning_effort as string | null) ?? null,
    responses: num(row.responses),
    tokens: num(row.tokens),
    usd: row.usd === null || row.usd === undefined ? null : num(row.usd),
    origin: (row.origin as string | null) ?? null,
    items: byTurn.get(String(row.turn_id)) ?? [],
  }));
  const known = new Set(turns.map((t) => t.turnId));
  const orphans = [...byTurn.entries()].filter(([turnId]) => !known.has(turnId));
  for (const [turnId, items] of orphans) {
    turns.push({
      turnId,
      index: turns.length + 1,
      status: null,
      startedAt: items[0]?.at ?? null,
      durationMs: null,
      timeToFirstTokenMs: null,
      model: null,
      effort: null,
      responses: 0,
      tokens: 0,
      usd: null,
      origin: null,
      items,
    });
  }
  return { thread, turns, children, events };
}

function itemView(row: Row): ItemView {
  const type = String(row.item_type ?? "");
  let label = type;
  if (type === "commandExecution") {
    label = row.command_program ? `bash:${String(row.command_program)}` : "bash";
  } else if (type === "mcpToolCall") {
    label = `mcp:${String(row.server ?? "?")}/${String(row.tool ?? "?")}`;
  } else if (type === "toolCall") {
    label = `tool:${String(row.tool ?? "?")}`;
  } else if (type === "fileChange") {
    label = "edit";
  } else if (type === "agentMessage") {
    label = "agent";
  } else if (type === "userMessage") {
    label = "user";
  } else if (type === "reasoning") {
    label = "think";
  } else if (type === "collabAgentToolCall") {
    label = `agent-call:${String(row.agent_kind ?? "?")}`;
  } else if (type === "subAgentActivity") {
    label = `subagent:${String(row.agent_kind ?? "?")}`;
  } else if (type === "webSearch") {
    label = "web";
  } else if (type === "contextCompaction") {
    label = "compact";
  }
  let paths: string[] = [];
  if (typeof row.paths === "string") {
    try {
      paths = (JSON.parse(row.paths) as unknown[]).map(String);
    } catch {
      paths = [];
    }
  }
  return {
    itemId: String(row.item_id),
    type,
    at: (row.at as Date | null) ?? null,
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined ? null : num(row.duration_ms),
    status: (row.status as string | null) ?? null,
    label,
    text: (row.text as string | null) ?? null,
    origin: (row.origin as string | null) ?? null,
    added: row.added_lines === null || row.added_lines === undefined ? null : num(row.added_lines),
    deleted:
      row.deleted_lines === null || row.deleted_lines === undefined ? null : num(row.deleted_lines),
    paths,
    outputBytes:
      row.output_bytes === null || row.output_bytes === undefined ? null : num(row.output_bytes),
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : num(row.exit_code),
  };
}

export interface RenderOptions {
  /** Characters of item text to keep on one line. */
  maxText?: number;
  /** Hide reasoning items. */
  hideThinking?: boolean;
  /** Only this 1-based turn index. */
  turn?: number;
  /** Include tool output excerpts from item_blobs; requires `blobs` from {@link loadBlobs}. */
  blobs?: Map<string, string>;
}

/** Render a loaded session as terminal text: a header, one block per turn, items as lines. */
export function renderSession(view: SessionView, options: RenderOptions = {}): string {
  const maxText = options.maxText ?? 110;
  const thread = view.thread;
  const lines: string[] = [];
  const title = thread.title ? `  ${oneLine(String(thread.title), maxText)}` : "";
  lines.push(`${String(thread.thread_id)}${title}`);
  lines.push(
    [
      `kind ${cell(thread.source_kind)}`,
      `cwd ${cell(thread.cwd)}`,
      `created ${cell(thread.created_at)}`,
      `model ${cell(thread.model)}`,
      thread.repo ? `repo ${cell(thread.repo)}` : "",
      thread.parent_thread_id ? `parent ${cell(thread.parent_thread_id)}` : "",
    ]
      .filter(Boolean)
      .join("  "),
  );
  if (view.tags && view.tags.length > 0) {
    lines.push(`tags ${view.tags.join("  ")}`);
  }
  const totals = view.turns.reduce(
    (acc, t) => ({
      responses: acc.responses + t.responses,
      tokens: acc.tokens + t.tokens,
      usd: acc.usd + (t.usd ?? 0),
    }),
    { responses: 0, tokens: 0, usd: 0 },
  );
  lines.push(
    `${view.turns.length} turns  ${totals.responses} responses  ${formatTokens(totals.tokens)} tokens  ${formatUsd(totals.usd)}  ${view.children.length} sub-agents`,
  );
  for (const turn of view.turns) {
    if (options.turn !== undefined && turn.index !== options.turn) {
      continue;
    }
    lines.push("");
    const copied = turn.origin === "copied-context" ? "  (copied context)" : "";
    lines.push(
      `── turn ${turn.index}  ${cell(turn.startedAt)}  ${turn.status ?? "?"}  ${formatDuration(turn.durationMs)}  ` +
        `${turn.responses} resp  ${formatTokens(turn.tokens)} tok  ${formatUsd(turn.usd)}  ${turn.model ?? ""}${turn.effort ? `/${turn.effort}` : ""}` +
        `${turn.timeToFirstTokenMs !== null ? `  ttft ${formatDuration(turn.timeToFirstTokenMs)}` : ""}${copied}`,
    );
    for (const item of turn.items) {
      if (options.hideThinking && item.type === "reasoning") {
        continue;
      }
      lines.push(renderItem(item, maxText));
      const blob = options.blobs?.get(item.itemId);
      if (blob) {
        for (const excerpt of blob.split("\n").slice(0, 12)) {
          lines.push(`             │ ${excerpt.slice(0, maxText)}`);
        }
      }
    }
  }
  if (view.events.length > 0 && options.turn === undefined) {
    lines.push("");
    lines.push("events:");
    for (const event of view.events) {
      lines.push(
        `  ${cell(event.ts)}  ${cell(event.event_type)}  ${String(event.detail ?? "").slice(0, maxText)}`,
      );
    }
  }
  if (view.children.length > 0 && options.turn === undefined) {
    lines.push("");
    lines.push("sub-agents:");
    for (const child of view.children) {
      lines.push(
        `  ${cell(child.created_at)}  ${cell(child.thread_id)}  ${cell(child.agent_path)}  ${cell(child.model)}`,
      );
    }
  }
  return lines.join("\n");
}

function renderItem(item: ItemView, maxText: number): string {
  const time = item.at ? item.at.toISOString().slice(11, 19) : "        ";
  const status = item.status && item.status !== "completed" ? ` ${item.status}` : "";
  const exit = item.exitCode !== null && item.exitCode !== 0 ? ` exit ${item.exitCode}` : "";
  const duration =
    item.durationMs !== null &&
    item.durationMs > 0 &&
    item.type !== "userMessage" &&
    item.type !== "agentMessage"
      ? ` ${formatDuration(item.durationMs)}`
      : "";
  let detail = "";
  if (item.type === "fileChange") {
    detail = `${item.paths.join(", ")} +${item.added ?? 0} -${item.deleted ?? 0}`;
  } else if (item.text) {
    detail = oneLine(item.text, maxText);
  }
  const output =
    item.outputBytes !== null && item.outputBytes > 0
      ? ` (${formatBytes(item.outputBytes)} out)`
      : "";
  const copied = item.origin === "copied-context" ? " [copied]" : "";
  return `  ${time}  ${item.label.padEnd(16)}${status}${exit}${duration}  ${detail}${output}${copied}`.trimEnd();
}

/** Load tool outputs and message bodies for one thread from item_blobs, keyed by item id. */
export async function loadBlobs(db: HistoryDb, threadId: string): Promise<Map<string, string>> {
  const rows = await db.query<{ item_id: string; item_json: string }>(
    "SELECT item_id, item_json FROM item_blobs WHERE thread_id = ?",
    [threadId],
  );
  const blobs = new Map<string, string>();
  for (const row of rows) {
    const excerpt = blobExcerpt(row.item_json);
    if (excerpt) {
      blobs.set(row.item_id, excerpt);
    }
  }
  return blobs;
}

/** The part of a blob a person wants to glance at: command output, tool result text or a diff. */
export function blobExcerpt(raw: string): string | null {
  let blob: Record<string, unknown>;
  try {
    blob = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof blob.aggregatedOutput === "string") {
    return blob.aggregatedOutput;
  }
  if (Array.isArray(blob.changes)) {
    return (blob.changes as { diff?: string }[]).map((c) => c.diff ?? "").join("\n");
  }
  const structured = blob.toolUseResult as Record<string, unknown> | string | undefined;
  if (structured && typeof structured === "object") {
    if (typeof structured.stdout === "string") {
      return `${structured.stdout}${structured.stderr ? `\n${String(structured.stderr)}` : ""}`;
    }
    if (Array.isArray(structured.structuredPatch)) {
      return (structured.structuredPatch as { lines?: string[] }[])
        .flatMap((h) => h.lines ?? [])
        .join("\n");
    }
  }
  const result = blob.result as { content?: unknown } | undefined;
  if (result && typeof result === "object") {
    const content = result.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .filter(Boolean)
        .join("\n");
    }
  }
  return null;
}

export function renderSessionList(sessions: SessionSummary[]): string {
  const header = [
    "updated",
    "thread",
    "kind",
    "turns",
    "resp",
    "tokens",
    "usd",
    "kids",
    "title / cwd",
  ];
  const rows = sessions.map((s) => [
    cell(s.updatedAt ?? s.createdAt),
    s.threadId.slice(0, 12),
    s.sourceKind ?? "",
    String(s.turns),
    String(s.responses),
    formatTokens(s.totalTokens),
    s.usd === null ? "" : formatUsd(s.usd),
    String(s.children),
    oneLine(s.title ?? s.repo ?? s.cwd ?? "", 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const right = new Set([3, 4, 5, 6, 7]);
  const line = (values: string[]) =>
    values.map((v, i) => (right.has(i) ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export function formatDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) {
    return "";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes < 60
    ? `${minutes}m${String(seconds).padStart(2, "0")}s`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  }
  return String(tokens);
}

export function formatUsd(usd: number | null): string {
  if (usd === null) {
    return "$?";
  }
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(bytes >= 10240 ? 0 : 1)}k` : `${bytes}b`;
}

function oneLine(text: string, maxText: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxText ? `${flat.slice(0, maxText - 1)}…` : flat;
}

import { type HistoryDb, num } from "./db.ts";
import { schema } from "./schema.ts";

/**
 * One invariant: SQL returning a single number. `zero` checks must return 0; `info`
 * checks only print their value so a person can eyeball it.
 */
export interface Check {
  id: string;
  title: string;
  kind: "zero" | "info";
  sql: string;
}

export interface CheckResult extends Check {
  value: number | null;
  ok: boolean;
  error?: string;
  ms: number;
}

/**
 * Claude's `cost-state` ledger starts when a session process starts and is carried into the
 * session that continues it, so a snapshot is compared with the responses of its ancestor chain
 * (each ancestor up to the point where the next session branched off, sub-agents included)
 * between the ledger's `startTime` and the last response before the snapshot. Snapshots carry
 * no timestamp of their own, so that last response stands in. What remains is work the
 * transcript never records as a response: the summarisation requests behind away summaries and
 * compactions, which explain most of the excess, title generation and retries.
 */
export const COST_STATE_SNAPSHOTS = `RECURSIVE snapshots AS (
            SELECT e.thread_id, e.rollout_ordinal,
                   (SELECT max(r.ts) FROM responses r WHERE r.thread_id = e.thread_id AND r.rollout_ordinal < e.rollout_ordinal) AS snapshot_at,
                   epoch_ms(CAST(json_extract(e.detail, '$.startTime') AS BIGINT)) AS ledger_start,
                   (SELECT sum(CAST(json_extract(value, '$.cacheReadInputTokens') AS BIGINT))
                      FROM json_each(json_extract(e.detail, '$.modelUsage'))) AS cached,
                   (SELECT sum(CAST(json_extract(value, '$.cacheCreationInputTokens') AS BIGINT))
                      FROM json_each(json_extract(e.detail, '$.modelUsage'))) AS cache_write
            FROM rollout_events e WHERE e.event_type = 'cost-state'),
          chain(thread_id, ancestor, cutoff) AS (
            SELECT thread_id, thread_id, NULL::TIMESTAMP FROM threads WHERE parent_thread_id IS NULL
            UNION ALL
            SELECT c.thread_id, e.parent_thread_id, e.fork_point_ts
            FROM chain c JOIN fork_edges e ON e.child_thread_id = c.ancestor AND e.kind = 'continuation'),
          lineage AS (
            SELECT s.thread_id, s.rollout_ordinal,
                   sum(r.cached_input_tokens) AS lineage_cached, sum(r.cache_write_input_tokens) AS lineage_cache_write
            FROM snapshots s
            JOIN chain c ON c.thread_id = s.thread_id
            JOIN threads h ON COALESCE(h.parent_thread_id, h.thread_id) = c.ancestor
            JOIN responses r ON r.thread_id = h.thread_id AND r.origin <> 'copied-context' AND r.ts <= s.snapshot_at
                 AND (c.cutoff IS NULL OR r.ts <= c.cutoff)
                 AND (s.ledger_start IS NULL OR r.ts >= s.ledger_start - INTERVAL 1 MINUTE)
            GROUP BY 1, 2),
          compared AS (
            SELECT s.*, f.lineage_cached, f.lineage_cache_write
            FROM snapshots s LEFT JOIN lineage f USING (thread_id, rollout_ordinal))`;

export const CHECKS: Check[] = [
  {
    id: "schema-version",
    title: `meta.schema_version differs from the contract version ${schema.version}`,
    kind: "zero",
    sql: `SELECT count(*) FROM meta WHERE key = 'schema_version' AND value <> '${schema.version}'`,
  },
  {
    id: "rows-without-source",
    title: "fact rows with no source_id",
    kind: "zero",
    sql: `SELECT (SELECT count(*) FROM threads WHERE source_id IS NULL) + (SELECT count(*) FROM turns WHERE source_id IS NULL)
          + (SELECT count(*) FROM responses WHERE source_id IS NULL) + (SELECT count(*) FROM items WHERE source_id IS NULL)
          + (SELECT count(*) FROM coverage WHERE source_id IS NULL) + (SELECT count(*) FROM fork_edges WHERE source_id IS NULL)`,
  },
  {
    id: "threads-without-lineage",
    title: "threads with no lineage_id",
    kind: "zero",
    sql: "SELECT count(*) FROM threads WHERE lineage_id IS NULL",
  },
  {
    id: "fork-edges-child-before-parent",
    title: "fork edges whose child started before its parent thread was created (evidence misread)",
    kind: "zero",
    sql: `SELECT count(*) FROM fork_edges e JOIN threads p ON p.thread_id = e.parent_thread_id
          WHERE e.child_started_at IS NOT NULL AND p.created_at IS NOT NULL AND e.child_started_at < p.created_at`,
  },
  {
    id: "sources-without-provenance",
    title: "source ids on threads that have no provenance row",
    kind: "zero",
    sql: `SELECT count(DISTINCT source_id) FROM threads t
          WHERE source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provenance p WHERE p.source_id = t.source_id)`,
  },
  {
    id: "unknown-lines",
    title: "unknown line types inside the window (format drift)",
    kind: "zero",
    sql: "SELECT COALESCE(sum(unknown_line_types), 0) FROM coverage WHERE in_window",
  },
  {
    id: "duplicate-responses",
    title: "duplicate response ids within one source, ignoring copied context",
    kind: "zero",
    sql: "SELECT count(*) - count(DISTINCT source || response_id) FROM responses WHERE origin <> 'copied-context'",
  },
  {
    id: "responses-without-turn",
    title: "responses whose turn has no turn row",
    kind: "zero",
    sql: `SELECT count(*) FROM responses r
          WHERE NOT EXISTS (SELECT 1 FROM turns t WHERE t.thread_id = r.thread_id AND t.turn_id = r.turn_id)`,
  },
  {
    id: "items-without-turn",
    title: "items whose turn has no turn row",
    kind: "zero",
    sql: `SELECT count(*) FROM items i
          WHERE i.turn_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.thread_id = i.thread_id AND t.turn_id = i.turn_id)`,
  },
  {
    id: "turns-without-thread",
    title: "turns whose thread has no thread row",
    kind: "zero",
    sql: "SELECT count(*) FROM turns t WHERE NOT EXISTS (SELECT 1 FROM threads h WHERE h.thread_id = t.thread_id)",
  },
  {
    id: "blobs-without-item",
    title: "item blobs without an item row",
    kind: "zero",
    sql: `SELECT count(*) FROM item_blobs b
          WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.thread_id = b.thread_id AND i.item_id = b.item_id)`,
  },
  {
    id: "cumulative-vs-records",
    title:
      "threads whose per-response totals differ from the recorded cumulative total by over 0.5% (forks inherit history)",
    kind: "info",
    sql: `WITH per AS (
            SELECT thread_id, sum(total_tokens) AS recorded, max(thread_total_tokens) AS cumulative
            FROM (SELECT * FROM responses WHERE origin <> 'copied-context'
                  QUALIFY row_number() OVER (PARTITION BY source, response_id ORDER BY ts) = 1)
            WHERE thread_total_tokens IS NOT NULL GROUP BY 1)
          SELECT count(*) FROM per WHERE abs(recorded - cumulative) > 0.005 * greatest(cumulative, 1)`,
  },
  {
    id: "projection-vs-events",
    title: "Codex threads whose projected items differ from item_completed events",
    kind: "info",
    sql: `SELECT count(*) FROM coverage
          WHERE in_window AND in_projection AND rollout_item_completed > 0 AND projection_items <> rollout_item_completed`,
  },
  {
    id: "open-tool-items",
    title: "tool items that started and never completed",
    kind: "info",
    sql: `SELECT count(*) FROM items
          WHERE item_type IN ('commandExecution', 'mcpToolCall', 'toolCall', 'webSearch', 'collabAgentToolCall', 'fileChange')
            AND status = 'inProgress'`,
  },
  {
    id: "counter-decreases",
    title: "token_count rows where the cumulative total decreased (resets or forks)",
    kind: "info",
    sql: `SELECT count(*) FROM (
            SELECT total_tokens - lag(total_tokens) OVER (PARTITION BY thread_id ORDER BY rollout_ordinal) AS delta
            FROM token_counts WHERE total_tokens IS NOT NULL)
          WHERE delta < 0`,
  },
  {
    id: "empty-threads",
    title: "threads inside the window with no turns and no items",
    kind: "info",
    sql: `SELECT count(*) FROM threads h WHERE in_window
            AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.thread_id = h.thread_id)
            AND NOT EXISTS (SELECT 1 FROM items i WHERE i.thread_id = h.thread_id)`,
  },
  {
    id: "copied-context",
    title: "responses a file copied from another session or a parent (excluded from usage)",
    kind: "info",
    sql: "SELECT count(*) FROM responses WHERE origin = 'copied-context'",
  },
  {
    id: "continued-lineages",
    title: "lineages made of more than one session file (continuations and forks)",
    kind: "info",
    sql: `SELECT count(*) FROM (SELECT lineage_id FROM threads WHERE parent_thread_id IS NULL GROUP BY 1 HAVING count(*) > 1)`,
  },
  {
    id: "fork-edges-ambiguous",
    title:
      "fork edges whose direction rested on start order alone (no marker, no continued-in record)",
    kind: "info",
    sql: "SELECT count(*) FROM fork_edges WHERE ambiguous",
  },
  {
    id: "fork-edges-missing-endpoint",
    title:
      "fork edges whose parent or child has no thread row (deleted file or outside the window)",
    kind: "info",
    sql: `SELECT count(*) FROM fork_edges e
          WHERE NOT EXISTS (SELECT 1 FROM threads h WHERE h.thread_id = e.parent_thread_id)
             OR NOT EXISTS (SELECT 1 FROM threads h WHERE h.thread_id = e.child_thread_id)`,
  },
  {
    id: "threads-with-several-predecessors",
    title: "threads named as the child of more than one fork edge (signals disagree)",
    kind: "info",
    sql: "SELECT count(*) FROM (SELECT child_thread_id FROM fork_edges GROUP BY 1 HAVING count(*) > 1)",
  },
  {
    id: "claude-cost-state-snapshots",
    title:
      "Claude cost-state snapshots whose cache read and write totals differ by over 2% from the ancestor chain's responses between the ledger start and the snapshot (away-summary, compaction and title requests are never in the transcript)",
    kind: "info",
    sql: `WITH ${COST_STATE_SNAPSHOTS}
          SELECT count(*) FROM compared
          WHERE snapshot_at IS NOT NULL
            AND (lineage_cached IS NULL OR abs(cached - lineage_cached) > 0.02 * greatest(cached, 1)
                 OR abs(cache_write - lineage_cache_write) > 0.02 * greatest(cache_write, 1))`,
  },
  {
    id: "delta-basis-share",
    title: "usage events derived from counter deltas rather than records",
    kind: "info",
    sql: "SELECT count(*) FROM usage_events WHERE basis = 'counter_delta'",
  },
];

/** Run every check; a failing `zero` check or a SQL error marks the result not ok. */
export async function runChecks(db: HistoryDb, checks: Check[] = CHECKS): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const started = performance.now();
    try {
      const value = num(await db.scalar(check.sql));
      results.push({
        ...check,
        value,
        ok: check.kind === "info" || value === 0,
        ms: performance.now() - started,
      });
    } catch (error) {
      results.push({
        ...check,
        value: null,
        ok: false,
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
        ms: performance.now() - started,
      });
    }
  }
  return results;
}

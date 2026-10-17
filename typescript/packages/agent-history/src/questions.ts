import type { HistoryDb, Row } from "./db.ts";
import { pricesCte, pricingVersion, USD_EXPRESSION } from "./pricing.ts";

export interface Question {
  id: string;
  title: string;
  tables: string[];
  sql: string;
}

export interface QuestionResult extends Question {
  coldMs: number | null;
  warmMs: number | null;
  rows: number | null;
  columns: string[];
  result: Row[];
  error?: string;
}

const DEDUP_RESPONSES =
  "(SELECT * FROM responses QUALIFY row_number() OVER (PARTITION BY source, response_id ORDER BY ts, rollout_ordinal) = 1)";

const SEARCH_TERM_PLACEHOLDER = "__TERM__";

export const QUESTIONS: Question[] = [
  {
    id: "Q1",
    title: "Cost by month and basis at list prices, with the unpriced share",
    tables: ["usage_events", "turns"],
    sql: `WITH __PRICES__, r AS (
            SELECT u.ts, u.basis, COALESCE(u.model, t.model) AS model,
                   greatest(u.input_tokens - COALESCE(u.cached_input_tokens, 0) - COALESCE(u.cache_write_input_tokens, 0), 0) AS uncached,
                   COALESCE(u.cached_input_tokens, 0) AS cached, COALESCE(u.cache_write_input_tokens, 0) AS cache_write,
                   COALESCE(u.output_tokens, 0) AS output, p.model IS NOT NULL AS priced,
                   ${USD_EXPRESSION} AS usd
            FROM usage_events u
            LEFT JOIN turns t USING (thread_id, turn_id)
            LEFT JOIN prices p ON p.model = COALESCE(u.model, t.model))
          SELECT date_trunc('month', ts)::date AS month, basis, count(*) AS events, '${pricingVersion}' AS pricing, sum(priced::int) AS priced_events,
                 round(sum(usd), 2) AS usd_estimate,
                 sum(uncached + cached + cache_write + output) FILTER (WHERE priced) AS priced_tokens,
                 sum(uncached + cached + cache_write + output) FILTER (WHERE NOT priced) AS unpriced_tokens,
                 count(DISTINCT model) FILTER (WHERE NOT priced) AS unpriced_models
          FROM r GROUP BY 1, 2 ORDER BY 1, 2`,
  },
  {
    id: "Q2",
    title: "Granularity: where usage exists and what has none",
    tables: ["responses", "turns"],
    sql: `SELECT 'threads with usage' AS level, count(DISTINCT thread_id) AS n FROM responses
          UNION ALL SELECT 'turns with usage', count(DISTINCT thread_id || turn_id) FROM responses
          UNION ALL SELECT 'responses', count(DISTINCT source || response_id) FROM responses
          UNION ALL SELECT 'turns known', count(*) FROM turns
          UNION ALL SELECT 'turns without usage', count(*) FROM turns t
              WHERE NOT EXISTS (SELECT 1 FROM responses r WHERE r.thread_id = t.thread_id AND r.turn_id = t.turn_id)`,
  },
  {
    id: "Q3",
    title: "Cache growth: cache-read share by response index within a turn",
    tables: ["responses"],
    sql: `WITH seq AS (SELECT thread_id, turn_id, input_tokens, cached_input_tokens,
                              row_number() OVER (PARTITION BY thread_id, turn_id ORDER BY ts, rollout_ordinal) AS n
                       FROM ${DEDUP_RESPONSES})
          SELECT n AS response_index, count(*) AS responses,
                 round(avg(cached_input_tokens * 1.0 / NULLIF(input_tokens, 0)), 3) AS mean_cache_share,
                 round(avg(input_tokens)) AS mean_input_tokens
          FROM seq WHERE n <= 10 GROUP BY 1 ORDER BY 1`,
  },
  {
    id: "Q4",
    title: "Slicing by model and reasoning effort",
    tables: ["responses", "turns"],
    sql: `SELECT COALESCE(r.model, t.model) AS model, t.reasoning_effort, count(DISTINCT r.thread_id || r.turn_id) AS turns,
                 count(*) AS responses, sum(r.input_tokens) AS input_tokens,
                 round(sum(r.cached_input_tokens) * 1.0 / NULLIF(sum(r.input_tokens), 0), 3) AS cache_share,
                 sum(r.output_tokens) AS output_tokens, sum(r.reasoning_output_tokens) AS reasoning_tokens
          FROM ${DEDUP_RESPONSES} r LEFT JOIN turns t USING (thread_id, turn_id)
          GROUP BY 1, 2 ORDER BY responses DESC LIMIT 12`,
  },
  {
    id: "Q5",
    title: `Full-text search for one term across item text and item blobs (term: ${SEARCH_TERM_PLACEHOLDER})`,
    tables: ["items", "item_blobs"],
    sql: `SELECT 'items' AS haystack, count(*) AS matches, count(DISTINCT thread_id) AS threads
          FROM items WHERE text ILIKE '%${SEARCH_TERM_PLACEHOLDER}%'
          UNION ALL SELECT 'item_blobs', count(*), count(DISTINCT thread_id)
          FROM item_blobs WHERE item_json ILIKE '%${SEARCH_TERM_PLACEHOLDER}%'`,
  },
  {
    id: "Q6",
    title: "Context length: peak context per thread against the model window",
    tables: ["token_counts"],
    sql: `WITH peak AS (SELECT thread_id, max(last_total_tokens) AS peak_context, max(model_context_window) AS context_window,
                               sum(last_cached_input_tokens) * 1.0 / NULLIF(sum(last_input_tokens), 0) AS cache_share
                        FROM token_counts GROUP BY 1)
          SELECT count(*) AS threads, round(quantile_cont(peak_context, 0.5)) AS p50_peak,
                 round(quantile_cont(peak_context, 0.95)) AS p95_peak, max(peak_context) AS max_peak,
                 sum((peak_context > 0.8 * context_window)::int) AS threads_over_80pct_window,
                 round(avg(cache_share), 3) AS mean_cache_share
          FROM peak`,
  },
  {
    id: "Q7",
    title: "Tool calls: frequency, duration and failure by item type",
    tables: ["items"],
    sql: `SELECT item_type, count(*) AS n, round(quantile_cont(duration_ms, 0.5)) AS p50_ms,
                 round(quantile_cont(duration_ms, 0.95)) AS p95_ms, max(duration_ms) AS max_ms,
                 sum((status IN ('failed', 'declined') OR (exit_code IS NOT NULL AND exit_code <> 0) OR COALESCE(mcp_error, false))::int) AS failures
          FROM items WHERE item_type IN ('commandExecution', 'mcpToolCall', 'toolCall', 'webSearch', 'fileChange', 'collabAgentToolCall', 'sleep')
          GROUP BY 1 ORDER BY n DESC`,
  },
  {
    id: "Q7b",
    title: "Command executions by source and status, with the share whose item duration is zero",
    tables: ["items"],
    sql: `SELECT exec_source, status, count(*) AS n, sum((duration_ms = 0)::int) AS zero_item_duration,
                 round(quantile_cont(exec_duration_ms, 0.5)) AS p50_exec_duration_ms,
                 sum((exit_code IS NOT NULL AND exit_code <> 0)::int) AS nonzero_exit
          FROM items WHERE item_type = 'commandExecution' GROUP BY 1, 2 ORDER BY n DESC`,
  },
  {
    id: "Q7c",
    title:
      "Tool wall time seen by the model loop: raw call and output pairs by tool name (Codex rollouts)",
    tables: ["response_items"],
    sql: `WITH calls AS (SELECT thread_id, call_id, name, create_time FROM response_items
                         WHERE item_type IN ('custom_tool_call', 'function_call') AND call_id IS NOT NULL),
               outs AS (SELECT thread_id, call_id, create_time FROM response_items
                        WHERE item_type IN ('custom_tool_call_output', 'function_call_output') AND call_id IS NOT NULL),
               pairs AS (SELECT c.name, epoch_ms(o.create_time) - epoch_ms(c.create_time) AS wall_ms
                         FROM calls c JOIN outs o USING (thread_id, call_id)
                         WHERE c.create_time IS NOT NULL AND o.create_time IS NOT NULL)
          SELECT name, count(*) AS calls, round(quantile_cont(wall_ms, 0.5)) AS p50_ms,
                 round(quantile_cont(wall_ms, 0.95)) AS p95_ms, max(wall_ms) AS max_ms
          FROM pairs GROUP BY 1 ORDER BY calls DESC LIMIT 10`,
  },
  {
    id: "Q8",
    title: "Extremum deep dive: the slowest commands and the keys needed to open them",
    tables: ["items", "threads"],
    sql: `SELECT i.thread_id, i.turn_id, i.item_id, i.duration_ms, i.exec_duration_ms, i.command_program, i.exit_code,
                 i.output_bytes, i.rollout_ordinal, t.archived, t.rollout_format
          FROM items i JOIN threads t USING (thread_id)
          WHERE i.item_type = 'commandExecution' AND i.status = 'completed' ORDER BY i.duration_ms DESC NULLS LAST LIMIT 3`,
  },
  {
    id: "Q8b",
    title: "Point lookup of one item by its keys",
    tables: ["items"],
    sql: `SELECT item_type, duration_ms, exit_code, output_bytes, text_len FROM items
          WHERE (thread_id, turn_id, item_id) = (SELECT (thread_id, turn_id, item_id) FROM items
                                                 WHERE item_type = 'commandExecution' ORDER BY duration_ms DESC NULLS LAST LIMIT 1)`,
  },
  {
    id: "Q10",
    title: "Turn latency decomposition: wall time, time to first token, tool time",
    tables: ["turns", "items", "responses"],
    sql: `WITH tool AS (SELECT thread_id, turn_id, sum(duration_ms) AS tool_ms, count(*) AS tools FROM items
                        WHERE item_type IN ('commandExecution', 'mcpToolCall', 'toolCall', 'webSearch') GROUP BY 1, 2),
               resp AS (SELECT thread_id, turn_id, count(*) AS responses FROM ${DEDUP_RESPONSES} GROUP BY 1, 2)
          SELECT count(*) AS completed_turns, round(quantile_cont(t.duration_ms, 0.5)) AS p50_turn_ms,
                 round(quantile_cont(t.duration_ms, 0.95)) AS p95_turn_ms,
                 round(quantile_cont(time_to_first_token_ms, 0.5)) AS p50_ttft_ms, count(time_to_first_token_ms) AS turns_with_ttft,
                 round(quantile_cont(tool_ms, 0.5)) AS p50_tool_ms,
                 round(avg(least(tool_ms * 1.0 / NULLIF(t.duration_ms, 0), 1)), 3) AS mean_tool_share,
                 round(avg(responses), 1) AS mean_responses
          FROM turns t LEFT JOIN tool USING (thread_id, turn_id) LEFT JOIN resp USING (thread_id, turn_id)
          WHERE t.status = 'completed' AND t.duration_ms > 0`,
  },
  {
    id: "Q11",
    title: "Agentic loop length: responses per turn and what interrupted turns were doing",
    tables: ["responses", "turns"],
    sql: `WITH per_turn AS (SELECT r.thread_id, r.turn_id, count(*) AS responses, any_value(t.status) AS status
                            FROM ${DEDUP_RESPONSES} r LEFT JOIN turns t USING (thread_id, turn_id) GROUP BY 1, 2)
          SELECT CASE WHEN responses = 1 THEN '1' WHEN responses <= 5 THEN '2-5' WHEN responses <= 20 THEN '6-20'
                      WHEN responses <= 50 THEN '21-50' ELSE '51+' END AS bucket,
                 count(*) AS turns, sum((status = 'interrupted')::int) AS interrupted, round(avg(responses), 1) AS mean_responses
          FROM per_turn GROUP BY 1 ORDER BY min(responses)`,
  },
  {
    id: "Q12",
    title: "Compaction: how often, and context before and after",
    tables: ["rollout_events", "token_counts", "items"],
    sql: `WITH c AS (SELECT thread_id, rollout_ordinal FROM rollout_events WHERE event_type = 'compacted'),
               around AS (SELECT c.thread_id,
                                 (SELECT last_total_tokens FROM token_counts k WHERE k.thread_id = c.thread_id
                                    AND k.rollout_ordinal < c.rollout_ordinal ORDER BY k.rollout_ordinal DESC LIMIT 1) AS before,
                                 (SELECT last_total_tokens FROM token_counts k WHERE k.thread_id = c.thread_id
                                    AND k.rollout_ordinal > c.rollout_ordinal ORDER BY k.rollout_ordinal LIMIT 1) AS after
                          FROM c)
          SELECT (SELECT count(*) FROM c) AS compacted_records, (SELECT count(DISTINCT thread_id) FROM c) AS threads,
                 (SELECT count(*) FROM items WHERE item_type = 'contextCompaction') AS compaction_items,
                 round(avg(before)) AS mean_context_before, round(avg(after)) AS mean_context_after, count(before) AS measured
          FROM around`,
  },
  {
    id: "Q13",
    title: "Sub-agent economics: children per parent and the child share of tokens",
    tables: ["threads", "responses", "items"],
    sql: `WITH tokens AS (SELECT thread_id, sum(total_tokens) AS tokens FROM ${DEDUP_RESPONSES} GROUP BY 1),
               fam AS (SELECT p.thread_id AS parent, count(c.thread_id) AS children, sum(ct.tokens) AS child_tokens,
                              max(pt.tokens) AS parent_tokens
                       FROM threads p JOIN threads c ON c.parent_thread_id = p.thread_id
                       LEFT JOIN tokens ct ON ct.thread_id = c.thread_id LEFT JOIN tokens pt ON pt.thread_id = p.thread_id
                       GROUP BY 1)
          SELECT count(*) AS parents, sum(children) AS children, round(avg(children), 1) AS mean_children,
                 sum(child_tokens) AS child_tokens, sum(parent_tokens) AS parent_tokens,
                 round(sum(child_tokens) * 1.0 / NULLIF(sum(child_tokens) + sum(parent_tokens), 0), 3) AS child_share,
                 (SELECT round(quantile_cont(duration_ms, 0.5)) FROM items WHERE item_type = 'collabAgentToolCall') AS p50_collab_wait_ms
          FROM fam`,
  },
  {
    id: "Q14",
    title: "Rhythm: turns by local hour and think time between turns",
    tables: ["turns"],
    sql: `WITH local AS (SELECT thread_id, turn_id, started_at, completed_at, __HOUR__ AS hour FROM turns WHERE started_at IS NOT NULL),
               gaps AS (SELECT epoch(lead(started_at) OVER (PARTITION BY thread_id ORDER BY started_at) - completed_at) / 60 AS gap_minutes
                        FROM local WHERE completed_at IS NOT NULL)
          SELECT hour, count(*) AS turns,
                 (SELECT round(quantile_cont(gap_minutes, 0.5), 1) FROM gaps WHERE gap_minutes BETWEEN 0 AND 480) AS p50_think_minutes_all_hours
          FROM local GROUP BY 1 ORDER BY turns DESC LIMIT 8`,
  },
  {
    id: "Q15",
    title: "Rate limits and credits: daily window usage and balance drawdown (Codex)",
    tables: ["token_counts"],
    sql: `SELECT date_trunc('day', ts)::date AS day, count(*) AS samples, round(max(primary_used_percent), 1) AS max_primary_pct,
                 round(max(credits_balance) - min(credits_balance), 2) AS balance_range,
                 count(*) FILTER (WHERE rate_limit_reached_type IS NOT NULL) AS limit_reached, any_value(plan_type) AS plan
          FROM token_counts WHERE ts IS NOT NULL AND limit_id IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 10`,
  },
  {
    id: "Q16",
    title: "Per-repository allocation: threads, tokens and failed commands by git origin",
    tables: ["threads", "responses", "items"],
    sql: `WITH tokens AS (SELECT thread_id, sum(total_tokens) AS tokens FROM ${DEDUP_RESPONSES} GROUP BY 1),
               fails AS (SELECT thread_id, count(*) AS commands,
                                sum((status = 'failed' OR (exit_code IS NOT NULL AND exit_code <> 0))::int) AS failed
                         FROM items WHERE item_type = 'commandExecution' GROUP BY 1)
          SELECT COALESCE(regexp_extract(git_origin, '([^/]+/[^/]+?)(\\.git)?$', 1), COALESCE(cwd, '(no git)')) AS repo,
                 count(*) AS threads, sum(tokens) AS tokens, sum(commands) AS commands,
                 round(sum(failed) * 1.0 / NULLIF(sum(commands), 0), 3) AS failed_share
          FROM threads LEFT JOIN tokens USING (thread_id) LEFT JOIN fails USING (thread_id)
          GROUP BY 1 ORDER BY tokens DESC NULLS LAST LIMIT 8`,
  },
  {
    id: "Q17",
    title: "Edit volume and churn: lines added and deleted, files edited repeatedly in one thread",
    tables: ["items"],
    sql: `WITH paths AS (SELECT thread_id, unnest(from_json(paths, '["VARCHAR"]')) AS path FROM items
                         WHERE item_type = 'fileChange' AND paths IS NOT NULL),
               churn AS (SELECT thread_id, path, count(*) AS edits FROM paths GROUP BY 1, 2)
          SELECT date_trunc('month', created_at)::date AS month, count(*) AS file_changes, sum(added_lines) AS added,
                 sum(deleted_lines) AS deleted, (SELECT count(*) FROM churn WHERE edits >= 3) AS paths_edited_3plus_in_a_thread
          FROM items WHERE item_type = 'fileChange' GROUP BY 1 ORDER BY 1`,
  },
  {
    id: "Q18",
    title: "Command patterns: programs, repeats within a turn, truncated output",
    tables: ["items"],
    sql: `WITH cmd AS (SELECT * FROM items WHERE item_type = 'commandExecution'),
               repeats AS (SELECT thread_id, turn_id, command, count(*) AS n FROM cmd GROUP BY 1, 2, 3 HAVING count(*) >= 3)
          SELECT command_program, count(*) AS n,
                 round(sum((status = 'failed' OR exit_code <> 0)::int) * 1.0 / count(*), 3) AS failed_share,
                 round(quantile_cont(duration_ms, 0.5)) AS p50_ms,
                 (SELECT count(*) FROM repeats) AS repeated_commands_3plus,
                 (SELECT sum(output_truncated::int) FROM cmd) AS truncated_outputs
          FROM cmd GROUP BY 1 ORDER BY n DESC LIMIT 12`,
  },
  {
    id: "Q19",
    title: "Reasoning share of output tokens by model and effort (Codex records reasoning tokens)",
    tables: ["responses", "turns"],
    sql: `SELECT COALESCE(r.model, t.model) AS model, t.reasoning_effort, count(*) AS responses,
                 round(sum(r.reasoning_output_tokens) * 1.0 / NULLIF(sum(r.output_tokens), 0), 3) AS reasoning_share,
                 round(avg(r.output_tokens)) AS mean_output
          FROM ${DEDUP_RESPONSES} r LEFT JOIN turns t USING (thread_id, turn_id)
          GROUP BY 1, 2 HAVING count(*) >= 20 ORDER BY responses DESC LIMIT 10`,
  },
  {
    id: "Q20",
    title: "Client and version drift: cache share and failed turns by CLI version and originator",
    tables: ["threads", "turns", "responses"],
    sql: `WITH usage AS (SELECT thread_id, sum(input_tokens) AS input, sum(cached_input_tokens) AS cached FROM ${DEDUP_RESPONSES} GROUP BY 1),
               fails AS (SELECT thread_id, count(*) AS turns, sum((status IN ('failed', 'interrupted'))::int) AS bad FROM turns GROUP BY 1)
          SELECT cli_version, originator, count(*) AS threads, round(sum(cached) * 1.0 / NULLIF(sum(input), 0), 3) AS cache_share,
                 sum(turns) AS turns, round(sum(bad) * 1.0 / NULLIF(sum(turns), 0), 3) AS failed_or_interrupted_share
          FROM threads LEFT JOIN usage USING (thread_id) LEFT JOIN fails USING (thread_id)
          GROUP BY 1, 2 ORDER BY threads DESC LIMIT 10`,
  },
  {
    id: "Q21",
    title:
      "Live detectors over history: open turns, command loops, near-full context, recent warnings",
    tables: ["turns", "items", "token_counts", "logs"],
    sql: `SELECT 'turns still inProgress' AS detector, count(*) AS hits FROM turns WHERE status = 'inProgress'
          UNION ALL SELECT 'turns with one command repeated 5+ times', count(*) FROM (
              SELECT DISTINCT thread_id, turn_id FROM (SELECT thread_id, turn_id, command FROM items
              WHERE item_type = 'commandExecution' GROUP BY 1, 2, 3 HAVING count(*) >= 5))
          UNION ALL SELECT 'turns with context over 90% of window', count(DISTINCT thread_id || COALESCE(turn_id, ''))
              FROM token_counts WHERE last_total_tokens > 0.9 * model_context_window
          UNION ALL SELECT 'WARN/ERROR log rows in the last 7 days', count(*) FROM logs
              WHERE level IN ('WARN', 'ERROR') AND ts > now()::timestamp - INTERVAL 7 DAY
          UNION ALL SELECT 'turns failed with an error message', count(*) FROM turns WHERE error_message IS NOT NULL
          UNION ALL SELECT 'tool items still open', count(*) FROM items WHERE status = 'inProgress'`,
  },
  {
    id: "Q22",
    title: "Coverage: what the input could see",
    tables: ["coverage", "turns", "responses", "meta"],
    sql: `SELECT 'source' AS measure, any_value(value) AS n FROM meta WHERE key = 'source'
          UNION ALL SELECT 'threads seen anywhere', count(*)::varchar FROM coverage
          UNION ALL SELECT 'threads in window', sum(in_window::int)::varchar FROM coverage
          UNION ALL SELECT 'in catalogue', sum(in_catalogue::int)::varchar FROM coverage
          UNION ALL SELECT 'in projection', sum(in_projection::int)::varchar FROM coverage
          UNION ALL SELECT 'formats', string_agg(DISTINCT rollout_format, ', ') FROM coverage
          UNION ALL SELECT 'threads with usage records', sum((usage_records > 0)::int)::varchar FROM coverage
          UNION ALL SELECT 'turns with a model', count(*)::varchar FROM turns WHERE model IS NOT NULL
          UNION ALL SELECT 'turns with usage', count(DISTINCT thread_id || turn_id)::varchar FROM responses
          UNION ALL SELECT 'unknown line types', sum(unknown_line_types)::varchar FROM coverage`,
  },
];

export interface QuestionOptions {
  term?: string;
  timeZone?: string;
  limitRows?: number;
}

async function hourExpression(db: HistoryDb, timeZone: string): Promise<string> {
  try {
    await db.query(`SELECT hour(timezone('${timeZone}', TIMESTAMP '2026-01-01 00:00:00'))`);
    return `hour(timezone('${timeZone}', started_at))`;
  } catch {
    return "hour(started_at)";
  }
}

/** Run every question twice and keep cold and warm latency with the first rows of each result. */
export async function runQuestions(
  db: HistoryDb,
  options: QuestionOptions = {},
  questions: Question[] = QUESTIONS,
): Promise<QuestionResult[]> {
  const term = (options.term ?? "duckdb").replace(/'/g, "''");
  const hour = await hourExpression(db, options.timeZone ?? "UTC");
  const limit = options.limitRows ?? 15;
  const results: QuestionResult[] = [];
  for (const question of questions) {
    const sql = question.sql
      .replaceAll("__PRICES__", pricesCte())
      .replaceAll("__HOUR__", hour)
      .replaceAll(SEARCH_TERM_PLACEHOLDER, term);
    const title = question.title.replaceAll(SEARCH_TERM_PLACEHOLDER, term);
    try {
      let started = performance.now();
      const rows = await db.query(sql);
      const coldMs = performance.now() - started;
      started = performance.now();
      await db.query(sql);
      const warmMs = performance.now() - started;
      results.push({
        ...question,
        title,
        coldMs,
        warmMs,
        rows: rows.length,
        columns: rows[0] ? Object.keys(rows[0]) : [],
        result: rows.slice(0, limit),
      });
    } catch (error) {
      results.push({
        ...question,
        title,
        coldMs: null,
        warmMs: null,
        rows: null,
        columns: [],
        result: [],
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
    }
  }
  return results;
}

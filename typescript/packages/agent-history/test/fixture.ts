import { HistoryDb } from "../src/db.ts";
import { ddl, schema } from "../src/schema.ts";

/** A small consistent in-memory history: one Codex thread, one turn, two responses, a few items. */
export async function fixture(): Promise<HistoryDb> {
  const db = await HistoryDb.memory();
  for (const statement of ddl()) {
    await db.run(statement);
  }
  await db.run(
    `INSERT INTO meta VALUES ('schema_version', '${schema.version}'), ('source', 'codex-fs')`,
  );
  await db.run(`INSERT INTO threads (thread_id, created_at, updated_at, source_kind, cli_version, originator, cwd, git_origin,
                  title, model, in_window, source, origin, archived)
                VALUES ('t1', TIMESTAMP '2026-10-01 10:00:00', TIMESTAMP '2026-10-01 10:01:00', 'vscode', '0.162.1',
                        'codex-tui', '/work', 'https://example.invalid/org/repo.git', 'Fix the parser', 'gpt-6-astra',
                        true, 'codex-fs', 'state_5', false),
                       ('t1:child', TIMESTAMP '2026-10-01 10:00:30', TIMESTAMP '2026-10-01 10:00:50', 'subagent', '0.162.1',
                        'codex-tui', '/work', NULL, NULL, 'gpt-6-astra', true, 'codex-fs', 'state_5', false),
                       ('t2', TIMESTAMP '2026-10-01 11:00:00', TIMESTAMP '2026-10-01 11:05:00', 'vscode', '0.162.1',
                        'codex-tui', '/work', 'https://example.invalid/org/repo.git', 'Continue the fix', 'gpt-6-astra',
                        true, 'codex-fs', 'rollout', false)`);
  await db.run(
    `UPDATE threads SET parent_thread_id = 't1', agent_path = '/root/explore' WHERE thread_id = 't1:child'`,
  );
  await db.run(`UPDATE threads SET forked_from_id = 't1' WHERE thread_id = 't2'`);
  await db.run(
    `UPDATE threads SET lineage_id = 't1', lineage_depth = CASE WHEN thread_id = 't1' THEN 0 ELSE 1 END`,
  );
  await db.run(`INSERT INTO fork_edges (parent_thread_id, child_thread_id, kind, evidence, ambiguous, inherited_records,
                  fork_point_ts, child_started_at, source, origin)
                VALUES ('t1', 't2', 'continuation', 'marker+continued-in', false, 3, TIMESTAMP '2026-10-01 10:00:50',
                        TIMESTAMP '2026-10-01 11:00:00', 'codex-fs', 'rollout')`);
  await db.run(`INSERT INTO turns (thread_id, turn_id, root_turn_id, rollout_ordinal, status, started_at, completed_at,
                  duration_ms, time_to_first_token_ms, model, reasoning_effort, model_context_window, source, origin)
                VALUES ('t1', 'u1', 'u1', 1, 'completed', TIMESTAMP '2026-10-01 10:00:00', TIMESTAMP '2026-10-01 10:01:00',
                        60000, 3000, 'gpt-6-astra', 'xhigh', 258400, 'codex-fs', 'thread_history_1+rollout')`);
  await db.run(`INSERT INTO responses (thread_id, turn_id, root_turn_id, session_id, response_id, ts, rollout_ordinal, model,
                  input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens,
                  total_tokens, thread_total_tokens, source, origin)
                VALUES ('t1', 'u1', 'u1', 't1', 'r1', TIMESTAMP '2026-10-01 10:00:10', 2, 'gpt-6-astra',
                        1000, 800, 0, 50, 10, 1050, 1050, 'codex-fs', 'rollout'),
                       ('t1', 'u1', 'u1', 't1', 'r2', TIMESTAMP '2026-10-01 10:00:40', 3, 'gpt-6-astra',
                        1200, 1000, 0, 60, 20, 1260, 2310, 'codex-fs', 'rollout')`);
  await db.run(`INSERT INTO token_counts (thread_id, turn_id, ts, rollout_ordinal, total_tokens, last_total_tokens,
                  last_input_tokens, last_cached_input_tokens, model_context_window, limit_id, plan_type,
                  primary_used_percent, credits_balance, source, origin)
                VALUES ('t1', 'u1', TIMESTAMP '2026-10-01 10:00:10', 2, 1050, 1050, 1000, 800, 258400, 'codex', 'prolite',
                        4.0, 100.5, 'codex-fs', 'rollout'),
                       ('t1', 'u1', TIMESTAMP '2026-10-01 10:00:40', 3, 2310, 1260, 1200, 1000, 258400, 'codex', 'prolite',
                        5.0, 100.5, 'codex-fs', 'rollout')`);
  await db.run(`INSERT INTO items (thread_id, turn_id, item_id, rollout_ordinal, item_type, created_at, started_at,
                  completed_at, duration_ms, status, command, command_program, exit_code, exec_duration_ms, output_bytes,
                  output_truncated, text, text_len, source, origin)
                VALUES ('t1', 'u1', 'm0', 1, 'userMessage', TIMESTAMP '2026-10-01 10:00:00', NULL,
                        TIMESTAMP '2026-10-01 10:00:00', 0, 'completed', NULL, NULL, NULL, NULL, NULL, NULL,
                        'Please find where duckdb is mentioned', 36, 'codex-fs', 'thread_history_1'),
                       ('t1', 'u1', 'e1', 4, 'commandExecution', TIMESTAMP '2026-10-01 10:00:20',
                        TIMESTAMP '2026-10-01 10:00:20', TIMESTAMP '2026-10-01 10:00:21', 1000, 'completed',
                        '/bin/zsh -lc "rg duckdb"', 'rg', 0, 990, 20, false, '/bin/zsh -lc "rg duckdb"', 24,
                        'codex-fs', 'thread_history_1'),
                       ('t1', 'u1', 'f1', 5, 'fileChange', TIMESTAMP '2026-10-01 10:00:30',
                        TIMESTAMP '2026-10-01 10:00:30', TIMESTAMP '2026-10-01 10:00:30', 0, 'completed',
                        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'codex-fs', 'thread_history_1'),
                       ('t1', 'u1', 'a1', 6, 'agentMessage', TIMESTAMP '2026-10-01 10:00:50', NULL,
                        TIMESTAMP '2026-10-01 10:00:50', 0, 'completed', NULL, NULL, NULL, NULL, NULL, NULL,
                        'Found two mentions and fixed a.py.', 34, 'codex-fs', 'thread_history_1')`);
  await db.run(
    `UPDATE items SET paths = '["a.py"]', added_lines = 2, deleted_lines = 1 WHERE item_id = 'f1'`,
  );
  await db.run(`INSERT INTO item_blobs (thread_id, turn_id, item_id, item_json, source, origin) VALUES ('t1', 'u1', 'e1', '{"type":"commandExecution","aggregatedOutput":"a.py: duckdb\\nb.py: duckdb\\n"}',
                  'codex-fs', 'thread_history_1')`);
  await db.run(`INSERT INTO rollout_events (thread_id, turn_id, ts, rollout_ordinal, event_type, detail, source, origin)
                VALUES ('t1', 'u1', TIMESTAMP '2026-10-01 10:00:45', 7, 'compacted', '{"replacement_history": 3}', 'codex-fs', 'rollout')`);
  await db.run(`INSERT INTO coverage (thread_id, in_window, in_catalogue, in_projection, rollout_format, rollout_lines,
                  turn_contexts, usage_records, token_counts, projection_turns, projection_items, rollout_item_completed,
                  response_items, compactions, unknown_line_types, source, origin)
                VALUES ('t1', true, true, true, 'envelope', 12, 1, 2, 2, 1, 4, 4, 0, 1, 0, 'codex-fs', 'ingest-codex-fs'),
                       ('t1:child', true, true, false, 'envelope', 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'codex-fs', 'ingest-codex-fs'),
                       ('t2', true, false, false, 'envelope', 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'codex-fs', 'ingest-codex-fs')`);
  for (const table of Object.keys(schema.tables)) {
    if (schema.tables[table]?.some(([name]) => name === "source_id") && table !== "provenance") {
      await db.run(`UPDATE ${table} SET source_id = 'codex-abcd1234-00000001'`);
    }
  }
  await db.run(`INSERT INTO provenance VALUES ('codex-abcd1234-00000001', 'abcd1234', 'laptop', 'nehal', 'darwin 25',
                  'codex', '/home/nehal/.codex', '["0.162.1"]', TIMESTAMP '2026-04-17 00:00:00', ${schema.version}, 'dev',
                  TIMESTAMP '2026-10-17 12:00:00', 'run1')`);
  await db.run(`UPDATE responses SET cache_write_1h_input_tokens = 0, wasted_output_tokens = 0`);
  return db;
}

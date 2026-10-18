"""Codex home ingestion against a synthetic home with current, legacy and out-of-window threads."""

import json
import sqlite3
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import duckdb
import pytest
from pdum.agent_history import ingest_codex_home, schema
from typer.testing import CliRunner

NOW = datetime(2026, 10, 17, 12, 0, 0)
THREAD = "01a10000-0000-7000-8000-000000000001"
CHILD = "01a10000-0000-7000-8000-000000000002"
OLD = "01a10000-0000-7000-8000-000000000003"
LEGACY = "ac00aa69-8b37-43e1-a086-40d3263b7a2f"
TURN = "01a10000-0000-7000-8000-00000000aaaa"


def _state_db(path: Path, threads: list[tuple[str, int, str, int]]) -> None:
    connection = sqlite3.connect(path)
    connection.execute(
        "create table threads (id text primary key, rollout_path text not null, created_at integer, "
        "updated_at integer, source text, model_provider text, cwd text, title text, sandbox_policy text, "
        "approval_mode text, tokens_used integer default 0, has_user_event integer default 0, "
        "archived integer default 0, archived_at integer, git_sha text, git_branch text, git_origin_url text, "
        "cli_version text default '', first_user_message text default '', agent_nickname text, agent_role text, "
        "memory_mode text default 'enabled', model text, reasoning_effort text, agent_path text, "
        "created_at_ms integer, updated_at_ms integer, thread_source text, preview text default '', "
        "history_mode text default 'paginated', originator text)"
    )
    connection.execute(
        "create table thread_spawn_edges (parent_thread_id text, child_thread_id text primary key, status text)"
    )
    for thread_id, created, source, archived in threads:
        connection.execute(
            "insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, "
            "sandbox_policy, approval_mode, archived, cli_version, model, reasoning_effort, created_at_ms, "
            "updated_at_ms, preview, originator) values (?, ?, ?, ?, ?, 'openai', '/work', 'title', "
            "'danger-full-access', 'never', ?, '0.162.1', 'gpt-6-astra', 'xhigh', ?, ?, 'hello', 'codex-tui')",
            (
                thread_id,
                f"/rollouts/{thread_id}.jsonl",
                created,
                created,
                source,
                archived,
                created * 1000,
                created * 1000,
            ),
        )
    connection.execute("insert into thread_spawn_edges values (?, ?, 'completed')", (THREAD, CHILD))
    connection.commit()
    connection.close()


def _history_db(path: Path, rows: list[tuple[str, str, str, int, int, str, dict]]) -> None:
    connection = sqlite3.connect(path)
    connection.execute(
        "create table thread_turns (thread_id text, turn_id text, rollout_ordinal integer, status text, "
        "error_json text, started_at integer, completed_at integer, duration_ms integer, first_user_item_id text, "
        "final_agent_item_id text, rollout_byte_offset integer, rollout_end_ordinal integer, "
        "rollout_end_byte_offset integer, root_turn_id text, primary key (thread_id, turn_id))"
    )
    connection.execute(
        "create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal integer, "
        "created_at_ms integer, item_json text, item_type text default '', updated_at_ordinal integer default 0, "
        "started_at_ms integer, completed_at_ms integer, primary key (thread_id, turn_id, item_id))"
    )
    turns = {(thread, turn) for thread, turn, *_ in rows}
    for thread, turn in turns:
        started = int(NOW.replace(tzinfo=UTC).timestamp()) - 600
        connection.execute(
            "insert into thread_turns values (?, ?, 1, 'completed', NULL, ?, ?, 120000, NULL, NULL, 0, NULL, NULL, ?)",
            (thread, turn, started, started + 120, turn),
        )
    for thread, turn, item_id, ordinal, created_ms, item_type, item in rows:
        connection.execute(
            "insert into thread_items values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
            (thread, turn, item_id, ordinal, created_ms, json.dumps(item), item_type, created_ms, created_ms + 50),
        )
    connection.commit()
    connection.close()


def _logs_db(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.execute(
        "create table logs (id integer primary key autoincrement, ts integer not null, ts_nanos integer not null, "
        "level text, target text, feedback_log_body text, module_path text, file text, line integer, "
        "thread_id text, process_uuid text, estimated_bytes integer default 0)"
    )
    now = int(NOW.replace(tzinfo=UTC).timestamp())
    connection.executemany(
        "insert into logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid) "
        "values (?,?,?,?,?,?,?)",
        [
            (now - 10, 0, "WARN", "t", "something odd", THREAD, "pid:1"),
            (now - 5, 0, "INFO", "t", "fine", THREAD, "pid:1"),
            (now - 400 * 86400, 0, "ERROR", "t", "ancient", None, "pid:0"),
        ],
    )
    connection.commit()
    connection.close()


def _line(ts: datetime, ordinal: int, kind: str, payload: dict) -> str:
    return json.dumps({"timestamp": ts.isoformat() + "Z", "ordinal": ordinal, "type": kind, "payload": payload})


def _usage(n: int) -> dict:
    return {
        "input_tokens": 1000 * n,
        "cached_input_tokens": 800 * n,
        "cache_write_input_tokens": 0,
        "output_tokens": 50 * n,
        "reasoning_output_tokens": 10 * n,
        "total_tokens": 1050 * n,
    }


def _rollout(
    path: Path, thread_id: str, created: datetime, *, parent: str | None = None, usage_records: bool = True
) -> None:
    meta = {
        "session_id": thread_id,
        "id": thread_id,
        "timestamp": created.isoformat() + "Z",
        "cwd": "/work",
        "originator": "codex-tui",
        "cli_version": "0.162.1",
        "source": "vscode" if parent is None else {"subagent": {"thread_spawn": {"parent_thread_id": parent}}},
        "model_provider": "openai",
        "history_mode": "paginated",
        "git": {"commit_hash": "abc", "branch": "main", "repository_url": "https://example.invalid/repo.git"},
    }
    if parent:
        meta["parent_thread_id"] = parent
        meta["forked_from_id"] = parent
    lines = [_line(created, 1, "session_meta", meta)]
    t = created + timedelta(seconds=5)
    lines.append(
        _line(
            t,
            2,
            "turn_context",
            {
                "turn_id": TURN,
                "root_turn_id": TURN,
                "cwd": "/work",
                "approval_policy": "never",
                "sandbox_policy": {"type": "danger-full-access"},
                "model": "gpt-6-astra",
                "effort": "xhigh",
                "personality": "pragmatic",
                "collaboration_mode": {
                    "mode": "default",
                    "settings": {"model": "gpt-6-astra", "reasoning_effort": "xhigh"},
                },
            },
        )
    )
    lines.append(
        _line(
            t,
            3,
            "event_msg",
            {
                "type": "task_started",
                "turn_id": TURN,
                "root_turn_id": TURN,
                "started_at": int(t.timestamp()),
                "model_context_window": 258400,
            },
        )
    )
    for n in (1, 2):
        t = t + timedelta(seconds=10)
        if usage_records:
            lines.append(
                _line(
                    t,
                    3 + n,
                    "token_usage_record",
                    {
                        "thread_id": thread_id,
                        "turn_id": TURN,
                        "session_id": thread_id,
                        "root_turn_id": TURN,
                        "response_id": f"resp_{thread_id[-1]}_{n}",
                        "usage": _usage(1),
                        "turn_token_usage": _usage(n),
                        "thread_token_usage": _usage(n),
                    },
                )
            )
        lines.append(
            _line(
                t,
                10 + n,
                "event_msg",
                {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": _usage(n),
                        "last_token_usage": _usage(1),
                        "model_context_window": 258400,
                    },
                    "rate_limits": {
                        "limit_id": "codex",
                        "primary": {
                            "used_percent": 4.0 * n,
                            "window_minutes": 10080,
                            "resets_at": int(t.timestamp()) + 1000,
                        },
                        "credits": {"has_credits": True, "unlimited": False, "balance": "100.5"},
                        "plan_type": "prolite",
                    },
                },
            )
        )
        lines.append(
            _line(
                t,
                20 + n,
                "response_item",
                {
                    "type": "custom_tool_call",
                    "id": f"call_{n}",
                    "call_id": f"c{n}",
                    "name": "exec",
                    "input": "echo hi",
                    "internal_chat_message_metadata_passthrough": {"turn_id": TURN, "create_time": t.timestamp()},
                },
            )
        )
    lines.append(
        _line(
            t,
            30,
            "event_msg",
            {
                "type": "item_completed",
                "thread_id": thread_id,
                "turn_id": TURN,
                "item": {"type": "agent_message", "id": "m1"},
            },
        )
    )
    lines.append(_line(t, 31, "compacted", {"message": "", "replacement_history": [{}, {}]}))
    lines.append(
        _line(
            t,
            32,
            "event_msg",
            {
                "type": "task_complete",
                "turn_id": TURN,
                "started_at": int(created.timestamp()),
                "completed_at": int(t.timestamp()),
                "duration_ms": 25000,
                "time_to_first_token_ms": 3000,
                "last_agent_message": "done",
            },
        )
    )
    lines.append(_line(t, 33, "mystery_type", {"x": 1}))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")


def _legacy_rollout(path: Path) -> None:
    lines = [
        json.dumps(
            {"id": LEGACY, "timestamp": "2025-09-05T10:21:17.734Z", "instructions": None, "git": {"branch": "main"}}
        ),
        json.dumps({"record_type": "state"}),
        json.dumps(
            {"type": "message", "id": None, "role": "user", "content": [{"type": "input_text", "text": "hello"}]}
        ),
        json.dumps({"type": "function_call", "name": "shell", "call_id": "c1", "arguments": "{}"}),
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")


@pytest.fixture
def home(tmp_path: Path) -> Path:
    home = tmp_path / "codex-home"
    home.mkdir()
    recent = NOW - timedelta(days=3)
    older = NOW - timedelta(days=40)
    ancient = NOW - timedelta(days=400)
    _state_db(
        home / "state_5.sqlite",
        [
            (THREAD, int(recent.replace(tzinfo=UTC).timestamp()), "vscode", 0),
            (
                CHILD,
                int(older.replace(tzinfo=UTC).timestamp()),
                json.dumps({"subagent": {"thread_spawn": {"parent_thread_id": THREAD}}}),
                1,
            ),
            (OLD, int(ancient.replace(tzinfo=UTC).timestamp()), "cli", 1),
        ],
    )
    _rollout(home / "sessions/2026/10/14" / f"rollout-2026-10-14T12-00-00-{THREAD}.jsonl", THREAD, recent)
    _rollout(
        home / "archived_sessions" / f"rollout-2026-09-07T12-00-00-{CHILD}.jsonl",
        CHILD,
        older,
        parent=THREAD,
        usage_records=False,
    )
    _rollout(home / "archived_sessions" / f"rollout-2025-09-12T12-00-00-{OLD}.jsonl", OLD, ancient)
    _legacy_rollout(home / "sessions/2025/09/05" / f"rollout-2025-09-05T10-21-17-{LEGACY}.jsonl")
    created_ms = int(recent.replace(tzinfo=UTC).timestamp() * 1000)
    _history_db(
        home / "thread_history_1.sqlite",
        [
            (
                THREAD,
                TURN,
                "u1",
                1,
                created_ms,
                "userMessage",
                {"type": "userMessage", "id": "u1", "content": [{"type": "text", "text": "find duckdb docs"}]},
            ),
            (
                THREAD,
                TURN,
                "e1",
                2,
                created_ms + 1000,
                "commandExecution",
                {
                    "type": "commandExecution",
                    "id": "e1",
                    "command": '/bin/zsh -lc "rg duckdb"',
                    "cwd": "/work",
                    "source": "unifiedExecStartup",
                    "status": "completed",
                    "commandActions": [{"type": "search", "command": "rg duckdb"}],
                    "aggregatedOutput": "a.py\n",
                    "exitCode": 0,
                    "durationMs": 3,
                },
            ),
            (
                THREAD,
                TURN,
                "f1",
                3,
                created_ms + 2000,
                "fileChange",
                {
                    "type": "fileChange",
                    "id": "f1",
                    "status": "completed",
                    "changes": [{"path": "a.py", "kind": {"type": "update"}, "diff": "@@ -1 +1 @@\n-x\n+y\n"}],
                },
            ),
            (
                THREAD,
                TURN,
                "m1",
                4,
                created_ms + 3000,
                "agentMessage",
                {"type": "agentMessage", "id": "m1", "text": "done", "phase": "final_answer"},
            ),
            (
                OLD,
                TURN,
                "m9",
                1,
                created_ms - 400 * 86400 * 1000,
                "agentMessage",
                {"type": "agentMessage", "id": "m9", "text": "ancient"},
            ),
        ],
    )
    _logs_db(home / "logs_2.sqlite")
    return home


def test_ingest_models_the_window_and_counts_the_rest(home: Path, tmp_path: Path):
    db = tmp_path / "out" / "history.duckdb"
    summary = ingest_codex_home(home, db, window_days=183, now=NOW)
    assert summary.tables["threads"] == 4
    assert summary.tables["spawn_edges"] == 1
    assert summary.unknown_line_types == {"mystery_type": 2}
    con = duckdb.connect(str(db), read_only=True)
    try:
        windows = dict(con.execute("select thread_id, in_window from coverage").fetchall())
        assert windows == {THREAD: True, CHILD: True, OLD: False, LEGACY: False}
        formats = dict(con.execute("select thread_id, rollout_format from coverage").fetchall())
        assert formats[LEGACY] == "legacy" and formats[THREAD] == "envelope"
        # Out-of-window threads contribute no facts, only their coverage and thread rows.
        assert con.execute("select count(*) from items where thread_id = ?", [OLD]).fetchone()[0] == 0
        assert con.execute("select count(*) from responses where thread_id = ?", [OLD]).fetchone()[0] == 0
        assert con.execute("select count(*) from logs").fetchone()[0] == 2
        # In-window facts.
        assert con.execute("select count(*) from items where thread_id = ?", [THREAD]).fetchone()[0] == 4
        # The child thread has no projection rows, so its one item comes from the rollout's item_completed event.
        derived = con.execute("select item_type, origin, text from items where thread_id = ?", [CHILD]).fetchall()
        assert derived == [("agentMessage", "rollout", "")]
        assert con.execute("select count(*) from item_blobs").fetchone()[0] == 5
        assert con.execute("select count(*) from responses").fetchone()[0] == 2
        assert con.execute("select count(*) from token_counts").fetchone()[0] == 4
        model, effort, ttft, window = con.execute(
            "select model, reasoning_effort, time_to_first_token_ms, model_context_window from turns "
            "where thread_id = ? and turn_id = ?",
            [THREAD, TURN],
        ).fetchone()
        assert (model, effort, ttft, window) == ("gpt-6-astra", "xhigh", 3000, 258400)
        assert (
            con.execute("select origin from turns where thread_id = ?", [THREAD]).fetchone()[0]
            == "thread_history_1+rollout"
        )
        assert con.execute("select model from responses limit 1").fetchone()[0] == "gpt-6-astra"
        # The child has no usage records, so usage_events derives deltas from its counters.
        basis = dict(con.execute("select basis, count(*) from usage_events group by 1").fetchall())
        assert basis == {"usage_record": 2, "counter_delta": 2}
        delta_total = con.execute(
            "select sum(total_tokens) from usage_events where basis = 'counter_delta'"
        ).fetchone()[0]
        assert delta_total == 2100
        forked = con.execute(
            "select forked_from_id, parent_thread_id, source_kind from threads where thread_id = ?", [CHILD]
        ).fetchone()
        assert forked == (THREAD, THREAD, "subagent")
        events = dict(con.execute("select event_type, count(*) from rollout_events group by 1").fetchall())
        assert events["compacted"] == 2 and events["task_complete"] == 2
        assert con.execute("select count(*) from response_items where origin = 'rollout-legacy'").fetchone()[0] == 0
        meta = dict(con.execute("select key, value from meta").fetchall())
        assert meta["schema_version"] == str(schema.SCHEMA_VERSION) and meta["source"] == "codex-fs"
        provenance = con.execute(
            "select source_id, agent, host_id, os_user, agent_versions, schema_version from provenance"
        ).fetchall()
        assert len(provenance) == 1 and provenance[0][1] == "codex" and provenance[0][0] == summary.source_id
        assert provenance[0][2] and provenance[0][3] and provenance[0][5] == schema.SCHEMA_VERSION
        assert json.loads(provenance[0][4]) == ["0.162.1"]
        for table in ("threads", "turns", "responses", "items", "item_blobs", "coverage", "rollout_events", "logs"):
            assert (
                con.execute(
                    f"select count(*) from {table} where source_id is distinct from ?", [summary.source_id]
                ).fetchone()[0]
                == 0
            )
        assert con.execute("select repo from threads where thread_id = ?", [THREAD]).fetchone()[0] == "repo"
        program = con.execute("select command_program, command_action from items where item_id = 'e1'").fetchone()
        assert program == ("rg", "search")
    finally:
        con.close()


def test_unlimited_window_models_everything_including_legacy(home: Path, tmp_path: Path):
    db = tmp_path / "all.duckdb"
    summary = ingest_codex_home(home, db, window_days=None, now=NOW, blobs=False)
    assert summary.window_cutoff is None
    assert summary.tables["item_blobs"] == 0
    con = duckdb.connect(str(db), read_only=True)
    try:
        assert con.execute("select count(*) from coverage where in_window").fetchone()[0] == 4
        assert con.execute("select count(*) from response_items where origin = 'rollout-legacy'").fetchone()[0] == 2
        assert con.execute("select count(*) from items where thread_id = ?", [OLD]).fetchone()[0] == 1
        assert con.execute("select count(*) from logs").fetchone()[0] == 3
    finally:
        con.close()


def test_cli_ingests_and_prints_schema(home: Path, tmp_path: Path):
    from pdum.agent_history.cli import app

    runner = CliRunner()
    result = runner.invoke(
        app, ["ingest", "codex", "--home", str(home), "--db", str(tmp_path / "cli.duckdb"), "--json"]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["tables"]["threads"] == 4 and payload["source"] == "codex-fs"
    result = runner.invoke(app, ["schema", "--json"])
    assert result.exit_code == 0
    contract = json.loads(result.output)
    assert contract["version"] == schema.SCHEMA_VERSION and "usage_events" in contract["views"]


def test_readonly_open_falls_back_when_the_wal_side_file_is_missing(tmp_path: Path):
    from pdum.agent_history.sqlite import open_readonly

    path = tmp_path / "wal.sqlite"
    connection = sqlite3.connect(path)
    connection.execute("pragma journal_mode=wal")
    connection.execute("create table t (x)")
    connection.execute("insert into t values (1)")
    connection.commit()
    connection.close()
    for side in ("-wal", "-shm"):
        Path(str(path) + side).unlink(missing_ok=True)
    opened, how = open_readonly(path)
    assert opened.execute("select count(*) from t").fetchone()[0] == 1
    opened.close()
    assert how in {"mode=ro", "query_only fallback (-shm absent)"}
    time.sleep(0)  # keep the import used in the fallback-free branch


def test_unmaterialized_projection_is_skipped(tmp_path: Path):
    """A home that only ran ``codex exec`` has thread_history_1.sqlite without its tables."""
    home = tmp_path / "home"
    home.mkdir()
    sqlite3.connect(home / "thread_history_1.sqlite").close()
    summary = ingest_codex_home(home, tmp_path / "codex.duckdb", window_days=183)
    assert "thread_history_1.sqlite has no projection tables" in summary.notes
    assert summary.tables["turns"] == 0

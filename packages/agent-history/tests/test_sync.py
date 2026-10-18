"""Incremental sync, the ledger, the configuration file and the MotherDuck-or-file target."""

import json
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import pytest
from pdum.agent_history import ledger
from pdum.agent_history.claude import ingest_claude_dir
from pdum.agent_history.codex import ingest_codex_home
from pdum.agent_history.config import ConfigError, load, profile_roots
from pdum.agent_history.sync import sync
from pdum.agent_history.targets import Target, TargetError
from test_claude_ingest import NOW, SESSION, _common, _ts, _usage, _write, claude_dir  # noqa: F401
from test_codex_ingest import THREAD, home  # noqa: F401

HOST = {"host_id": "feedfacefeedface", "hostname": "test", "platform": "test 1", "created_at": ""}


def _reply(session: str, moment: datetime, uuid: str, parent: str, message_id: str) -> dict:
    return {
        **_common(session, moment, uuid, parent, type="assistant", session_id=session),
        "message": {
            "id": message_id,
            "model": "claude-fable-5-1",
            "role": "assistant",
            "type": "message",
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "Done."}],
            "usage": _usage(3, 1000, 10, 7),
        },
    }


def _count(db: Path, sql: str, *params) -> int:
    con = duckdb.connect(str(db), read_only=True)
    try:
        return con.execute(sql, list(params)).fetchone()[0]
    finally:
        con.close()


def test_ledger_plan_detects_new_changed_and_gone(tmp_path: Path):
    file_a = tmp_path / "a.jsonl"
    file_a.write_text("x\n")
    unit_a = ledger.Unit.from_path("a", file_a, "fp1")
    stored = {
        "a": ledger.LedgerRow("a", str(file_a), unit_a.bytes, unit_a.mtime, "fp1", ledger.PRESENT, ["a"], NOW),
        "b": ledger.LedgerRow("b", "/gone/b.jsonl", 10, NOW, None, ledger.PRESENT, ["b", "b:x"], NOW),
        "c": ledger.LedgerRow("c", "/gone/c.jsonl", 10, NOW, None, ledger.GONE, ["c"], NOW),
    }
    scan = {"a": unit_a, "d": ledger.Unit("d", None, fingerprint="new")}
    plan = ledger.plan(scan, stored, full=False)
    assert set(plan.changed) == {"d"} and set(plan.unchanged) == {"a"} and set(plan.gone) == {"b"}
    assert ledger.plan(scan, stored, full=True).counts == {"changed": 2, "unchanged": 0, "gone": 1}
    assert ledger.plan({"a": ledger.Unit.from_path("a", file_a, "fp2")}, stored, full=False).counts["changed"] == 1
    rows = ledger.rows("src", "run", plan, stored, {"d": ["d"]}, NOW)
    assert {row[1]: row[6] for row in rows} == {"d": ledger.PRESENT, "b": ledger.GONE}
    assert json.loads(rows[1][7]) == ["b", "b:x"]


def test_claude_sync_replaces_only_the_files_that_changed(claude_dir: Path, tmp_path: Path):  # noqa: F811
    db = tmp_path / "sync.duckdb"
    first = ingest_claude_dir(claude_dir, db, window_days=183, now=NOW, mode="sync")
    assert first.mode == "sync" and first.units == {"changed": 6, "unchanged": 0, "gone": 0}
    assert _count(db, "select count(*) from threads") == 6
    assert _count(db, "select count(*) from ingest_ledger where status = 'present'") == 6
    responses_before = _count(db, "select count(*) from responses")
    edges_before = _count(db, "select count(*) from fork_edges")

    second = ingest_claude_dir(claude_dir, db, window_days=183, now=NOW, mode="sync")
    assert second.units == {"changed": 0, "unchanged": 6, "gone": 0}
    assert _count(db, "select count(*) from responses") == responses_before
    assert _count(db, "select count(*) from provenance") == 1
    assert _count(db, "select count(distinct run_id) from ingest_runs") == 2

    # The session file grows by one response: only that thread is re-read and replaced.
    session_file = claude_dir / "projects" / "-work-project" / f"{SESSION}.jsonl"
    moment = NOW - timedelta(days=2) + timedelta(hours=2)
    with session_file.open("a") as stream:
        stream.write(json.dumps(_reply(SESSION, moment, "a9x", "a5", "msg_new")) + "\n")
    third = ingest_claude_dir(claude_dir, db, window_days=183, now=NOW, mode="sync")
    assert third.units == {"changed": 1, "unchanged": 5, "gone": 0}
    assert _count(db, "select count(*) from responses") == responses_before + 1
    assert _count(db, "select count(*) from responses where response_id = 'msg_new'") == 1
    assert _count(db, "select count(*) from threads") == 6
    assert _count(db, "select count(*) from coverage") == 6
    assert _count(db, "select count(*) from fork_edges") == edges_before
    assert _count(db, "select count(*) from ingest_ledger where unit_id = ? and run_id = ?", SESSION, third.run_id) == 1

    # A deleted file is marked gone and its rows stay.
    agent_file = next((claude_dir / "projects" / "-work-project" / SESSION / "subagents").glob("agent-*.jsonl"))
    agent_file.unlink()
    fourth = ingest_claude_dir(claude_dir, db, window_days=183, now=NOW, mode="sync")
    assert fourth.units == {"changed": 0, "unchanged": 5, "gone": 1}
    assert _count(db, "select count(*) from threads") == 6
    assert _count(db, "select count(*) from ingest_ledger where status = 'gone'") == 1
    assert _count(db, "select count(*) from responses") == responses_before + 1

    # A full sync re-reads every present file and leaves the gone thread alone.
    fifth = ingest_claude_dir(claude_dir, db, window_days=183, now=NOW, mode="full")
    assert fifth.units == {"changed": 5, "unchanged": 0, "gone": 0}
    assert _count(db, "select count(*) from threads") == 6
    assert _count(db, "select count(*) from responses") == responses_before + 1

    # A target written by another schema version is refused unless rebuilt.
    con = duckdb.connect(str(db))
    con.execute("update meta set value = '4' where key = 'schema_version'")
    con.close()
    with pytest.raises(TargetError):
        ingest_claude_dir(claude_dir, db, window_days=183, now=NOW, mode="sync")
    rebuilt = ingest_claude_dir(claude_dir, db, window_days=183, now=NOW, mode="full")
    assert rebuilt.units["changed"] == 5 and _count(db, "select count(*) from threads") == 5


def test_codex_sync_appends_logs_and_replaces_changed_rollouts(home: Path, tmp_path: Path):  # noqa: F811
    db = tmp_path / "codex-sync.duckdb"
    first = ingest_codex_home(home, db, window_days=183, now=NOW, mode="sync")
    assert first.units["changed"] >= 4 and first.units["unchanged"] == 0
    threads = _count(db, "select count(*) from threads")
    logs = _count(db, "select count(*) from logs")
    second = ingest_codex_home(home, db, window_days=183, now=NOW, mode="sync")
    assert second.units["changed"] == 0 and second.units["unchanged"] == first.units["changed"]
    assert _count(db, "select count(*) from threads") == threads
    assert _count(db, "select count(*) from logs") == logs
    rollout = next((home / "sessions").glob(f"*/*/*/rollout-*-{THREAD}.jsonl"))
    with rollout.open("a") as stream:
        stream.write(
            json.dumps(
                {
                    "timestamp": _ts(NOW - timedelta(hours=1)),
                    "type": "event_msg",
                    "ordinal": 999,
                    "payload": {"type": "turn_aborted", "turn_id": "late", "reason": "interrupted"},
                }
            )
            + "\n"
        )
    third = ingest_codex_home(home, db, window_days=183, now=NOW, mode="sync")
    assert third.units["changed"] == 1
    assert _count(db, "select count(*) from threads") == threads
    assert _count(db, "select count(*) from rollout_events where event_type = 'turn_aborted' and turn_id = 'late'") == 1
    assert _count(db, "select count(*) from fork_edges") == _count(
        db, "select count(*) from thread_links where kind = 'forked-from'"
    )


def test_target_specs_and_tokens(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    local = Target(str(tmp_path / "x.duckdb"))
    assert not local.motherduck and local.path.name == "x.duckdb" and local.label.endswith("x.duckdb")
    cloud = Target("md:agent_history", "cloud", "MY_TOKEN")
    assert cloud.motherduck and cloud.label == "cloud"
    with pytest.raises(TargetError):
        _ = cloud.path
    monkeypatch.delenv("MOTHERDUCK_TOKEN", raising=False)
    monkeypatch.delenv("motherduck_token", raising=False)
    assert cloud.token() is None
    monkeypatch.setenv("MY_TOKEN", "secret")
    assert cloud.token() == "secret"
    monkeypatch.setenv("MOTHERDUCK_TOKEN", "other")
    assert Target("md:x").token() == "other"


def test_config_enumerates_sources_and_sync_covers_every_pair(
    claude_dir: Path,  # noqa: F811
    home: Path,  # noqa: F811
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    profiles = tmp_path / "claude-profiles"
    profile_project = profiles / "research" / "claude" / "projects" / "-work-other"
    _write(
        profile_project / "44444444-2222-4333-8444-555555555555.jsonl",
        [
            {
                **_common("44444444-2222-4333-8444-555555555555", NOW - timedelta(days=1), "pu1", None, type="user"),
                "message": {"role": "user", "content": "Hello from a profile"},
            }
        ],
    )
    (profiles / ".hidden").mkdir()
    assert [name for name, _ in profile_roots("claude", profiles)] == ["research"]
    config_path = tmp_path / "history.yaml"
    config_path.write_text(
        f"""
window_days: 183
sources:
  - agent: codex
    home: {home}
  - agent: claude
    dir: {claude_dir}
  - agent: claude
    profiles: {profiles}
  - agent: codex
    profiles: {tmp_path / "no-codex-profiles"}
targets:
  - name: local
    duckdb: {tmp_path / "agents.duckdb"}
"""
    )
    config = load(config_path)
    assert [(s.agent, s.label) for s in config.sources] == [
        ("codex", "home"),
        ("claude", "dir"),
        ("claude", "profile:research"),
    ]
    assert config.notes == [f"no codex profiles under {tmp_path / 'no-codex-profiles'}"]
    assert [t.label for t in config.targets] == ["local"]

    summaries = sync(config, now=NOW, host=HOST)
    assert [s.label for s in summaries] == ["home", "dir", "profile:research"]
    assert len({s.source_id for s in summaries}) == 3
    db = tmp_path / "agents.duckdb"
    assert _count(db, "select count(*) from provenance") == 3
    assert _count(db, "select count(distinct source_id) from threads") == 3
    assert _count(db, "select count(*) from threads where thread_id like '44444444%'") == 1
    again = sync(config, now=NOW, host=HOST)
    assert all(s.units["changed"] == 0 for s in again)
    with pytest.raises(ConfigError):
        sync(config, targets=["nope"], now=NOW, host=HOST)

    monkeypatch.setenv("PDUM_AGENT_HISTORY_CONFIG", str(tmp_path / "missing.yaml"))
    with pytest.raises(ConfigError):
        load()
    (tmp_path / "bad.yaml").write_text("sources: []\ntargets: []\n")
    with pytest.raises(ConfigError):
        load(tmp_path / "bad.yaml")


def test_cli_sync_prints_a_table_and_json(claude_dir: Path, tmp_path: Path):  # noqa: F811
    from pdum.agent_history.cli import app
    from typer.testing import CliRunner

    config_path = tmp_path / "history.yaml"
    config_path.write_text(
        f"sources:\n  - agent: claude\n    dir: {claude_dir}\n"
        f"targets:\n  - name: local\n    duckdb: {tmp_path / 'h.duckdb'}\n"
    )
    runner = CliRunner()
    example = runner.invoke(app, ["sync", "--example"])
    assert example.exit_code == 0 and "targets:" in example.output
    result = runner.invoke(app, ["sync", "--config", str(config_path), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert len(payload) == 1 and payload[0]["mode"] == "sync" and payload[0]["units"]["changed"] == 6
    table = runner.invoke(app, ["sync", "--config", str(config_path)])
    assert table.exit_code == 0 and "sync from" in table.output
    incremental = runner.invoke(
        app,
        ["ingest", "claude", "--claude-dir", str(claude_dir), "--db", str(tmp_path / "h.duckdb"), "--sync", "--json"],
    )
    assert incremental.exit_code == 0, incremental.output
    assert json.loads(incremental.output)["units"] == {"changed": 0, "unchanged": 6, "gone": 0}


def test_parallel_sub_agents_sharing_responses_are_counted_once(claude_dir: Path, tmp_path: Path):  # noqa: F811
    """Two unmarked sub-agent files that start with the same responses after their own prompt keep one owner."""
    moment = NOW - timedelta(days=2) + timedelta(minutes=30)
    agents_dir = claude_dir / "projects" / "-work-project" / SESSION / "subagents"
    for agent in ("twin1", "twin2"):
        base = {"isSidechain": True, "agentId": agent}
        lines = [
            {
                **_common(SESSION, moment, f"u-{agent}", None, promptId="p2", type="user", **base),
                "message": {"role": "user", "content": "Shared work"},
            },
            {
                **_reply(SESSION, moment + timedelta(seconds=2), f"a-{agent}", f"u-{agent}", "msg_shared"),
                **base,
            },
        ]
        del lines[1]["session_id"]
        _write(agents_dir / f"agent-{agent}.jsonl", lines)
    db = tmp_path / "twins.duckdb"
    summary = ingest_claude_dir(claude_dir, db, window_days=183, now=NOW, mode="sync")
    assert summary.derived["deduplicated"] == 1
    con = duckdb.connect(str(db), read_only=True)
    try:
        rows = con.execute(
            "select thread_id, origin from responses where response_id = 'msg_shared' order by thread_id"
        ).fetchall()
        assert [origin for _, origin in rows] == ["assistant", "copied-context"]
        shared = con.execute(
            "select count(*) from usage_events where thread_id like ? || ':twin%'", [SESSION]
        ).fetchone()[0]
        assert shared == 1
        duplicates = con.execute(
            "select count(*) - count(distinct source_id || response_id) from responses where origin <> 'copied-context'"
        ).fetchone()[0]
        assert duplicates == 0
    finally:
        con.close()
    again = ingest_claude_dir(claude_dir, db, window_days=183, now=NOW, mode="sync")
    assert again.derived["deduplicated"] == 0

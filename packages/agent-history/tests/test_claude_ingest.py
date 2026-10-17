"""Claude Code ingestion against a synthetic configuration directory."""

import json
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import pytest
from pdum.agent_history.claude import ingest_claude_dir, patch_line_counts

NOW = datetime(2026, 10, 17, 12, 0, 0)
SESSION = "11111111-2222-4333-8444-555555555555"
AGENT = "abc123"
OLD_SESSION = "99999999-2222-4333-8444-555555555555"


def _ts(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds") + "Z"


def _usage(uncached: int, cached: int, created: int, output: int, *, hour: int = 0, wasted: int = 0) -> dict:
    usage = {
        "input_tokens": uncached,
        "cache_creation_input_tokens": created,
        "cache_read_input_tokens": cached,
        "output_tokens": output,
        "service_tier": "standard",
        "cache_creation": {"ephemeral_5m_input_tokens": created - hour, "ephemeral_1h_input_tokens": hour},
    }
    if wasted:
        usage["iterations"] = [
            {"type": "message", "model": "claude-fable-5-1", "output_tokens": wasted, "stop_reason": "refusal"},
            {"type": "message", "model": "claude-fable-5-1", "output_tokens": output, "stop_reason": "end_turn"},
        ]
    return usage


def _common(session: str, moment: datetime, uuid: str, parent: str | None, **extra) -> dict:
    return {
        "parentUuid": parent,
        "isSidechain": False,
        "userType": "external",
        "cwd": "/work/project",
        "sessionId": session,
        "version": "2.1.302",
        "gitBranch": "main",
        "entrypoint": "cli",
        "sessionKind": "bg",
        "uuid": uuid,
        "timestamp": _ts(moment),
        **extra,
    }


def _session_lines(session: str, start: datetime) -> list[dict]:
    t = start
    lines: list[dict] = [{"type": "ai-title", "sessionId": session, "aiTitle": "Investigate the parser"}]
    lines.append({"type": "permission-mode", "sessionId": session, "permissionMode": "bypassPermissions"})
    lines.append(
        {
            **_common(session, t, "u1", None, promptId="p1", turnPosition=0, type="user"),
            "message": {"role": "user", "content": "Please list the files"},
        }
    )
    t += timedelta(seconds=4)
    lines.append(
        {
            **_common(
                session, t, "a1", "u1", type="assistant", requestId="req_1", effort="high", thinkingDurationMs=1500
            ),
            "message": {
                "id": "msg_1",
                "model": "claude-fable-5-1",
                "role": "assistant",
                "type": "message",
                "stop_reason": None,
                "content": [{"type": "thinking", "thinking": "Let me look."}],
                "usage": _usage(10, 20000, 5000, 60, hour=1200),
            },
        }
    )
    lines.append(
        {
            **_common(session, t, "a2", "a1", type="assistant", requestId="req_1", effort="high"),
            "message": {
                "id": "msg_1",
                "model": "claude-fable-5-1",
                "role": "assistant",
                "type": "message",
                "stop_reason": "tool_use",
                "content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls -la"}}],
                "usage": _usage(10, 20000, 5000, 20, hour=1200),
            },
        }
    )
    t += timedelta(seconds=2)
    lines.append(
        {
            **_common(session, t, "u2", "a2", type="user"),
            "message": {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "a.py\nb.py\n", "is_error": False}
                ],
            },
            "toolUseResult": {"stdout": "a.py\nb.py\n", "stderr": "", "interrupted": False, "isImage": False},
        }
    )
    t += timedelta(seconds=3)
    lines.append(
        {
            **_common(session, t, "a3", "u2", type="assistant", requestId="req_2", effort="high"),
            "message": {
                "id": "msg_2",
                "model": "claude-fable-5-1",
                "role": "assistant",
                "type": "message",
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "Two files. ```mermaid\ngraph TD\n```"}],
                "usage": _usage(5, 25000, 100, 30, wasted=12),
            },
        }
    )
    lines.append(
        {
            **_common(
                session,
                t,
                "s1",
                "a3",
                type="system",
                subtype="turn_duration",
                durationMs=9000,
                messageCount=4,
                isMeta=False,
            ),
        }
    )
    lines.append(
        {
            "type": "cost-state",
            "sessionId": session,
            "totalCostUSD": 0.12,
            "totalAPIDuration": 5000,
            "totalToolDuration": 2000,
            "totalLinesAdded": 0,
            "totalLinesRemoved": 0,
            "totalDuration": 9000,
            "modelUsage": {"claude-fable-5-1": {"inputTokens": 15, "outputTokens": 110, "costUSD": 0.12}},
        }
    )
    lines.append(
        {
            "type": "api-request",
            "sessionId": session,
            "id": "r1",
            "timestamp": _ts(t),
            "version": "2.1.302",
            "querySource": "repl_main_thread",
            "shapeHash": "x" * 64,
            "params": {"model": "claude-fable-5-1", "max_tokens": 128000, "output_config": {"effort": "high"}},
            "cacheControl": [{"path": ["system"], "value": {"type": "ephemeral"}}],
        }
    )
    t += timedelta(minutes=5)
    lines.append(
        {
            **_common(session, t, "u3", "a3", type="user", isCompactSummary=True),
            "message": {"role": "user", "content": "Summary of the conversation so far."},
        }
    )
    t += timedelta(seconds=5)
    lines.append(
        {
            **_common(session, t, "u3b", "u3", promptId="pc", type="user"),
            "message": {
                "role": "user",
                "content": "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
            },
        }
    )
    t += timedelta(seconds=5)
    lines.append(
        {
            **_common(session, t, "u4", "u3b", promptId="p2", turnPosition=1, type="user"),
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "Fix the bug"}, {"type": "image", "source": {}}],
            },
        }
    )
    t += timedelta(seconds=6)
    lines.append(
        {
            **_common(session, t, "a4", "u4", type="assistant", requestId="req_3", effort="high"),
            "message": {
                "id": "msg_3",
                "model": "claude-fable-5-1",
                "role": "assistant",
                "type": "message",
                "stop_reason": "tool_use",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_2",
                        "name": "Edit",
                        "input": {
                            "file_path": "/work/project/a.py",
                            "old_string": "x = 1",
                            "new_string": "x = 2\ny = 3",
                        },
                    }
                ],
                "usage": _usage(0, 30000, 50, 40),
            },
        }
    )
    t += timedelta(seconds=1)
    lines.append(
        {
            **_common(session, t, "u5", "a4", type="user"),
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_2", "content": "ok"}],
            },
            "toolUseResult": {
                "filePath": "/work/project/a.py",
                "oldString": "x = 1",
                "newString": "x = 2\ny = 3",
                "structuredPatch": [
                    {
                        "oldStart": 1,
                        "oldLines": 1,
                        "newStart": 1,
                        "newLines": 2,
                        "lines": ["-x = 1", "+x = 2", "+y = 3"],
                    }
                ],
            },
        }
    )
    t += timedelta(seconds=2)
    lines.append(
        {
            **_common(session, t, "a5", "u5", type="assistant", requestId="req_4", effort="high"),
            "message": {
                "id": "msg_4",
                "model": "claude-fable-5-1",
                "role": "assistant",
                "type": "message",
                "stop_reason": "tool_use",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_3",
                        "name": "Agent",
                        "input": {"description": "Check tests", "subagent_type": "Explore"},
                    }
                ],
                "usage": _usage(0, 30100, 10, 15),
            },
        }
    )
    lines.append({"type": "mystery-record", "sessionId": session})
    return lines


def _agent_lines(session: str, agent: str, start: datetime) -> list[dict]:
    t = start
    base = {"isSidechain": True, "agentId": agent}
    lines = [
        {"type": "started", "agentId": agent, "key": "review", "label": "Review", "phase": "Review"},
        {
            **_common(session, t - timedelta(minutes=10), f"copied-a-{agent}", None, type="assistant", **base),
            "message": {
                "id": "msg_2",
                "model": "claude-fable-5-1",
                "role": "assistant",
                "type": "message",
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "Two files."}],
                "usage": _usage(5, 25000, 100, 30),
            },
        },
        {
            **_common(session, t, f"au1-{agent}", None, promptId="p2", type="user", **base),
            "message": {"role": "user", "content": "Check tests"},
        },
        {
            "type": "fork-context-ref",
            "agentId": agent,
            "contextLength": 1200,
            "parentLastUuid": "a5",
            "parentSessionId": session,
        },
    ]
    t += timedelta(seconds=3)
    lines.append(
        {
            **_common(
                session,
                t,
                f"aa1-{agent}",
                f"au1-{agent}",
                type="assistant",
                requestId="req_a1",
                effort="medium",
                **base,
            ),
            "message": {
                "id": f"msg_{agent}_1",
                "model": "claude-haiku-5-5",
                "role": "assistant",
                "type": "message",
                "stop_reason": "tool_use",
                "content": [
                    {
                        "type": "tool_use",
                        "id": f"toolu_{agent}",
                        "name": "mcp__chrome-devtools__click",
                        "input": {"uid": "3"},
                    }
                ],
                "usage": _usage(100, 0, 2000, 12),
            },
        }
    )
    t += timedelta(seconds=1)
    lines.append(
        {
            **_common(session, t, f"au2-{agent}", f"aa1-{agent}", type="user", **base),
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": f"toolu_{agent}",
                        "content": "no such element",
                        "is_error": True,
                    }
                ],
            },
            "toolUseResult": "Error: no such element",
        }
    )
    t += timedelta(seconds=2)
    lines.append(
        {
            **_common(
                session,
                t,
                f"aa2-{agent}",
                f"au2-{agent}",
                type="assistant",
                requestId="req_a2",
                effort="medium",
                **base,
            ),
            "message": {
                "id": f"msg_{agent}_2",
                "model": "claude-haiku-5-5",
                "role": "assistant",
                "type": "message",
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "Done."}],
                "usage": _usage(0, 2100, 0, 5),
            },
        }
    )
    return lines


def _write(path: Path, lines: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")


@pytest.fixture
def claude_dir(tmp_path: Path) -> Path:
    root = tmp_path / "claude"
    project = root / "projects" / "-work-project"
    recent = NOW - timedelta(days=2)
    _write(project / f"{SESSION}.jsonl", _session_lines(SESSION, recent))
    _write(
        project / SESSION / "subagents" / f"agent-{AGENT}.jsonl",
        _agent_lines(SESSION, AGENT, recent + timedelta(minutes=6)),
    )
    _write(
        project / SESSION / "subagents" / "workflows" / "wf_1" / "agent-wf1.jsonl",
        _agent_lines(SESSION, "wf1", recent + timedelta(minutes=7)),
    )
    _write(project / f"{OLD_SESSION}.jsonl", _session_lines(OLD_SESSION, NOW - timedelta(days=400)))
    (root / "projects" / "-work-project" / "notes.txt").write_text("not a session\n")
    return root


def test_patch_line_counts():
    assert patch_line_counts([{"lines": ["-a", "+b", "+c", " d"]}, {"lines": ["+e"]}]) == (3, 1)
    assert patch_line_counts(None) is None


def test_claude_sessions_become_threads_turns_responses_and_items(claude_dir: Path, tmp_path: Path):
    summary = ingest_claude_dir(claude_dir, tmp_path / "claude.duckdb", window_days=183, now=NOW)
    assert summary.tables["threads"] == 4
    assert summary.unknown_line_types == {"mystery-record": 1}
    assert summary.ignored_line_types == {"permission-mode": 1}
    con = duckdb.connect(str(tmp_path / "claude.duckdb"), read_only=True)
    try:
        windows = dict(con.execute("select thread_id, in_window from coverage").fetchall())
        assert windows == {SESSION: True, f"{SESSION}:{AGENT}": True, f"{SESSION}:wf1": True, OLD_SESSION: False}
        title, model, effort, kind, cli = con.execute(
            "select title, model, reasoning_effort, source_kind, cli_version from threads where thread_id = ?",
            [SESSION],
        ).fetchone()
        assert (title, model, effort, kind, cli) == (
            "Investigate the parser",
            "claude-fable-5-1",
            "high",
            "claude",
            "2.1.302",
        )
        child = con.execute(
            "select parent_thread_id, forked_from_id, source_kind, model, agent_nickname from threads "
            "where thread_id = ?",
            [f"{SESSION}:{AGENT}"],
        ).fetchone()
        assert child == (SESSION, SESSION, "claude-subagent", "claude-haiku-5-5", AGENT)
        assert con.execute("select count(*) from spawn_edges").fetchone()[0] == 2
        workflow = con.execute("select agent_path from threads where thread_id = ?", [f"{SESSION}:wf1"]).fetchone()[0]
        assert workflow == "subagents/workflows/wf_1/agent-wf1"
        assert con.execute("select count(*) from response_items where item_type = 'local-command'").fetchone()[0] == 1
        turns = con.execute(
            "select turn_id, status, duration_ms, time_to_first_token_ms, model from turns "
            "where thread_id = ? order by rollout_ordinal",
            [SESSION],
        ).fetchall()
        assert turns[0] == ("p1", "completed", 9000, 4000, "claude-fable-5-1")
        assert turns[1][0] == "p2" and turns[1][1] == "interrupted"
        # One response per API message id, with Claude's cache fields mapped onto the shared columns.
        rows = con.execute(
            "select response_id, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, "
            "thread_total_tokens "
            "from responses where thread_id = ? order by rollout_ordinal",
            [SESSION],
        ).fetchall()
        assert rows[0] == ("msg_1", 25010, 20000, 5000, 60, 25070)
        tiers = con.execute(
            "select cache_write_1h_input_tokens, wasted_output_tokens from responses "
            "where response_id in ('msg_1', 'msg_2') and thread_id = ? order by rollout_ordinal",
            [SESSION],
        ).fetchall()
        assert tiers == [(1200, 0), (0, 12)]
        provenance = con.execute("select agent, agent_versions, source_id from provenance").fetchone()
        assert (
            provenance[0] == "claude"
            and json.loads(provenance[1]) == ["2.1.302"]
            and provenance[2] == summary.source_id
        )
        assert con.execute("select count(*) from items where source_id is null").fetchone()[0] == 0
        assert len(rows) == 4
        assert con.execute("select count(*) from usage_events where basis = 'usage_record'").fetchone()[0] == 8
        copied = con.execute(
            "select count(*), sum((origin = 'copied-context')::int) from responses where response_id = 'msg_2'"
        ).fetchone()
        assert copied == (3, 2)
        assert con.execute("select count(*) from items where origin = 'copied-context'").fetchone()[0] == 2
        assert con.execute("select count(*) from turns where origin = 'copied-context'").fetchone()[0] == 2
        child_total = con.execute(
            "select max(thread_total_tokens) from responses where thread_id = ?", [f"{SESSION}:{AGENT}"]
        ).fetchone()[0]
        assert child_total == 4217
        assert (
            con.execute("select count(*) from rollout_events where event_type = 'workflow:started'").fetchone()[0] == 2
        )
        items = dict(
            con.execute("select item_type, count(*) from items where thread_id = ? group by 1", [SESSION]).fetchall()
        )
        assert items == {
            "userMessage": 2,
            "reasoning": 1,
            "commandExecution": 1,
            "agentMessage": 1,
            "contextCompaction": 1,
            "fileChange": 1,
            "collabAgentToolCall": 1,
        }
        bash = con.execute(
            "select command_program, status, duration_ms, output_bytes, tool, exec_source from items "
            "where item_id = 'toolu_1'"
        ).fetchone()
        assert bash == ("ls", "completed", 2000, 10, "Bash", "claude")
        edit = con.execute(
            "select added_lines, deleted_lines, paths, status from items where item_id = 'toolu_2'"
        ).fetchone()
        assert edit == (2, 1, '["/work/project/a.py"]', "completed")
        agent = con.execute("select status, agent_kind from items where item_id = 'toolu_3'").fetchone()
        assert agent == ("inProgress", "Explore")
        mcp = con.execute(
            f"select server, tool, status, mcp_error from items where item_id = 'toolu_{AGENT}'"
        ).fetchone()
        assert mcp == ("chrome-devtools", "click", "failed", True)
        assert con.execute(
            "select has_mermaid from items where item_type = 'agentMessage' and thread_id = ?", [SESSION]
        ).fetchone()[0]
        events = dict(
            con.execute(
                "select event_type, count(*) from rollout_events where thread_id = ? group by 1", [SESSION]
            ).fetchall()
        )
        assert events == {"system:turn_duration": 1, "cost-state": 1, "api-request": 1, "compacted": 1}
        cost = json.loads(
            con.execute("select detail from rollout_events where event_type = 'cost-state'").fetchone()[0]
        )
        assert cost["totalCostUSD"] == 0.12
        blob = json.loads(con.execute("select item_json from item_blobs where item_id = 'toolu_1'").fetchone()[0])
        assert blob["call"]["name"] == "Bash" and blob["toolUseResult"]["stdout"].startswith("a.py")
        assert con.execute("select count(*) from token_counts").fetchone()[0] == 8
        assert con.execute("select count(*) from items where thread_id = ?", [OLD_SESSION]).fetchone()[0] == 0
    finally:
        con.close()


def test_cli_ingests_claude(claude_dir: Path, tmp_path: Path):
    from pdum.agent_history.cli import app
    from typer.testing import CliRunner

    result = CliRunner().invoke(
        app, ["ingest", "claude", "--claude-dir", str(claude_dir), "--db", str(tmp_path / "c.duckdb"), "--json"]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["source"] == "claude-fs" and payload["tables"]["threads"] == 4

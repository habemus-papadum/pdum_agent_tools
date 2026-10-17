"""Pure extraction from v2 thread items."""

from pdum.agent_history import items


def test_diff_line_counts_follow_codex_hunk_rules():
    diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n-old\n+new\n+added\n context\n"
    assert items.diff_line_counts(diff) == (2, 1)


def test_program_unwraps_login_shells_and_wrappers():
    assert items.program('/bin/zsh -lc "rg --files -g AGENTS.md"') == "rg"
    assert items.program("bash -c 'cd x && uv run pytest'") == "cd"
    assert items.program("sudo env FOO=1 python3 -m pytest") == "FOO=1"
    assert items.program("/usr/bin/env python3 script.py") == "python3"
    assert items.program("") is None
    assert items.program("/bin/zsh -lc ''") == "zsh"


def test_command_execution_columns_include_truncation_and_program():
    item = {
        "type": "commandExecution",
        "id": "exec-1",
        "command": '/bin/zsh -lc "cat README.md"',
        "cwd": "/tmp",
        "processId": "p1",
        "source": "unifiedExecStartup",
        "status": "completed",
        "commandActions": [{"type": "read", "command": "cat README.md"}],
        "aggregatedOutput": "x" * (64 * 1024),
        "exitCode": 0,
        "durationMs": 12,
    }
    out = items.extract(item)
    assert out["command_program"] == "cat"
    assert out["command_action"] == "read"
    assert out["output_bytes"] == 64 * 1024
    assert out["output_truncated"] is True
    assert out["exit_code"] == 0 and out["exec_duration_ms"] == 12
    assert out["text_len"] == len(item["command"])


def test_file_change_counts_lines_across_changes():
    item = {
        "type": "fileChange",
        "id": "fc-1",
        "status": "completed",
        "changes": [
            {"path": "a.py", "kind": {"type": "update"}, "diff": "@@ -1 +1 @@\n-a\n+b\n"},
            {"path": "b.py", "kind": {"type": "add"}, "diff": "@@ -0,0 +1,2 @@\n+x\n+y\n"},
        ],
    }
    out = items.extract(item)
    assert (out["added_lines"], out["deleted_lines"], out["n_parts"]) == (3, 1, 2)
    assert out["paths"] == '["a.py", "b.py"]'


def test_messages_and_tools_extract_text_and_flags():
    agent = items.extract(
        {"type": "agentMessage", "id": "m", "text": "See ```mermaid\ngraph TD\n``` and ![img](x.png)"}
    )
    assert agent["has_mermaid"] is True and agent["image_count"] == 1
    user = items.extract(
        {
            "type": "userMessage",
            "id": "u",
            "content": [{"type": "text", "text": "hi"}, {"type": "localImage", "path": "p"}],
        }
    )
    assert user["text"] == "hi" and user["image_count"] == 1 and user["n_parts"] == 2
    mcp = items.extract(
        {
            "type": "mcpToolCall",
            "id": "t",
            "server": "s",
            "tool": "t",
            "status": "failed",
            "error": {"m": 1},
            "durationMs": 5,
        }
    )
    assert mcp["mcp_error"] is True and mcp["text"] == "s:t"
    collab = items.extract({"type": "collabAgentToolCall", "id": "c", "tool": "wait", "receiverThreadIds": ["x", "y"]})
    assert collab["agent_thread_id"] == "x" and collab["n_parts"] == 2

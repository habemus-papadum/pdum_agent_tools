"""Offline checks of the recorded 028/032 evidence; no credentials or network used.

Pass the five run directories in order: joins, stream, native, health, pending.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def read(path: Path, name: str = "result.json") -> dict[str, Any]:
    return json.loads((path / name).read_text())


def events(messages: list[dict], method: str) -> list[dict]:
    return [m for m in messages if m.get("method") == method]


def history(path: Path, name: str) -> dict:
    value = read(path, name + ".json")
    return value.get("result", value)["thread"]


def completed_items(messages: list[dict], kind: str) -> list[dict]:
    return [m["params"]["item"] for m in events(messages, "item/completed") if m["params"]["item"]["type"] == kind]


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit("Usage: verify.py JOIN_RUN STREAM_RUN NATIVE_RUN HEALTH_RUN PENDING_RUN")
    join_path, stream_path, native_path, health_path, pending_path = map(Path, sys.argv[1:])
    runs = [read(p) for p in (join_path, stream_path, native_path, health_path, pending_path)]
    for run in runs:
        assert not run.get("error"), run.get("error")
        assert run["sourceAuthUnchanged"]
    joins, stream, native, health, pending = (r["cases"] for r in runs)
    request = joins["beforeTurn"]["callback"]
    assert not events(joins["beforeTurn"]["bEvents"], "item/tool/call")
    assert not events(joins["pendingInit"], "item/tool/call")
    assert not events(joins["pendingReadEvents"], "item/tool/call")
    assert events(joins["pendingResumeEvents"], "item/tool/call")[0]["id"] == request["id"]
    assert completed_items(joins["eitherResponder"]["a"], "agentMessage")[-1]["text"] == "FIRST_DONE"
    assert not events(joins["eitherResponder"]["a"], "serverRequest/resolved")
    assert len(completed_items(joins["race"]["a"], "dynamicToolCall")) == 1
    assert completed_items(joins["race"]["a"], "agentMessage")[-1]["text"] in ("ANSWER_A", "ANSWER_C")
    assert joins["allDisconnectedReplay"]["params"]["arguments"] == {"label": "disconnect"}
    assert len(history(join_path, "restart-resume")["turns"]) == 3
    assert all(t["status"] == "completed" for t in history(join_path, "restart-resume")["turns"])
    assert joins["staleSteer"]["error"]["code"] == -32600
    assert joins["unsubscribeD"]["result"]["status"] == "unsubscribed"
    full = completed_items(stream["stream"]["a"], "agentMessage")[-1]["text"]
    tail = "".join(m["params"]["delta"] for m in events(stream["stream"]["b"], "item/agentMessage/delta"))
    assert full.endswith(tail) and len(tail) < len(full)
    assert completed_items(stream["stream"]["b"], "agentMessage")[-1]["text"] == full
    assert len(events(stream["humanRace"]["a"], "serverRequest/resolved")) == 1
    starts = stream["competingStarts"]
    assert starts[0]["result"]["turn"]["id"] == starts[1]["result"]["turn"]["id"]
    assert stream["repeatAfterCompletion"]["result"]["turn"]["id"] != starts[0]["result"]["turn"]["id"]
    turns = history(stream_path, "duplicate-final")["turns"]
    assert sum(i["type"] == "userMessage" for i in turns[-2]["items"]) == 2
    assert native["direct"]["original"]["id"] == native["direct"]["replay"]["id"]
    assert completed_items(native["direct"]["a"], "agentMessage")[-1]["text"] == "DIRECT_DONE"
    assert runs[2]["relayStatus"]["relay"]["messages"] == 0
    commands = completed_items(health["local-tools"]["events"], "commandExecution")
    assert len(commands) == 4 and [i["exitCode"] for i in commands] == [0, 7, 7, 0]
    assert commands[-1]["durationMs"] >= 2500
    assert not health["sandboxFileExists"]
    assert not completed_items(health["sandbox-denial"]["events"], "commandExecution")
    denial_rollouts = list((health_path / "profile/codex/sessions").rglob("*.jsonl"))
    denial = [
        json.loads(line)
        for file in denial_rollouts
        for line in file.read_text().splitlines()
        if "custom_tool_call_output" in line and "denied-write" in line and "Operation not permitted" in line
    ]
    assert len(denial) == 1
    assert health["backgroundList"]["result"]["data"]
    assert history(health_path, "background-after-turn")["status"]["type"] == "idle"
    assert len(health["childIds"]) == 1
    child = history(health_path, "child-" + health["childIds"][0])
    assert child["parentThreadId"] and child["turns"][0]["status"] == "completed"
    assert health["injectedHttpRequests"] == ["POST /v1/responses HTTP/1.1"]
    errors = events(health["injected-provider-failure"]["events"], "error")
    assert len(errors) == 1 and errors[0]["params"]["willRetry"] is False
    assert errors[0]["params"]["error"]["codexErrorInfo"]["httpConnectionFailed"]["httpStatusCode"] == 503
    assert completed_items(pending["mcpEvents"], "mcpToolCall")[0]["durationMs"] >= 3900
    assert completed_items(pending["cancelledCallbackEvents"], "dynamicToolCall")[0]["status"] == "failed"
    assert not events(pending["cancelledCallbackEvents"], "serverRequest/resolved")
    before = pending["noClientsRelayBefore"]["relay"]
    after = pending["noClientsRelayAfter"]["relay"]
    assert before["connections"] == after["connections"] == 0
    assert before["messages"] == after["messages"]
    assert history(pending_path, "no-clients-resume")["turns"][-1]["status"] == "completed"
    estimates = [r["observedApiEquivalentUsd"] for r in runs]
    print(
        json.dumps(
            {
                "passed": True,
                "runs": 5,
                "missingStreamingCharacters": len(full) - len(tail),
                "estimates": estimates,
                "totalObservedApiEquivalentUsd": sum(estimates),
                "unknown": "warmups, unreported interrupted usage, actual subscription billing",
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

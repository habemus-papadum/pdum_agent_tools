"""Acceptance checks against an actual official-SDK family export, not synthetic sessions.

Set PDUM_CLAUDE_FAMILY_RUN to another collected family to repeat these checks.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

DEFAULT_RUN = Path(__file__).resolve().parents[2] / "artifacts/058-native-history-access/families/claude-20261024-d2"


@pytest.fixture(scope="module")
def run() -> Path:
    directory = Path(os.environ.get("PDUM_CLAUDE_FAMILY_RUN", DEFAULT_RUN))
    if not (directory / "family.json").exists():
        pytest.skip("Run the isolated official-SDK Claude family collector first")
    return directory


def read(run: Path, name: str):
    return json.loads((run / name).read_text())


def test_originals_and_copies_unchanged_and_helper_reaped(run: Path) -> None:
    source = read(run, "source-evidence.json")
    helper = read(run, "helper.json")
    evidence = read(run, "reader-evidence.json")
    assert source["sourceHashesBefore"] == source["sourceHashesAfter"]
    assert source["copyMatchesSource"] and source["copyUnchanged"] and source["temporaryHomeRemoved"]
    assert helper["returncode"] == 0 and helper["reaped"]
    assert helper["environmentKeys"] == ["CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH", "PYTHONDONTWRITEBYTECODE"]
    assert evidence["networkAttempts"] == evidence["providerCalls"] == evidence["inferenceUsd"] == 0


def test_every_native_child_export_keeps_root_and_agent_identity_distinct(run: Path) -> None:
    family = read(run, "family.json")
    assert family["completeness"]["allListedRead"]
    assert family["listedAgentIds"]
    assert not family["completeness"]["duplicateAgentIds"]
    assert not family["completeness"]["emptyAgentIds"]
    keys = set()
    for member in family["members"]:
        document = read(run / "documents", f"{member['key']}.json")
        keys.add(document["key"])
        assert document["sessionId"] == family["rootSessionId"]
        if member["kind"] == "subagent":
            assert document["source"]["relation"]["agentId"] == member["agentId"]
            assert member["agentId"] != document["sessionId"]
            assert document["payload"]["info"] is None
    assert len(keys) == len(family["members"])


def test_native_pagination_equals_full_visible_chain_slice(run: Path) -> None:
    evidence = read(run, "reader-evidence.json")
    assert evidence["mainPageMatches"] and evidence["childPageMatches"]
    assert evidence["subagentListingUnchanged"]
    methods = {call["method"] for call in evidence["calls"]}
    assert methods == {"get_session_info", "get_session_messages", "list_subagents", "get_subagent_messages"}
    assert all("reader call latency" in call["elapsedMeaning"] for call in evidence["calls"])


def test_native_fields_do_not_fabricate_execution_or_background_duration(run: Path) -> None:
    timing = read(run, "timing.json")
    assert timing
    for row in timing.values():
        assert row["messages"] > 0
        assert row["wrapperTimestamps"] == 0
        assert row["structuredTimingFieldCounts"] == {}
        assert row["executionDuration"] == row["backgroundLifetime"] == "not derived"


def test_missing_parent_metadata_does_not_establish_a_root_edge(run: Path) -> None:
    family = read(run, "family.json")
    native_tools = {}
    for path in (run / "documents").glob("*.json"):
        document = json.loads(path.read_text())
        agent = document["source"]["relation"].get("agentId", "root")
        calls, results = set(), set()
        for wrapper in document["payload"]["messages"]:
            content = wrapper.get("message", {}).get("content", [])
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    calls.add(block.get("id"))
                elif block.get("type") == "tool_result":
                    results.add(block.get("tool_use_id"))
        native_tools[agent] = (calls, results)
    for edge in family["edges"]:
        calls, results = native_tools.get(edge["candidateParent"], (set(), set()))
        tools = set(edge["parentToolUseIds"])
        assert edge["parentCallVisible"] == bool(tools & calls)
        assert edge["parentResultVisible"] == bool(tools & results)
        if not edge["parentAgentIds"] and not edge["parentCallVisible"]:
            assert edge["parentResolution"] == "main-or-unknown"
            assert edge["parentDocumentAvailable"] is None
        if edge["parentAgentIds"]:
            assert edge["parentResolution"] == "sdk-parent-agent"
    assert family["completeness"]["missingParentCalls"] == sum(
        not edge["parentCallVisible"] for edge in family["edges"]
    )
    assert family["completeness"]["missingParentResults"] == sum(
        not edge["parentResultVisible"] for edge in family["edges"]
    )

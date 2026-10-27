"""Read a complete selected Codex family and native item clocks without running it.

Only explicitly selected native history is copied into an isolated Codex home.
Headers help select the files; all rendered history, relations and timing come
from native app-server responses. Output is private evidence, not a new SDK or
ingestion schema. This command never changes the historical viewer catalogue.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path
from typing import Any

import typer
from export_history import Reader, save

app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)


def sha256(path: Path) -> str:
    """Hash file bytes for snapshot and original-history comparison."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def history_index(source: Path) -> dict[str, dict[str, Any]]:
    """Index only native rollout headers for selecting copies, never rendering."""
    result: dict[str, dict[str, Any]] = {}
    for directory in ("sessions", "archived_sessions"):
        for path in sorted((source / directory).rglob("*.jsonl")):
            if path.is_symlink() or not path.is_file():
                continue
            try:
                with path.open() as stream:
                    first = json.loads(stream.readline())
            except (OSError, ValueError):
                continue
            metadata = first.get("payload", {})
            identity = metadata.get("id") or metadata.get("session_id")
            if first.get("type") != "session_meta" or not isinstance(identity, str):
                continue
            if identity in result:
                raise ValueError("Multiple rollout files identify one thread; select an unambiguous snapshot")
            result[identity] = {
                "path": str(path),
                "relativePath": str(path.relative_to(source)),
                "parentThreadId": metadata.get("parent_thread_id"),
                "forkedFromId": metadata.get("forked_from_id"),
                "subagentHistoryStartOrdinal": metadata.get("subagent_history_start_ordinal"),
            }
    return result


def selected_descendants(index: dict[str, Any], parent_id: str) -> list[str]:
    """Select the explicit native-header parent relation recursively."""
    if parent_id not in index:
        raise ValueError("Selected parent has no native rollout in this home")
    selected = [parent_id]
    for identity in selected:
        selected.extend(
            sorted(child for child, row in index.items() if row["parentThreadId"] == identity and child not in selected)
        )
    return selected


def native_items(thread: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Retain native turn/item associations; do not flatten away their identity."""
    return [(turn["id"], item) for turn in thread.get("turns", []) for item in turn.get("items", [])]


def activity_references(thread: dict[str, Any]) -> set[str]:
    """Return references requiring inspection, not assumed parent-child edges."""
    result: set[str] = set()
    for _, item in native_items(thread):
        if item.get("type") == "subAgentActivity" and isinstance(item.get("agentThreadId"), str):
            result.add(item["agentThreadId"])
        elif item.get("type") == "collabAgentToolCall":
            result.update(value for value in item.get("receiverThreadIds", []) if isinstance(value, str))
            result.update(item.get("agentsStates", {}))
    result.discard(thread["id"])
    return result


def numeric(value: Any) -> bool:
    """Whether a native clock field is a number; booleans are not timestamps."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def timing_report(thread: dict[str, Any], pages: list[dict[str, Any]]) -> dict[str, Any]:
    """Compare separate reported clocks without asserting equivalent meanings."""
    full = native_items(thread)
    full_keys = {(turn_id, item["id"]) for turn_id, item in full}
    records = [record for page in pages for record in page.get("result", {}).get("data", [])]
    page_keys = {(record.get("turnId"), record.get("item", {}).get("id")) for record in records}
    by_type: dict[str, Counter[str]] = {}
    measurements = []
    page_clock_ranges = {"startedAtMs": [], "completedAtMs": []}
    for record in records:
        item = record.get("item", {})
        kind = item.get("type", "unknown")
        counts = by_type.setdefault(kind, Counter())
        counts["items"] += 1
        start, end, duration = record.get("startedAtMs"), record.get("completedAtMs"), item.get("durationMs")
        if numeric(start):
            counts["started"] += 1
            page_clock_ranges["startedAtMs"].append(start)
        if numeric(end):
            counts["completed"] += 1
            page_clock_ranges["completedAtMs"].append(end)
        if numeric(duration):
            counts["reportedDuration"] += 1
        interval = end - start if numeric(start) and numeric(end) else None
        if interval is not None:
            counts["bothEndpoints"] += 1
            if interval < 0:
                counts["negativeInterval"] += 1
        difference = interval - duration if interval is not None and numeric(duration) else None
        if difference is not None:
            counts["durationComparable"] += 1
            counts["sameNumericValue" if difference == 0 else "differentNumericValue"] += 1
        measurements.append(
            {
                "turnId": record.get("turnId"),
                "itemId": item.get("id"),
                "type": kind,
                "position": record.get("position"),
                "startedAtMs": start,
                "completedAtMs": end,
                "endpointIntervalMs": interval,
                "reportedDurationMs": duration,
                "intervalMinusReportedMs": difference,
            }
        )
    turn_clocks = [
        {
            "turnId": turn["id"],
            "startedAtUnixSeconds": turn.get("startedAt"),
            "completedAtUnixSeconds": turn.get("completedAt"),
            "reportedDurationMs": turn.get("durationMs"),
        }
        for turn in thread.get("turns", [])
    ]
    discrepancies = {}
    for kind in by_type:
        differences = [
            row["intervalMinusReportedMs"]
            for row in measurements
            if row["type"] == kind and row["intervalMinusReportedMs"] is not None
        ]
        if differences:
            discrepancies[kind] = {
                "compared": len(differences),
                "minimumMs": min(differences),
                "maximumMs": max(differences),
                "maximumAbsoluteMs": max(abs(value) for value in differences),
                "absoluteOver2Ms": sum(abs(value) > 2 for value in differences),
                "absoluteOver100Ms": sum(abs(value) > 100 for value in differences),
            }
    return {
        "fullItems": len(full),
        "pagedItems": len(records),
        "fullUniqueIdentities": len(full_keys),
        "pageUniqueIdentities": len(page_keys),
        "matchedIdentities": len(full_keys & page_keys),
        "missingFromPages": len(full_keys - page_keys),
        "notInFullRead": len(page_keys - full_keys),
        "pageErrors": [page["error"] for page in pages if "error" in page],
        "byType": {kind: dict(counts) for kind, counts in by_type.items()},
        "itemClockRanges": {
            key: {"min": min(values), "max": max(values)} if values else None
            for key, values in page_clock_ranges.items()
        },
        "turnClocks": turn_clocks,
        "turnClockCoverage": {
            key: sum(numeric(turn[key]) for turn in turn_clocks)
            for key in ("startedAtUnixSeconds", "completedAtUnixSeconds", "reportedDurationMs")
        },
        "durationComparisons": discrepancies,
        "measurements": measurements,
        "meaning": "Item producer endpoints, item-reported duration and turn clocks are distinct. "
        "A numeric discrepancy is evidence to interpret, not a failed equality invariant.",
    }


def family_report(parent_id: str, documents: list[dict[str, Any]], unresolved: dict[str, Any]) -> dict[str, Any]:
    """Record exact native relation/activity references and inherited overlap."""
    by_id = {doc["sessionId"]: doc["payload"]["thread"] for doc in documents}
    rows = []
    for identity, thread in by_id.items():
        pairs = native_items(thread)
        parent = by_id.get(thread.get("parentThreadId"))
        inherited = {(turn, item["id"]) for turn, item in native_items(parent)} if parent else set()
        exact_parent = {json.dumps(item, sort_keys=True) for _, item in native_items(parent)} if parent else set()
        activities = [
            {"turnId": turn_id, "item": item}
            for turn_id, item in pairs
            if item.get("type") in ("subAgentActivity", "collabAgentToolCall")
        ]
        message_markers = []
        for turn_id, item in pairs:
            # These are candidate message envelopes only; retained text is not
            # parsed into delivery acknowledgements or a new mailbox protocol.
            content = item.get("text", "")
            if item.get("type") == "userMessage":
                content = "\n".join(
                    part.get("text", "") for part in item.get("content", []) if part.get("type") == "text"
                )
            if "Message Type:" in content or "<agent_message" in content:
                message_markers.append({"turnId": turn_id, "itemId": item["id"], "nativeType": item["type"]})
        rows.append(
            {
                "threadId": identity,
                "parentThreadId": thread.get("parentThreadId"),
                "forkedFromId": thread.get("forkedFromId"),
                "source": thread.get("source"),
                "threadSource": thread.get("threadSource"),
                "turns": len(thread.get("turns", [])),
                "items": len(pairs),
                "referencedThreadIds": sorted(activity_references(thread)),
                "activities": activities,
                "messageEnvelopeCandidates": message_markers,
                "sharedParentTurnItemIdentities": sum((turn, item["id"]) in inherited for turn, item in pairs),
                "byteEquivalentParentItems": sum(json.dumps(item, sort_keys=True) in exact_parent for _, item in pairs),
                "ownWorkQualification": "Inherited native history may repeat ancestor work. "
                "No unique-own-work or billing total is inferred by subtraction.",
            }
        )
    overlap = []
    for left_id, right_id in combinations(by_id, 2):
        left, right = by_id[left_id], by_id[right_id]
        left_items = {item["id"] for _, item in native_items(left)}
        right_items = {item["id"] for _, item in native_items(right)}
        left_turns = {turn["id"] for turn in left.get("turns", [])}
        right_turns = {turn["id"] for turn in right.get("turns", [])}
        overlap.append(
            {
                "leftThreadId": left_id,
                "rightThreadId": right_id,
                "sharedNativeItemIds": len(left_items & right_items),
                "sharedNativeTurnIds": len(left_turns & right_turns),
            }
        )
    completed = []
    for row in rows:
        for activity in row["activities"]:
            item = activity["item"]
            if item.get("type") != "subAgentActivity" or item.get("kind") != "completed":
                continue
            target = by_id.get(item["agentThreadId"])
            candidate_turn = item["id"].removeprefix("subagent-completed-")
            completed.append(
                {
                    "observerThreadId": row["threadId"],
                    "observerTurnId": activity["turnId"],
                    "agentThreadId": item["agentThreadId"],
                    "activityItemId": item["id"],
                    "outcomeTurnId": candidate_turn,
                    "matchesTargetTurn": target is not None
                    and any(turn["id"] == candidate_turn for turn in target.get("turns", [])),
                }
            )
    return {
        "parentThreadId": parent_id,
        "threads": rows,
        "unresolvedReferences": unresolved,
        "pairwiseNativeIdentityOverlap": overlap,
        "completionOutcomeReferences": completed,
        "rootTurnIdCoverage": {
            identity: sum(turn.get("rootTurnId") is not None for turn in thread.get("turns", []))
            for identity, thread in by_id.items()
        },
        "completionQualification": "A stored child work-outcome event is not process termination. "
        "Match outcome turn identity; one child can complete many turns.",
    }


async def collect(source: Path, parent_id: str, output: Path, binary: Path, max_threads: int) -> None:
    """Snapshot, read all reachable selected records, then close the owned server."""
    if output.exists():
        raise ValueError("Choose a new private output directory")
    output.mkdir(parents=True)
    index = history_index(source)
    selected = selected_descendants(index, parent_id)
    if len(selected) > max_threads:
        raise ValueError("Header descendant closure exceeds this experiment's explicit thread bound")
    save(
        output / "selection.json",
        {
            "sourceHome": str(source),
            "parentThreadId": parent_id,
            "initialThreadIds": selected,
            "maxThreads": max_threads,
            "headerSelection": {identity: index[identity] for identity in selected},
        },
    )
    documents, unresolved, before = [], {}, {}
    captured_at = datetime.now(timezone.utc).isoformat()
    with tempfile.TemporaryDirectory(prefix="pdum-058-family-codex-") as temporary:
        root = Path(temporary)
        home, profile, work = (root / name for name in ("home", "codex", "work"))
        for directory in (home, profile, work):
            directory.mkdir()

        def copy_thread(identity: str) -> None:
            row = index[identity]
            original = Path(row["path"])
            before[str(original)] = sha256(original)
            target = profile / row["relativePath"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            if sha256(target) != before[str(original)]:
                raise RuntimeError("Selected source changed during copy")

        for identity in selected:
            copy_thread(identity)
        projection = source / "thread_history_1.sqlite"
        with sqlite3.connect(f"{projection.as_uri()}?mode=ro", uri=True) as src:
            with sqlite3.connect(profile / projection.name) as dst:
                src.backup(dst)
        environment = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(home),
            "CODEX_HOME": str(profile),
            "TMPDIR": temporary,
            "LANG": "en_US.UTF-8",
        }
        version_process = await asyncio.create_subprocess_exec(
            str(binary), "--version", env=environment, stdout=asyncio.subprocess.PIPE
        )
        version = (await version_process.communicate())[0].decode().strip()
        overrides = [
            "analytics.enabled=false",
            "feedback.enabled=false",
            'cli_auth_credentials_store="file"',
            "features.apps=false",
            "features.plugins=false",
            "skills.bundled.enabled=false",
            'model_provider="history_offline"',
            'model_providers.history_offline.name="History only"',
            'model_providers.history_offline.base_url="http://127.0.0.1:1"',
            "model_providers.history_offline.requires_openai_auth=false",
            'model_providers.history_offline.wire_api="responses"',
        ]
        with (output / "codex-stderr.log").open("wb") as stderr:
            process = await asyncio.create_subprocess_exec(
                str(binary),
                "app-server",
                "--listen",
                "stdio://",
                *[part for value in overrides for part in ("-c", value)],
                cwd=work,
                env=environment,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=stderr,
            )
            reader = Reader(process, output / "codex-protocol.jsonl")
            timings = []
            try:
                await reader.ok(
                    "initialize",
                    {
                        "clientInfo": {"name": "spike_058_family_clocks", "version": "0.0.0"},
                        "capabilities": {"experimentalApi": True},
                    },
                )
                loaded_before = await reader.ok("thread/loaded/list")
                for identity in selected:
                    start = time.monotonic()
                    response = await reader.call("thread/read", {"threadId": identity, "includeTurns": True})
                    if "error" in response:
                        unresolved[identity] = {"reason": "native-read-error", "response": response}
                        continue
                    thread = response["result"]["thread"]
                    for reference in sorted(activity_references(thread)):
                        if reference in selected or reference in unresolved:
                            continue
                        if reference not in index:
                            unresolved[reference] = {"reason": "no-selected-source-rollout", "referencedBy": identity}
                        elif len(selected) >= max_threads:
                            unresolved[reference] = {"reason": "explicit-experiment-bound", "referencedBy": identity}
                        else:
                            copy_thread(reference)
                            selected.append(reference)
                    pages = await reader.pages(
                        "thread/items/list",
                        {
                            "threadId": identity,
                            "sortDirection": "asc",
                            "limit": 100,
                        },
                    )
                    report = timing_report(thread, pages)
                    document = {
                        "version": 1,
                        "key": f"codex-{identity}",
                        "provider": "codex",
                        "sessionId": identity,
                        "title": thread.get("name") or thread.get("preview") or "Captured Codex family member",
                        "source": {
                            "kind": "native-api",
                            "corpus": "family-timing-study",
                            "capturedAt": captured_at,
                            "method": "app-server thread/read + thread/items/list",
                            "version": version,
                            "readOnly": True,
                            "host": "isolated local history snapshot",
                        },
                        "payload": {"thread": thread, "itemPages": pages},
                    }
                    documents.append(document)
                    save(output / "documents" / f"{document['key']}.json", document)
                    save(output / "timing" / f"{document['key']}.json", report)
                    timings.append(
                        {
                            "threadId": identity,
                            "elapsedSeconds": time.monotonic() - start,
                            **{
                                key: value for key, value in report.items() if key not in ("measurements", "turnClocks")
                            },
                        }
                    )
                loaded_after = await reader.ok("thread/loaded/list")
                assert loaded_before["data"] == loaded_after["data"] == []
                assert not any(
                    message.get("method", "").startswith(("turn/", "item/"))
                    or message.get("method") == "thread/tokenUsage/updated"
                    for message in reader.notifications
                )
            finally:
                if process.stdin:
                    process.stdin.close()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
        after = {path: sha256(Path(path)) for path in before}
        assert before == after, "Source changed during inspection; do not claim unchanged history"
        save(output / "family.json", family_report(parent_id, documents, unresolved))
        save(
            output / "evidence.json",
            {
                "capturedAt": captured_at,
                "version": version,
                "binarySha256": sha256(binary),
                "methods": dict(reader.methods),
                "notifications": reader.notifications,
                "loadedBefore": loaded_before,
                "loadedAfter": loaded_after,
                "sourceHashesBefore": before,
                "sourceHashesAfter": after,
                "sourceHistoryUnchanged": True,
                "ownedProcessReaped": process.returncode is not None,
                "selectedThreads": len(selected),
                "readThreads": len(documents),
                "unresolvedReferences": unresolved,
                "timing": timings,
                "inference": {"submittedTurns": 0, "providerTokens": 0, "estimatedNewInferenceUsd": 0},
            },
        )
    print(
        json.dumps(
            {
                "output": str(output),
                "threads": len(documents),
                "unresolved": len(unresolved),
                "items": sum(len(native_items(doc["payload"]["thread"])) for doc in documents),
                "sourceHistoryUnchanged": True,
                "newInferenceUsd": 0,
            }
        )
    )


@app.command()
def main(
    source_home: Path = typer.Option(..., exists=True, file_okay=False),
    parent_id: str = typer.Option(...),
    output: Path = typer.Option(...),
    binary: Path = typer.Option(..., exists=True, dir_okay=False),
    max_threads: int = typer.Option(24, min=1),
) -> None:
    """Inspect one bounded family; no auth, resume, fork, send or model call."""
    os.umask(0o077)
    asyncio.run(collect(source_home.expanduser().resolve(), parent_id, output.resolve(), binary.resolve(), max_threads))


if __name__ == "__main__":
    app()

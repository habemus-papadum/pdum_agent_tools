"""Bookmark independently captured rich messages without inventing a conversation.

Run from the production uv workspace. A private selection names existing native
export files and exact message positions. The collector copies those envelopes
byte-for-byte and copies only already-exported, hash-named image assets. It does
not read provider credentials, launch a provider, mutate the ordinary catalogue,
or manufacture missing message content.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import typer
from export_history import save
from extend_corpus import has_prose_math

app = typer.Typer(add_completion=False, pretty_exceptions_show_locals=False)


def digest(path: Path) -> str:
    """Return a file fingerprint without printing its contents."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def native_message(document: dict[str, Any], position: dict[str, Any]) -> dict[str, Any]:
    """Resolve one exact native position and distinguish direct images from tool images."""
    provider = document["provider"]
    if provider == "codex":
        turns = document["payload"]["thread"]["turns"]
        turn_index, item_index = position["turnIndex"], position["itemIndex"]
        turn, item = turns[turn_index], turns[turn_index]["items"][item_index]
        if item["type"] not in ("userMessage", "agentMessage"):
            raise ValueError("Bookmark must target an actual user or assistant message, not a tool result")
        role = "user" if item["type"] == "userMessage" else "assistant"
        blocks = item["content"] if role == "user" else [{"type": "text", "text": item["text"]}]
        text = "\n".join(block.get("text", "") for block in blocks if block.get("type") == "text")
        ordinal = sum(len(value["items"]) for value in turns[:turn_index]) + item_index
        identity = {
            "turnId": turn["id"],
            "itemId": item["id"],
            "uuid": None,
            "ordinal": ordinal,
            "turnIndex": turn_index,
            "itemIndex": item_index,
            "projectedItemId": f"{document['key']}:{turn_index}:{item_index}",
        }
        phase = item.get("phase")
    elif provider == "claude":
        ordinal = position["ordinal"]
        wrapper = document["payload"]["messages"][ordinal]
        item = wrapper["message"]
        role = item["role"]
        blocks = item.get("content", [])
        blocks = [{"type": "text", "text": blocks}] if isinstance(blocks, str) else blocks
        if role not in ("user", "assistant") or any(block.get("type") == "tool_result" for block in blocks):
            raise ValueError("Tool results are not human prompts or assistant-authored image messages")
        text = "\n".join(block.get("text", "") for block in blocks if block.get("type") == "text")
        identity = {
            "turnId": None,
            "itemId": wrapper.get("uuid") or item.get("id"),
            "uuid": wrapper.get("uuid"),
            "ordinal": ordinal,
            "projectedItemId": f"{document['key']}:{ordinal}",
        }
        phase = None  # Native stop_reason is not a message phase or proof of finality.
    else:
        raise ValueError("Unsupported native provider")
    if text.lstrip().startswith(
        (
            "[external_agent_",
            "<task-notification>",
            "Another Claude session sent a message:",
            "This session is being continued from a previous conversation",
        )
    ):
        raise ValueError("Imported tool text, agent notices and compaction summaries are not authored-message examples")
    direct_images = [
        block for block in blocks if block.get("type") in ("image", "localImage", "input_image", "output_image")
    ]
    features = []
    if text.strip():
        features.append("text")
    if direct_images:
        features.append("image")
    if has_prose_math(text):
        features.append("math-in-prose")
    return {**identity, "role": role, "phase": phase, "features": features, "directImageCount": len(direct_images)}


def collect(selection_file: Path, output: Path) -> dict[str, Any]:
    """Copy selected native evidence and publish a separate independent-example manifest."""
    if any((output / name).exists() for name in ("collection.json", "documents", "assets")):
        raise ValueError("Choose an output without an existing collection, documents or assets")
    selection = json.loads(selection_file.read_text())
    output.mkdir(parents=True, exist_ok=True)
    documents: dict[str, dict[str, Any]] = {}
    bookmarks, source_hashes, assets = [], {}, {}
    for chosen in selection["bookmarks"]:
        source = (selection_file.parent / chosen["documentPath"]).resolve()
        before = digest(source)
        document = json.loads(source.read_text())
        key = document["key"]
        if document["source"].get("kind") != "native-api" or not re.fullmatch(r"(?:codex|claude)-[A-Za-z0-9_-]+", key):
            raise ValueError("Select an actual captured native API envelope")
        resolved = native_message(document, chosen)
        if resolved["itemId"] != chosen["itemId"] or resolved["turnId"] != chosen.get("turnId"):
            raise ValueError("Native message identity differs from the explicit selection")
        if resolved["role"] != chosen["role"] or resolved["phase"] != chosen.get("phase"):
            raise ValueError("Native message role/phase differs from the explicit selection")
        if not set(chosen["requiredFeatures"]) <= set(resolved["features"]):
            raise ValueError("The native message does not contain the requested rich-content feature")
        source_hashes[str(source)] = before
        if key not in documents:
            target = output / "documents" / f"{key}.json"
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(source, target)
            if digest(target) != before:
                raise RuntimeError("Copied native envelope differs from its source")
            documents[key] = {
                "key": key,
                "file": f"documents/{key}.json",
                "provider": document["provider"],
                "sessionId": document["sessionId"],
                "label": chosen["documentLabel"],
                "sha256": before,
                "bytes": target.stat().st_size,
            }
            for asset in document["source"].get("assets", []):
                path = asset.get("path")
                if asset.get("kind") != "copied-at-export" or not isinstance(path, str):
                    continue
                if not re.fullmatch(r"assets/[a-f0-9]{64}\.(?:png|jpg|jpeg|webp|gif)", path):
                    raise ValueError("Asset sidecar must name an already-exported hash-named image")
                asset_source = source.parent.parent / path
                if not asset_source.is_file():
                    assets[path] = {"path": path, "available": False, "reason": "Previously exported asset unavailable"}
                    continue
                asset_sha = digest(asset_source)
                if asset_sha != asset.get("sha256") or Path(path).stem != asset_sha:
                    raise ValueError("Exported asset bytes differ from their captured hash")
                target_asset = output / path
                target_asset.parent.mkdir(exist_ok=True)
                shutil.copyfile(asset_source, target_asset)
                assets[path] = {
                    "path": path,
                    "available": True,
                    "sha256": asset_sha,
                    "bytes": target_asset.stat().st_size,
                    "qualification": asset.get("qualification"),
                }
        bookmarks.append(
            {
                "id": chosen["id"],
                "label": chosen["label"],
                "actorLabel": chosen["actorLabel"],
                "documentKey": key,
                "provider": document["provider"],
                **resolved,
            }
        )
    if len({bookmark["id"] for bookmark in bookmarks}) != len(bookmarks):
        raise ValueError("Bookmark identifiers must be unique")
    if selection["initialBookmarkId"] not in {bookmark["id"] for bookmark in bookmarks}:
        raise ValueError("Initial bookmark must identify an actual selected message")
    after = {path: digest(Path(path)) for path in source_hashes}
    if source_hashes != after:
        raise RuntimeError("A source export changed during collection")
    manifest = {
        "version": 1,
        "id": "rich-messages",
        "title": "Captured rich messages",
        "kind": "independent-examples",
        "readOnly": True,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "initialBookmarkId": selection["initialBookmarkId"],
        "documents": list(documents.values()),
        "bookmarks": bookmarks,
        "assets": list(assets.values()),
        "coverage": selection["coverage"],
    }
    save(output / "collection.json", manifest)
    save(
        output / "evidence.json",
        {
            "sourceHashesBefore": source_hashes,
            "sourceHashesAfter": after,
            "sourceExportsUnchanged": True,
            "documentsCopiedByteForByte": True,
            "providerCalls": 0,
            "submittedTurns": 0,
            "newInferenceUsd": 0,
        },
    )
    return {
        "documents": len(documents),
        "bookmarks": len(bookmarks),
        "assets": sum(asset["available"] for asset in assets.values()),
        "newInferenceUsd": 0,
    }


@app.command()
def main(
    selection: Path = typer.Option(..., exists=True, dir_okay=False),
    output: Path = typer.Option(...),
) -> None:
    """Create an independent example collection from already-qualified native exports."""
    os.umask(0o077)
    print(json.dumps(collect(selection.resolve(), output.resolve())))


if __name__ == "__main__":
    app()

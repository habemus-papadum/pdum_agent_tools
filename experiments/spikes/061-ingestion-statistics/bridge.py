"""Disposable adapter around the existing ingestor; all writable state is in this lab."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path

import yaml
from pdum.agent_history.config import load
from pdum.agent_history.sync import build

ROOT = Path(__file__).resolve().parents[3]
LAB = (
    Path(os.environ.get("PDUM_INGESTION_LAB_DIR", str(ROOT / "experiments/artifacts/061-ingestion-statistics")))
    .expanduser()
    .resolve()
)
CONFIG = LAB / "history.yaml"


def emit(value):
    print(json.dumps(value, default=str), flush=True)


def checked(path):
    config = load(path)
    for target in config.targets:
        if target.spec.startswith("md:") or not Path(target.spec).resolve().is_relative_to(LAB.resolve()):
            raise ValueError(
                "This study writes only local DuckDB targets inside its lab directory. "
                "MotherDuck publishing is not connected."
            )
    return config


def config_value():
    config = checked(CONFIG)
    return {
        "path": str(CONFIG),
        "text": CONFIG.read_text(),
        "notes": config.notes,
        "windowDays": config.window_days,
        "blobs": config.blobs,
        "sources": [{"agent": s.agent, "root": str(s.root), "label": s.label} for s in config.sources],
        "targets": [{"name": t.label, "path": t.spec, "exists": Path(t.spec).is_file()} for t in config.targets],
    }


def prepare(selection):
    """Copy exactly the previously selected raw transcripts, never credentials or whole homes."""
    if CONFIG.exists():
        raise ValueError("A lab configuration already exists; preparation never replaces it.")
    data = json.loads(Path(selection).read_text())
    evidence = []
    for entry in data["sessions"]:
        original = Path(entry["file"])
        before = hashlib.sha256(original.read_bytes()).hexdigest()
        agent = entry["provider"]
        if agent == "codex":
            relative = Path("archived_sessions") / original.name
        else:
            relative = Path("projects") / original.parent.name / original.name
        destination = LAB / "sources" / agent / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, destination)
        after = hashlib.sha256(original.read_bytes()).hexdigest()
        copied = hashlib.sha256(destination.read_bytes()).hexdigest()
        if before != after or before != copied:
            raise ValueError(f"Source changed during copy: {original.name}; use a stable selection")
        evidence.append(
            {
                "provider": agent,
                "sessionId": entry["sessionId"],
                "source": str(original),
                "copy": str(destination),
                "sha256": copied,
                "sourceUnchanged": True,
            }
        )
    config = {
        "window_days": 183,
        "blobs": True,
        "sources": [
            {"agent": "codex", "home": str(LAB / "sources/codex")},
            {"agent": "claude", "dir": str(LAB / "sources/claude")},
        ],
        "targets": [{"name": "lab", "duckdb": str(LAB / "history.duckdb")}],
    }
    CONFIG.write_text(yaml.safe_dump(config, sort_keys=False))
    (LAB / "source-evidence.json").write_text(
        json.dumps(
            {
                "capturedAt": datetime.now(UTC).isoformat(),
                "selection": str(selection),
                "files": evidence,
                "scope": "Selected raw transcripts only; no catalogue, projection, credentials or assets copied",
            },
            indent=2,
        )
    )
    emit({"prepared": len(evidence), "config": config_value()})


def main():
    command = sys.argv[1]
    if command == "prepare":
        prepare(sys.argv[2])
    elif command == "config":
        if not CONFIG.exists():
            emit(
                {
                    "available": False,
                    "path": str(CONFIG),
                    "reason": "Prepare the selected real corpus with bridge.py prepare first.",
                }
            )
        else:
            emit({"available": True, **config_value()})
    elif command == "save":
        text = json.load(sys.stdin)["text"]
        LAB.mkdir(parents=True, exist_ok=True)
        candidate = LAB / f"history.candidate-{os.getpid()}.yaml"
        try:
            candidate.write_text(text)
            checked(candidate)
            candidate.replace(CONFIG)
        finally:
            candidate.unlink(missing_ok=True)
        emit({"available": True, **config_value()})
    elif command == "sync":
        config = checked(CONFIG)
        host = {"host_id": "spike-061-selected-snapshot", "hostname": "local-snapshot", "platform": sys.platform}
        pairs = [(source, target) for target in config.targets for source in config.sources]
        for index, (source, target) in enumerate(pairs):
            emit(
                {
                    "event": "source-start",
                    "index": index,
                    "total": len(pairs),
                    "agent": source.agent,
                    "source": str(source.root),
                    "target": target.spec,
                }
            )
            summary = build(source, target, config, mode="sync", host=host).run()
            emit({"event": "source-complete", "index": index, "total": len(pairs), "summary": summary.to_dict()})
        emit({"event": "complete", "sources": len(pairs)})
    else:
        raise ValueError(f"Unknown command: {command}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"error": str(error)})
        sys.exit(1)

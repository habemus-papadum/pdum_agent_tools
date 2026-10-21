"""Validate recorded native notifications against an explicitly selected Codex schema."""

import argparse
import json
from pathlib import Path

import jsonschema

NAMES = {
    "thread/started": "ThreadStartedNotification",
    "turn/started": "TurnStartedNotification",
    "turn/completed": "TurnCompletedNotification",
    "item/started": "ItemStartedNotification",
    "item/completed": "ItemCompletedNotification",
    "item/agentMessage/delta": "AgentMessageDeltaNotification",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("journal", type=Path)
    parser.add_argument("schema_directory", type=Path)
    args = parser.parse_args()
    counts: dict[str, int] = {}
    for entry in json.loads(args.journal.read_text()):
        if entry["kind"] != "notification":
            continue
        message = entry["data"]
        schema_name = NAMES.get(message["method"])
        if schema_name is None:
            continue
        schema = json.loads((args.schema_directory / f"{schema_name}.json").read_text())
        jsonschema.validate(message["params"], schema)
        counts[message["method"]] = counts.get(message["method"], 0) + 1
    if not counts:
        raise SystemExit("No native notifications found")
    print(json.dumps(counts, indent=2))


if __name__ == "__main__":
    main()

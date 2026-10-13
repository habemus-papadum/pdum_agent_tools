"""Private process entry point for the official SDK's local history helpers."""

from __future__ import annotations

import dataclasses
import json
import os
import sys
from typing import Any


def _serialize(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    raise TypeError(f"Unsupported SDK result: {type(value).__name__}")


def main() -> None:
    """Read requests with one immutable profile environment for this process."""
    if len(sys.argv) != 2 or not os.environ.get("CLAUDE_CONFIG_DIR"):
        raise SystemExit("History helper requires an explicit profile and workspace")

    from claude_agent_sdk import (
        fork_session,
        get_session_info,
        get_session_messages,
        list_sessions,
        rename_session,
    )

    directory = sys.argv[1]
    for line in sys.stdin:
        try:
            request = json.loads(line)
            operation = request.pop("operation")
            if operation == "list":
                result = list_sessions(directory=directory, include_worktrees=False, **request)
            elif operation == "info":
                result = get_session_info(directory=directory, **request)
            elif operation == "read":
                result = get_session_messages(directory=directory, **request)
            elif operation == "rename":
                result = rename_session(directory=directory, **request)
            elif operation == "fork":
                result = fork_session(directory=directory, **request)
            else:
                raise ValueError(f"Unknown history operation: {operation}")
            response = {"ok": True, "result": result}
            encoded = json.dumps(response, default=_serialize)
        except Exception as error:
            encoded = json.dumps({"ok": False, "error": str(error), "error_type": type(error).__name__})
        sys.stdout.write(encoded + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

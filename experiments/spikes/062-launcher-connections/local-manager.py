"""Run the existing Claude HTTP adapter without allocating or launching workers."""

from __future__ import annotations

import asyncio
import os
import socket
from pathlib import Path

import uvicorn
from pdum.claude_launcher.management import create_app
from pdum.claude_launcher.profiles import list_profiles
from pdum.claude_launcher.runtime import ClaudeManager

ROOT = Path(__file__).resolve().parents[3]


async def main() -> None:
    lab = Path(os.environ.get("PDUM_PROFILE_LAB_DIR", ROOT / "experiments/artifacts/063-profile-workbench")).resolve()
    profiles = list_profiles(lab / "profiles/claude")
    manager = ClaudeManager({profile.directory.name: profile for profile in profiles})
    app = create_app(manager)
    # This is a real provider adapter. Its ordinary write routes exist, but this
    # study's client invokes only the two inspection endpoints.
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", int(os.environ.get("PDUM_STUDY_MANAGER_PORT", "0"))))
    port = listener.getsockname()[1]
    print(f"Claude management adapter: http://127.0.0.1:{port} ({len(profiles)} profiles; no workers)", flush=True)
    try:
        await uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False)).serve(sockets=[listener])
    finally:
        await manager.aclose()
        listener.close()


if __name__ == "__main__":
    asyncio.run(main())

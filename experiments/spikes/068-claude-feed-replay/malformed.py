"""No-inference check: malformed input is native failure, not a server rejection."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time

from aiohttp import ClientSession
from client import Client
from no_model import ARTIFACTS
from server import Owner, serve


async def main():
    directory = ARTIFACTS / f"{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}Z-malformed-{os.getpid()}"
    owner = Owner(directory)
    runner, url = await serve(owner)
    client = None
    try:
        async with ClientSession() as http:
            async with http.post(url + "/sessions", json={}) as response:
                descriptor = await response.json()
            session = owner.sessions[descriptor["id"]]
            client = await Client(http, url + descriptor["feed"]).connect()
            await client.control("initialize", hooks={}, sdkMcpServers=[])
            await client.ws.send_str("this is deliberately not JSON\n")
            await client.until(lambda: any(e["kind"] == "process-exit" for e in client.events), timeout=10)
            await session.disk.join()
            stdout = b"".join(base64.b64decode(e["data"]) for e in session.entries if e["direction"] == "stdout")
            stderr = b"".join(base64.b64decode(e["data"]) for e in session.entries if e["direction"] == "stderr")
            report = {
                "exitCode": session.process.returncode,
                "nativeFrames": [json.loads(x) for x in stdout.splitlines()],
                "stderr": stderr.decode(errors="replace"),
                "events": client.events,
                "modelInputs": 0,
                "costUsd": 0,
                "cleanup": session.status(),
            }
            (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
            print(
                json.dumps(
                    {
                        "report": str(directory / "report.json"),
                        "exitCode": session.process.returncode,
                        "stderrBytes": len(stderr),
                        "stdoutFrameTypes": [f["type"] for f in report["nativeFrames"]],
                        "modelInputs": 0,
                        "cleanupRunning": session.status()["running"],
                    }
                )
            )
    finally:
        if client and not client.closed:
            await client.close()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())

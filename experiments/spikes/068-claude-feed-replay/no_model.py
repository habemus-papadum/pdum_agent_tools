"""Real no-inference native checks; no model prompt is submitted."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from pathlib import Path

from aiohttp import ClientSession
from client import Client
from server import Owner, serve

ARTIFACTS = Path(__file__).resolve().parents[2] / "artifacts" / "068-claude-feed-replay"


async def main():
    directory = ARTIFACTS / f"{time.strftime('%Y%m%dT%H%M%S')}-no-model-{os.getpid()}"
    owner = Owner(directory)
    runner, url = await serve(owner)
    clients = []
    checks = []
    details = {}
    try:
        async with ClientSession() as http:
            async with http.post(url + "/sessions", json={"max_budget": 0.03, "max_turns": 2}) as response:
                descriptor = await response.json()
            session = owner.sessions[descriptor["id"]]
            checks.append({"name": "launch before any attach", "pass": session.status()["clients"] == 0})
            a = await Client(http, url + descriptor["feed"]).connect()
            clients.append(a)
            b = await Client(http, url + descriptor["feed"]).connect()
            clients.append(b)
            initialized = await a.control("initialize", hooks={}, sdkMcpServers=[])
            request_id = initialized["response"]["request_id"]
            await b.until(lambda: any(f.get("response", {}).get("request_id") == request_id for f in b.frames))
            checks.append(
                {
                    "name": "one initialization response reaches both clients",
                    "pass": initialized["response"]["subtype"] == "success",
                }
            )
            invalid = await b.control("not_a_native_operation_068")
            details["invalidControlResponse"] = invalid
            checks.append(
                {
                    "name": "invalid control forwarded and rejected by native process",
                    "pass": invalid["response"]["subtype"] == "error",
                }
            )
            duplicate = await b.control("initialize", hooks={}, sdkMcpServers=[])
            details["secondInitializeResponse"] = {
                key: value for key, value in duplicate["response"].items() if key != "response"
            }
            await a.close()
            await b.close()
            await asyncio.sleep(0.1)
            checks.append(
                {
                    "name": "zero clients leaves native process alive",
                    "pass": session.status()["clients"] == 0 and session.status()["running"],
                }
            )
            c = await Client(http, url + descriptor["feed"]).connect()
            clients.append(c)
            native_bytes = b"".join(base64.b64decode(e["data"]) for e in session.entries if e["direction"] == "stdout")
            checks.append({"name": "reattachment replays complete native stdout", "pass": c.raw == native_bytes})
            replay_end_index = next(i for i, e in enumerate(c.events) if e["kind"] == "replay-end")
            result = await c.control("interrupt")
            checks.append(
                {"name": "native control works after replay", "pass": result["response"]["subtype"] == "success"}
            )
            checks.append(
                {
                    "name": "live output follows replay-end marker",
                    "pass": any(e["kind"] == "output" for e in c.events[replay_end_index + 1 :]),
                }
            )
            native_path = session.root / "stdout.native.jsonl"
            native_path.write_bytes(
                b"".join(base64.b64decode(e["data"]) for e in session.entries if e["direction"] == "stdout")
            )
            async with http.post(url + f"/sessions/{session.id}/stop") as response:
                stopped = await response.json()
            checks.append({"name": "explicit stop ends owned process", "pass": not stopped["running"]})
            await c.close()
            for client in clients:
                seqs = [e["seq"] for e in client.events if e["kind"] == "output"]
                assert seqs == sorted(set(seqs))
            checks.append({"name": "client feed sequences monotonic and unique", "pass": True})
            (directory / "events.json").write_text(json.dumps([c.events for c in clients], indent=2))
            report = {
                "status": "pass" if all(c["pass"] for c in checks) else "fail",
                "checks": checks,
                "details": details,
                "modelInputs": 0,
                "costUsd": 0,
                "sessionId": session.id,
                "pid": session.process.pid,
                "cleanup": stopped,
            }
            (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
            print(
                json.dumps(
                    {
                        "report": str(directory / "report.json"),
                        "status": report["status"],
                        "checks": checks,
                        "details": details,
                    },
                    indent=2,
                )
            )
    finally:
        for client in clients:
            if not client.closed:
                await client.close()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())

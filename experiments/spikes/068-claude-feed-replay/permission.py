"""One-input follow-up: force native permission callback, answer from two clients."""

from __future__ import annotations

import asyncio
import json
import os
import time

from aiohttp import ClientSession
from client import Client
from live import output_frames
from no_model import ARTIFACTS
from server import Owner, serve


async def main():
    directory = ARTIFACTS / f"{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}Z-permission-{os.getpid()}"
    owner = Owner(directory, ARTIFACTS.parent / "066-claude-setup-token/setup-token.txt")
    runner, url = await serve(owner)
    clients, checks, details = [], [], {}
    failure = None
    submitted = 0
    try:
        async with asyncio.timeout(80), ClientSession() as http:
            async with http.post(
                url + "/sessions", json={"tools": "Bash", "permission": "manual", "max_budget": 0.03, "max_turns": 3}
            ) as response:
                descriptor = await response.json()
            session = owner.sessions[descriptor["id"]]
            a = await Client(http, url + descriptor["feed"]).connect()
            clients.append(a)
            b = await Client(http, url + descriptor["feed"]).connect()
            clients.append(b)
            await a.control("initialize", hooks={}, sdkMcpServers=[])
            setting = await a.control("apply_flag_settings", settings={"permissions": {"ask": ["Bash"]}})
            assert setting["response"]["subtype"] == "success"
            identity = await a.user(
                "Use Bash exactly once to run `printf CALLBACK_FORCED_068`. "
                "Wait for permission and then reply exactly CALLBACK_FORCED_068. Do not use other tools."
            )
            submitted += 1
            await a.until(
                lambda: any(
                    f.get("type") == "control_request" and f.get("request", {}).get("subtype") == "can_use_tool"
                    for f in a.frames
                )
            )
            callback = next(
                f
                for f in a.frames
                if f.get("type") == "control_request" and f.get("request", {}).get("subtype") == "can_use_tool"
            )
            callback_id = callback["request_id"]
            await b.until(lambda: any(f.get("request_id") == callback_id for f in b.frames))
            before = await b.control("initialize", hooks={}, sdkMcpServers=[])
            pending_before = before["response"].get("pending_permission_requests", [])
            checks.append({"name": "same actual permission request reaches both clients", "pass": True})
            checks.append(
                {
                    "name": "repeat initialize includes pending callback identity",
                    "pass": callback_id in [f.get("request_id") for f in pending_before],
                }
            )
            await a.send(
                {
                    "type": "control_response",
                    "response": {
                        "subtype": "success",
                        "request_id": callback_id,
                        "response": {"behavior": "allow", "updatedInput": callback["request"]["input"]},
                    },
                }
            )
            # Wait for Claude to reflect the accepted response. This is native
            # output, not the owner echoing its stdin journal.
            await a.until(
                lambda: any(
                    f.get("type") == "control_response" and f.get("response", {}).get("request_id") == callback_id
                    for f in a.frames
                )
            )
            await b.send(
                {
                    "type": "control_response",
                    "response": {
                        "subtype": "success",
                        "request_id": callback_id,
                        "response": {"behavior": "deny", "message": "Late competing client response."},
                    },
                }
            )
            await a.until(lambda: any(f.get("type") == "result" for f in a.frames))
            await b.until(lambda: any(f.get("type") == "result" for f in b.frames))
            after = await b.control("initialize", hooks={}, sdkMcpServers=[])
            pending_after = after["response"].get("pending_permission_requests", [])
            result = next(f for f in a.frames if f.get("type") == "result")
            checks.append(
                {
                    "name": "native accepted response tells both clients to dismiss resolved callback",
                    "pass": all(
                        any(
                            f.get("type") == "control_response"
                            and f.get("response", {}).get("request_id") == callback_id
                            for f in client.frames
                        )
                        for client in (a, b)
                    ),
                }
            )
            checks.append(
                {
                    "name": "late conflicting answer does not change accepted allowance",
                    "pass": not result.get("is_error") and "CALLBACK_FORCED_068" in result.get("result", ""),
                }
            )
            checks.append(
                {
                    "name": "resolved callback absent from fresh native snapshot",
                    "pass": callback_id not in [f.get("request_id") for f in pending_after],
                }
            )
            # New attached client applies old control_request then native response;
            # replay finishes with no stale prompt and sends nothing automatically.
            c = await Client(http, url + descriptor["feed"]).connect()
            clients.append(c)
            pending = {}
            for frame in c.frames:
                if frame.get("type") == "control_request":
                    pending[frame["request_id"]] = frame
                elif frame.get("type") == "control_cancel_request":
                    pending.pop(frame["request_id"], None)
                elif frame.get("type") == "control_response":
                    pending.pop(frame["response"]["request_id"], None)
            checks.append(
                {
                    "name": "late client replay ends without already-resolved permission",
                    "pass": callback_id not in pending,
                }
            )
            details = {
                "submittedUuid": identity,
                "callbackId": callback_id,
                "callback": callback,
                "pendingBefore": [f.get("request_id") for f in pending_before],
                "pendingAfter": [f.get("request_id") for f in pending_after],
                "matchingFrames": [
                    f
                    for f in a.frames
                    if f.get("request_id") == callback_id or f.get("response", {}).get("request_id") == callback_id
                ],
                "result": result,
            }
    except Exception as error:
        failure = f"{type(error).__name__}: {error}"
    finally:
        for client in clients:
            if not client.closed:
                await client.close()
        await runner.cleanup()
        sessions = []
        for session in owner.sessions.values():
            frames = output_frames(session)
            results = [f for f in frames if f.get("type") == "result"]
            sessions.append(
                {
                    "id": session.id,
                    "pid": session.process.pid,
                    "exitCode": session.process.returncode,
                    "results": results,
                    "nativeCostUsd": max([f.get("total_cost_usd", 0) for f in results], default=0),
                }
            )
            (session.root / "stdout.native.jsonl").write_text("".join(json.dumps(f) + "\n" for f in frames))
        report = {
            "status": "pass" if failure is None and all(c["pass"] for c in checks) else "fail",
            "failure": failure,
            "checks": checks,
            "details": details,
            "sessions": sessions,
            "inputs": submitted,
            "reportedCostUsd": sum(s["nativeCostUsd"] for s in sessions),
        }
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        (directory / "clients.json").write_text(json.dumps([c.events for c in clients], indent=2) + "\n")
        print(
            json.dumps(
                {
                    "report": str(directory / "report.json"),
                    "status": report["status"],
                    "failure": failure,
                    "checks": checks,
                    "inputs": submitted,
                    "reportedCostUsd": report["reportedCostUsd"],
                    "cleanup": [s["exitCode"] for s in sessions],
                },
                indent=2,
            )
        )
        return report


if __name__ == "__main__":
    result = asyncio.run(main())
    raise SystemExit(0 if result["status"] == "pass" else 1)

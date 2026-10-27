"""Bounded four-input Haiku probe through two SDK-free network clients."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import time

from aiohttp import ClientSession
from client import Client
from no_model import ARTIFACTS
from server import Owner, serve


def output_frames(session):
    raw = b"".join(base64.b64decode(e["data"]) for e in session.entries if e["direction"] == "stdout")
    return [json.loads(line) for line in raw.splitlines() if line]


async def wait_until(predicate, timeout=45):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.02)


async def main():
    directory = ARTIFACTS / f"{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}Z-live-{os.getpid()}"
    token = ARTIFACTS.parent / "066-claude-setup-token" / "setup-token.txt"
    token_hash = hashlib.sha256(token.read_bytes()).hexdigest()
    owner = Owner(directory, token)
    runner, url = await serve(owner)
    clients, checks, inputs = [], [], []
    details = {}
    failure = None
    try:
        async with asyncio.timeout(160), ClientSession() as http:

            async def launch(permission):
                async with http.post(
                    url + "/sessions",
                    json={"tools": "Bash", "permission": permission, "max_budget": 0.05, "max_turns": 3},
                ) as response:
                    descriptor = await response.json()
                a = await Client(http, url + descriptor["feed"]).connect()
                clients.append(a)
                b = await Client(http, url + descriptor["feed"]).connect()
                clients.append(b)
                await a.control("initialize", hooks={}, sdkMcpServers=[])
                return owner.sessions[descriptor["id"]], descriptor, a, b

            session, descriptor, a, b = await launch("bypassPermissions")
            text = (
                "Use Bash exactly once to run `sleep 2; printf DETACHED_068`. "
                "Then reply exactly DETACHED_068. Do not use any other tool."
            )
            first = await a.user(text)
            inputs.append({"session": session.id, "uuid": first, "case": "all-clients-away"})
            await a.until(lambda: any(f.get("type") == "user" and f.get("uuid") == first for f in a.frames))
            await b.until(lambda: any(f.get("type") == "user" and f.get("uuid") == first for f in b.frames))
            checks.append({"name": "native user echo preserves submitted UUID in both clients", "pass": True})
            await a.close()
            await b.close()
            await wait_until(lambda: session.status()["clients"] == 0)
            output_count_at_detach = len(output_frames(session))
            await wait_until(lambda: any(f.get("type") == "result" for f in output_frames(session)))
            detached_frames = output_frames(session)
            checks.append(
                {
                    "name": "model and tool complete with zero clients attached",
                    "pass": len(detached_frames) > output_count_at_detach
                    and session.status()["clients"] == 0
                    and any(f.get("type") == "result" and not f.get("is_error") for f in detached_frames),
                }
            )
            details["firstResult"] = next(f for f in detached_frames if f.get("type") == "result")
            a = await Client(http, url + descriptor["feed"]).connect()
            clients.append(a)
            b = await Client(http, url + descriptor["feed"]).connect()
            clients.append(b)
            expected = b"".join(base64.b64decode(e["data"]) for e in session.entries if e["direction"] == "stdout")
            checks.append(
                {"name": "two late clients replay identical complete stdout", "pass": a.raw == b.raw == expected}
            )
            result_count = sum(f.get("type") == "result" for f in a.frames)
            alpha, beta = await asyncio.gather(
                a.user("Reply exactly ALPHA_068. No tools."), b.user("Reply exactly BETA_068. No tools.")
            )
            inputs.extend(
                [
                    {"session": session.id, "uuid": alpha, "case": "concurrent-a"},
                    {"session": session.id, "uuid": beta, "case": "concurrent-b"},
                ]
            )
            await a.until(
                lambda: all(
                    any(f.get("type") == "user" and f.get("uuid") == key for f in a.frames) for key in (alpha, beta)
                )
            )
            await a.until(lambda: sum(f.get("type") == "result" for f in a.frames) > result_count)
            # Observe native queue completion instead of assuming one result per input.
            await wait_until(
                lambda: all(
                    any(
                        f.get("type") == "command_lifecycle"
                        and f.get("command_uuid") == key
                        and f.get("state") in ("completed", "cancelled", "rejected")
                        for f in output_frames(session)
                    )
                    for key in (alpha, beta)
                ),
                timeout=20,
            )
            details["concurrentLifecycles"] = [
                f
                for f in output_frames(session)
                if f.get("type") == "command_lifecycle" and f.get("command_uuid") in (alpha, beta)
            ]
            details["concurrentResults"] = [f for f in output_frames(session) if f.get("type") == "result"][1:]
            checks.append(
                {"name": "concurrent clients receive native acknowledgement and terminal lifecycle", "pass": True}
            )
            interrupt = await b.control("interrupt")
            details["idleInterrupt"] = interrupt
            checks.append(
                {
                    "name": "second client can issue native interrupt control",
                    "pass": interrupt["response"]["subtype"] == "success",
                }
            )
            await a.close()
            await b.close()
            await session.stop()

            # Deliberately manual for this one callback probe, not a runtime default.
            approval, descriptor, a, b = await launch("manual")
            await a.control("apply_flag_settings", settings={"permissions": {"ask": ["Bash"]}})
            request = await a.user(
                "Use Bash once to run `printf CALLBACK_068`; then reply exactly CALLBACK_068. "
                "Do not use any other tools. Wait for permission if needed."
            )
            inputs.append({"session": approval.id, "uuid": request, "case": "duplicate-permission-response"})
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
            snapshot = await b.control("initialize", hooks={}, sdkMcpServers=[])
            details["pendingSnapshotIds"] = [
                f.get("request_id") for f in snapshot["response"].get("pending_permission_requests", [])
            ]
            checks.append(
                {
                    "name": "joining initialize reports actual pending permission",
                    "pass": callback_id in details["pendingSnapshotIds"],
                }
            )
            # Claude's own reflected response settles the first answer before the
            # conflicting second one. The owner never arbitrates the answers.
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
                        "response": {"behavior": "deny", "message": "Second client denies; duplicate-response probe."},
                    },
                }
            )
            await a.until(lambda: any(f.get("type") == "result" for f in a.frames))
            await b.until(lambda: any(f.get("type") == "result" for f in b.frames))
            details["callback"] = callback
            details["callbackFrames"] = [
                f
                for f in a.frames
                if f.get("request_id") == callback_id or f.get("response", {}).get("request_id") == callback_id
            ]
            details["callbackResult"] = next(f for f in a.frames if f.get("type") == "result")
            details["callbackNativeCancellation"] = any(
                f.get("type") == "control_cancel_request" and f.get("request_id") == callback_id for f in a.frames
            )
            after = await b.control("initialize", hooks={}, sdkMcpServers=[])
            details["afterSnapshotIds"] = [
                f.get("request_id") for f in after["response"].get("pending_permission_requests", [])
            ]
            checks.append(
                {
                    "name": "native first response resolves permission; later duplicate does not override it",
                    "pass": not details["callbackResult"].get("is_error")
                    and "CALLBACK_068" in details["callbackResult"].get("result", ""),
                }
            )
            checks.append(
                {
                    "name": "resolved permission absent from later native snapshot",
                    "pass": callback_id not in details["afterSnapshotIds"],
                }
            )
            await a.close()
            await b.close()
            await approval.stop()
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
                    "created": session.created,
                    "exitCode": session.process.returncode,
                    "inputCount": sum(i["session"] == session.id for i in inputs),
                    "results": results,
                    "nativeCostUsd": max([float(f.get("total_cost_usd", 0)) for f in results], default=0),
                    "status": session.status(),
                }
            )
            (session.root / "stdout.native.jsonl").write_text("".join(json.dumps(f) + "\n" for f in frames))
        report = {
            "status": "pass" if failure is None and all(c["pass"] for c in checks) else "fail",
            "failure": failure,
            "checks": checks,
            "details": details,
            "inputs": inputs,
            "sessions": sessions,
            "reportedCostUsd": sum(s["nativeCostUsd"] for s in sessions),
            "sourceTokenUnchanged": hashlib.sha256(token.read_bytes()).hexdigest() == token_hash,
            "scope": "Four user inputs maximum; Haiku only; two USD0.05 native budgets; 160-second harness deadline",
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
                    "inputs": len(inputs),
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

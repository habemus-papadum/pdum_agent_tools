"""Bounded health evidence using real Luna and local tools, plus explicit failure injection."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path
from typing import Any

shared_path = Path(__file__).resolve().parents[1] / "028-codex-joins/probe.py"
spec = importlib.util.spec_from_file_location("join_probe", shared_path)
shared = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = shared
spec.loader.exec_module(shared)
Probe, launch = shared.Probe, shared.launch


async def completed(p: Any, a: Any, t: str, label: str, prompt: str, **kwargs: Any) -> str:
    turn, mark = await p.turn(a, t, prompt, **kwargs)
    done = await a.wait(
        "turn/completed", after=mark, timeout=100, predicate=lambda m: m["params"]["turn"]["id"] == turn
    )
    p.result["cases"][label] = {"turn": turn, "done": done, "events": a.messages[mark:]}
    await p.snapshot(a, t, label + "-history")
    return turn


async def exercise(p: Any) -> None:
    async with launch(p.profile, p.options()) as server:
        a = await p.client("A-health", server.endpoint, auth=True)
        t = await p.start_thread(a)
        await completed(
            p,
            a,
            t,
            "local-tools",
            "This is an authorized bounded local telemetry test. Use exactly four separate sequential shell calls. "
            '1: printf HEALTH_OK. 2: /bin/sh -c "exit 7". 3: /bin/sh -c "exit 7" again. '
            '4: /bin/sh -c "sleep 3; printf SLOW_OK". Each failed command is intentional; do not repair or retry. '
            "After all four commands finish, reply only HEALTH_DONE. Do not use other tools.",
        )
        turn, mark = await p.turn(
            a,
            t,
            'Run exactly one shell command /bin/sh -c "sleep 20; printf SHOULD_NOT_FINISH". '
            "Wait for it. Do not use other tools.",
        )
        await a.wait("item/started", after=mark, predicate=lambda m: m["params"]["item"]["type"] == "commandExecution")
        p.result["cases"]["interruptCommandSnapshot"] = await p.snapshot(a, t, "interrupt-active")
        p.result["cases"]["interruptReply"] = await a.request("turn/interrupt", {"threadId": t, "turnId": turn})
        await a.wait("turn/completed", after=mark)
        p.result["cases"]["interruption"] = a.messages[mark:]
        # Explicitly isolated read-only fixture. Ordinary runtime defaults remain unchanged.
        denied = await p.start_thread(a, sandbox="read-only")
        target = str(p.profile / "work/denied-write")
        await completed(
            p,
            a,
            denied,
            "sandbox-denial",
            f"This is an authorized sandbox-denial test in a disposable directory. Try exactly one shell call "
            f"/usr/bin/touch {target}. Do not request escalation or retry. Report whether it failed in one sentence.",
        )
        p.result["cases"]["sandboxFileExists"] = Path(target).exists()
        swarm = await p.start_thread(a)
        await completed(
            p,
            a,
            swarm,
            "one-child",
            "This is an explicitly authorized bounded multi-agent test. Spawn exactly one child with "
            "task_name tiny_child, model gpt-6-luna, reasoning_effort low, fork_turns none. "
            "Its task: reply CHILD_OK, no tools and no further delegation. Wait for the child, then reply PARENT_OK. "
            "Do not run shell or other tools. If spawning is unavailable, reply UNSUPPORTED and stop.",
        )
        children = sorted(
            {m.get("params", {}).get("threadId") for m in a.messages if m.get("method") == "turn/completed"}
            - {t, denied, swarm, None}
        )
        p.result["cases"]["childIds"] = children
        for child in children:
            await p.snapshot(a, child, "child-" + child)
        # A completed turn may leave a deliberately backgrounded command alive.
        bg = await p.start_thread(a)
        await completed(
            p,
            a,
            bg,
            "background-idle",
            'Run exactly one shell command /bin/sh -c "sleep 15; printf BACKGROUND_DONE" using yield_time_ms 1000. '
            "When the tool returns a running session, do not wait or poll. Reply BACKGROUND_STARTED immediately. "
            "This is a disposable lifecycle test, no other tools.",
        )
        p.result["cases"]["backgroundList"] = await a.request(
            "thread/backgroundTerminals/list", {"threadId": bg}, raw=True
        )
        p.result["cases"]["queueList"] = await a.request("thread/queue/list", {"threadId": bg}, raw=True)
        p.result["cases"]["goalRead"] = await a.request("thread/goal/get", {"threadId": bg}, raw=True)
        await p.snapshot(a, bg, "background-after-turn")
        p.result["cases"]["backgroundClean"] = await a.request(
            "thread/backgroundTerminals/clean", {"threadId": bg}, raw=True
        )
        # Real local HTTP endpoint rejects every request. This establishes error handling only.
        requests = []

        async def reject(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
                requests.append(header.split(b"\r\n", 1)[0].decode(errors="replace"))
                body = b'{"error":{"message":"spike032 injected unavailable","type":"server_error"}}'
                writer.write(
                    b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: application/json\r\n"
                    + f"Content-Length: {len(body)}\r\n\r\n".encode()
                    + body
                )
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        async with await asyncio.start_server(reject, "127.0.0.1", 0) as failure_server:
            port = failure_server.sockets[0].getsockname()[1]
            failure = await p.start_thread(
                a,
                modelProvider="spike_failure",
                config={
                    "model_providers.spike_failure": {
                        "name": "spike_failure",
                        "base_url": f"http://127.0.0.1:{port}/v1",
                        "wire_api": "responses",
                        "requires_openai_auth": False,
                        "request_max_retries": 0,
                        "stream_max_retries": 0,
                        "supports_websockets": False,
                    }
                },
            )
            await completed(p, a, failure, "injected-provider-failure", "Reply FAILURE_TEST.")
        p.result["cases"]["injectedHttpRequests"] = requests
        p.result["relayStatus"] = await server.status()
        await a.close()


async def main() -> None:
    p = Probe("032-codex-health")
    try:
        await p.setup()
        async with asyncio.timeout(480):
            await exercise(p)
    except Exception as error:
        p.result["error"] = f"{type(error).__name__}: {error}"
    finally:
        await p.finish()


if __name__ == "__main__":
    asyncio.run(main())

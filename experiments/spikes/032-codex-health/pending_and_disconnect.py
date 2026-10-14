"""Pending MCP, cancelled callback, and work completing without any clients."""

import asyncio
import sys
from pathlib import Path
from typing import Any

from probe import Probe, launch


async def exercise(p: Any) -> None:
    async with launch(p.profile, p.options()) as server:
        a = await p.client("A-pending", server.endpoint, auth=True)
        t = await p.start_thread(
            a,
            config={
                "mcp_servers.health": {
                    "command": str(Path(sys.executable).resolve()),
                    "args": [str(Path(__file__).with_name("mcp_fixture.py").resolve())],
                }
            },
        )
        p.save("mcp-inventory.json", await a.request("mcpServerStatus/list", {"threadId": t}))
        turn, mark = await p.turn(
            a,
            t,
            "Call the MCP health_wait tool once. Wait for its result then reply MCP_FINISHED. "
            "Do not use shell or other tools beyond discovering health_wait if needed.",
        )
        call = await a.wait(
            "item/started", after=mark, predicate=lambda m: m["params"]["item"]["type"] == "mcpToolCall"
        )
        p.result["cases"]["pendingMcpItem"] = call
        await p.snapshot(a, t, "pending-mcp-read")
        b = await p.client("B-mcp", server.endpoint)
        p.save("pending-mcp-resume.json", await b.request("thread/resume", {"threadId": t}))
        await a.wait("turn/completed", after=mark)
        p.result["cases"]["mcpEvents"] = a.messages[mark:]
        await p.snapshot(a, t, "mcp-final")
        gate = await p.start_thread(
            a,
            dynamicTools=[
                {
                    "type": "function",
                    "name": "cancel_gate",
                    "description": "Wait for the client to answer.",
                    "inputSchema": {"type": "object", "properties": {}},
                }
            ],
        )
        turn, mark = await p.turn(a, gate, "Call cancel_gate once, do not use other tools, then wait for its response.")
        callback = await a.wait("item/tool/call", after=mark)
        p.save("cancel-resume.json", await b.request("thread/resume", {"threadId": gate}))
        await b.request("turn/interrupt", {"threadId": gate, "turnId": turn})
        await a.wait("turn/completed", after=mark)
        await b.send(
            {
                "id": callback["id"],
                "result": {"success": True, "contentItems": [{"type": "inputText", "text": "LATE_AFTER_INTERRUPT"}]},
            }
        )
        await asyncio.sleep(0.2)
        p.result["cases"]["cancelledCallbackEvents"] = a.messages[mark:]
        await p.snapshot(b, gate, "cancel-final")
        slow = await p.start_thread(a)
        turn, mark = await p.turn(
            a,
            slow,
            'Run exactly one shell command /bin/sh -c "sleep 4; printf NO_CLIENT_DONE". '
            "Wait for it, then reply NO_CLIENT_FINISHED. Do not use other tools.",
        )
        await a.wait("item/started", after=mark, predicate=lambda m: m["params"]["item"]["type"] == "commandExecution")
        await a.close()
        await b.close()
        await asyncio.sleep(0.2)
        before = await server.status()
        await asyncio.sleep(7)
        after = await server.status()
        p.result["cases"]["noClientsRelayBefore"] = before
        p.result["cases"]["noClientsRelayAfter"] = after
        c = await p.client("C-returned", server.endpoint)
        await p.snapshot(c, slow, "no-clients-read")
        p.save("no-clients-resume.json", await c.request("thread/resume", {"threadId": slow}))
        await asyncio.sleep(0.2)
        p.result["cases"]["returnedEvents"] = list(c.messages)
        await c.close()


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

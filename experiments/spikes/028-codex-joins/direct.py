"""One native Unix-WebSocket control, bypassing the relay without changing the server owner."""

import asyncio

from probe import Probe, launch


async def main() -> None:
    p = Probe()
    try:
        await p.setup()
        async with asyncio.timeout(120), launch(p.profile, p.options()) as server:
            a = await p.client("A-native", server.backend_endpoint, auth=True)
            t = await p.start_thread(
                a,
                dynamicTools=[
                    {
                        "type": "function",
                        "name": "native_gate",
                        "description": "Return one short result.",
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                ],
            )
            _, mark = await p.turn(a, t, "Call native_gate once. No other tools. Then reply DIRECT_DONE.")
            callback = await a.wait("item/tool/call", after=mark)
            b = await p.client("B-native", server.backend_endpoint)
            p.save("direct-resume.json", await b.request("thread/resume", {"threadId": t}))
            replay = await b.wait("item/tool/call")
            await b.send(
                {
                    "id": replay["id"],
                    "result": {"success": True, "contentItems": [{"type": "inputText", "text": "native answered"}]},
                }
            )
            await a.wait("turn/completed", after=mark)
            p.result["cases"]["direct"] = {
                "original": callback,
                "replay": replay,
                "a": a.messages[mark:],
                "b": list(b.messages),
            }
            await p.snapshot(a, t, "direct-history")
            await a.close()
            await b.close()
            p.result["relayStatus"] = await server.status()
    except Exception as error:
        p.result["error"] = f"{type(error).__name__}: {error}"
    finally:
        await p.finish()


if __name__ == "__main__":
    asyncio.run(main())

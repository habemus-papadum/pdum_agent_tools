"""Streaming, human callback, competing starts and repeat-submission follow-up."""

import asyncio

from probe import Probe, launch, text_input


async def exercise(p: Probe) -> None:
    async with launch(p.profile, p.options()) as server:
        a = await p.client("A", server.endpoint, auth=True)
        t = await p.start_thread(a)
        turn, index = await p.turn(
            a,
            t,
            "Do not use tools. Output exactly 100 numbered lines, "
            'each of the form "N: join stream marker". Start immediately.',
        )
        await a.wait("item/agentMessage/delta", after=index)
        b = await p.client("B-stream", server.endpoint)
        before = await p.snapshot(b, t, "stream-read")
        await asyncio.sleep(0.15)
        resume = await b.request("thread/resume", {"threadId": t})
        p.save("stream-resume.json", resume)
        await a.wait("turn/completed", after=index)
        await p.snapshot(b, t, "stream-final")
        p.result["cases"]["stream"] = {"a": a.messages[index:], "b": list(b.messages), "snapshotBefore": before}
        turn, index = await p.turn(
            a,
            t,
            "Ask the user exactly one request_user_input question with id choice "
            "and options Alpha and Beta. Do not use other tools or do any work. After the answer reply only its value.",
            collaborationMode={
                "mode": "plan",
                "settings": {"model": "gpt-6-luna", "reasoning_effort": "low", "developer_instructions": None},
            },
        )
        callback = await a.wait("item/tool/requestUserInput", after=index)
        c = await p.client("C-human", server.endpoint)
        p.save("human-resume.json", await c.request("thread/resume", {"threadId": t}))
        await c.wait("item/tool/requestUserInput")
        q = callback["params"]["questions"][0]["id"]
        await asyncio.gather(
            a.send({"id": callback["id"], "result": {"answers": {q: {"answers": ["Alpha"]}}}}),
            c.send({"id": callback["id"], "result": {"answers": {q: {"answers": ["Beta"]}}}}),
        )
        await a.wait("turn/completed", after=index)
        await c.send({"id": callback["id"], "result": {"answers": {q: {"answers": ["Late"]}}}})
        p.result["cases"]["humanRace"] = {"a": a.messages[index:], "b": list(b.messages), "c": list(c.messages)}
        await p.snapshot(a, t, "human-final")
        # The same submission identity is deliberately reused. These are bounded real requests,
        # not an automatic retry policy. Both can consume provider usage.
        params = {
            "threadId": t,
            "model": "gpt-6-luna",
            "effort": "low",
            "serviceTier": "default",
            "clientUserMessageId": "duplicate-submission-fixture",
            "input": text_input("Do not use tools. Reply exactly DUPLICATE_DONE."),
            "collaborationMode": {
                "mode": "default",
                "settings": {"model": "gpt-6-luna", "reasoning_effort": "low", "developer_instructions": None},
            },
        }
        mark = len(a.messages)
        p.turns += 2
        p.result["attempts"].append({"case": "competingDuplicateStarts", "requests": 2, "params": params})
        responses = await asyncio.gather(
            a.request("turn/start", params, raw=True), b.request("turn/start", params, raw=True)
        )
        p.result["cases"]["competingStarts"] = responses
        await a.wait("turn/completed", after=mark)
        await asyncio.sleep(0.4)
        p.turns += 1
        p.result["attempts"].append({"case": "repeatAfterCompletion", "requests": 1, "params": params})
        mark2 = len(a.messages)
        p.result["cases"]["repeatAfterCompletion"] = await b.request("turn/start", params, raw=True)
        await a.wait("turn/completed", after=mark2)
        p.result["cases"]["duplicateEvents"] = a.messages[mark:]
        await p.snapshot(a, t, "duplicate-final")
        await a.close()
        await b.close()
        await c.close()


async def main() -> None:
    p = Probe()
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

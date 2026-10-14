"""Bounded real Codex multi-client probe through the production launcher relay.

Run from experiments with the root workspace interpreter, which owns the launcher:
uv run --no-project /absolute/path/to/root/.venv/bin/python spikes/028-codex-joins/probe.py
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pdum.codex_launcher import JsonlRecorder, LaunchOptions, ProfileSpec, create_profile, launch
from websockets.asyncio.client import connect, unix_connect

ROOT = Path(__file__).resolve().parents[2]
BINARY = Path("/Users/nehal/.local/bin/codex").resolve()
MODEL = "gpt-6-luna"


def text_input(text: str) -> list[dict[str, str]]:
    return [{"type": "text", "text": text}]


class Client:
    def __init__(self, probe: Probe, name: str) -> None:
        self.probe, self.name = probe, name
        self.messages: list[dict[str, Any]] = []
        self.pending: dict[str, asyncio.Future] = {}
        self.counter = 0

    async def open(self, endpoint: str) -> Client:
        if endpoint.startswith("unix://"):
            self.socket = await unix_connect(endpoint.removeprefix("unix://"), max_size=None, proxy=None)
        else:
            self.socket = await connect(endpoint, max_size=None, proxy=None)
        self.reader = asyncio.create_task(self._read())
        await self.request(
            "initialize",
            {
                "clientInfo": {"name": f"spike028_{self.name}", "version": "0.0.0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        await self.send({"method": "initialized", "params": {}})
        return self

    async def _read(self) -> None:
        try:
            async for payload in self.socket:
                message = json.loads(payload)
                self.probe.record(self.name, "server", message)
                self.messages.append(message)
                self.probe.observe(message)
                if "id" in message and "method" not in message:
                    future = self.pending.pop(str(message["id"]), None)
                    if future and not future.done():
                        future.set_result(message)
        except Exception as error:
            self.probe.record(self.name, "transport", {"error": type(error).__name__})
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("client connection ended"))

    async def send(self, message: dict) -> None:
        self.probe.record(self.name, "client", message)
        await self.socket.send(json.dumps(message))

    async def request(self, method: str, params: dict | None = None, *, raw: bool = False) -> dict:
        self.counter += 1
        identifier = f"{self.name}:{self.counter}"
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        await self.send({"id": identifier, "method": method, "params": params or {}})
        result = await asyncio.wait_for(future, 30)
        if raw:
            return result
        if "error" in result:
            raise RuntimeError(f"{method}: {result['error']}")
        return result["result"]

    async def wait(
        self, method: str, *, after: int = 0, timeout: float = 70, predicate: Callable[[dict], bool] = lambda _: True
    ) -> dict:
        async with asyncio.timeout(timeout):
            while True:
                found = next((m for m in self.messages[after:] if m.get("method") == method and predicate(m)), None)
                if found:
                    return found
                if self.probe.bound_error:
                    raise RuntimeError(self.probe.bound_error)
                await asyncio.sleep(0.02)

    async def close(self) -> None:
        await self.socket.close()
        await self.reader


class Probe:
    def __init__(self, spike: str = "028-codex-joins") -> None:
        os.umask(0o077)
        self.artifacts = ROOT / "artifacts" / spike / str(time.time_ns() // 1_000_000)
        self.artifacts.mkdir(parents=True)
        self.profile = self.artifacts / "profile"
        self.result: dict[str, Any] = {"artifactPath": str(self.artifacts), "cases": {}, "attempts": []}
        self.usage: dict[str, dict] = {}
        self.clients: list[Client] = []
        self.turns = 0
        self.calls: set[str] = set()
        self.bound_error = None
        self.auth_source = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "auth.json"
        auth_bytes = self.auth_source.read_bytes()
        self.auth_hash = hashlib.sha256(auth_bytes).hexdigest()
        auth = json.loads(auth_bytes)["tokens"]
        self.auth = {
            "type": "chatgptAuthTokens",
            "accessToken": auth["access_token"],
            "chatgptAccountId": auth["account_id"],
        }

    def save(self, name: str, value: Any) -> None:
        (self.artifacts / name).write_text(json.dumps(value, indent=2) + "\n")

    def record(self, client: str, direction: str, message: dict) -> None:
        if message.get("method") == "account/login/start":
            message = {**message, "params": {"type": "chatgptAuthTokens", "credentials": "[withheld]"}}
        with (self.artifacts / "clients.jsonl").open("a") as output:
            output.write(
                json.dumps(
                    {
                        "timestamp": time.time(),
                        "monotonic": time.monotonic(),
                        "client": client,
                        "direction": direction,
                        "message": message,
                    }
                )
                + "\n"
            )

    def observe(self, message: dict) -> None:
        method, params = message.get("method"), message.get("params", {})
        if method == "thread/tokenUsage/updated":
            self.usage[params["threadId"]] = params["tokenUsage"]
            if self.estimate() > 0.20:
                self.bound_error = "Observed API-equivalent usage exceeded USD 0.20 allocation"
        if method == "item/started" and params.get("item", {}).get("type") in (
            "commandExecution",
            "dynamicToolCall",
            "mcpToolCall",
            "subAgentActivity",
        ):
            self.calls.add(params["item"]["id"])
            if len(self.calls) > 32:
                self.bound_error = "Tool/item bound of 32 exceeded"

    def estimate(self) -> float:
        return sum(
            (u["total"]["inputTokens"] - u["total"]["cachedInputTokens"] - u["total"].get("cacheWriteInputTokens", 0))
            * 0.1e-6
            + u["total"]["cachedInputTokens"] * 0.01e-6
            + u["total"].get("cacheWriteInputTokens", 0) * 0.125e-6
            + u["total"]["outputTokens"] * 0.5e-6
            for u in self.usage.values()
        )

    async def setup(self) -> None:
        await create_profile(self.profile, ProfileSpec(executable=BINARY, model=MODEL, copy_skills=False))
        with (self.profile / "codex/config.toml").open("a") as output:
            output.write(
                '\nmodel_reasoning_effort = "low"\nservice_tier = "default"\nweb_search = "disabled"\n'
                "[features]\napps = false\nplugins = false\nmulti_agent = true\n"
                "[skills.bundled]\nenabled = false\n[analytics]\nenabled = false\n"
                "[feedback]\nenabled = false\n[agents]\nmax_threads = 2\nmax_depth = 1\n"
            )
        version = await asyncio.create_subprocess_exec(str(BINARY), "--version", stdout=asyncio.subprocess.PIPE)
        stdout, _ = await version.communicate()
        self.save(
            "level0.json",
            {
                "binary": str(BINARY),
                "sha256": hashlib.sha256(BINARY.read_bytes()).hexdigest(),
                "version": stdout.decode().strip(),
                "python": sys.version,
                "platform": platform.platform(),
                "model": MODEL,
                "auth": "in-memory chatgptAuthTokens",
                "priceDate": "2026-10-14",
                "bounds": {
                    "wallSeconds": 480,
                    "turns": 10,
                    "toolItems": 32,
                    "retries": 0,
                    "observedApiEquivalentUsd": 0.20,
                },
            },
        )

    def options(self, capture: str = "relay.jsonl") -> LaunchOptions:
        return LaunchOptions(
            executable=BINARY,
            relay=True,
            host="127.0.0.1",
            port=0,
            processors=[JsonlRecorder(self.artifacts / capture)],
            environment_mode="clean",
        )

    async def client(self, name: str, endpoint: str, *, auth: bool = False) -> Client:
        client = await Client(self, name).open(endpoint)
        self.clients.append(client)
        if auth:
            await client.request("account/login/start", self.auth)
        return client

    async def start_thread(self, client: Client, **kwargs: Any) -> str:
        result = await client.request(
            "thread/start",
            {
                "model": MODEL,
                "cwd": str(self.profile / "work"),
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                **kwargs,
            },
        )
        assert result["model"] == MODEL
        self.save(f"thread-start-{result['thread']['id']}.json", result)
        return result["thread"]["id"]

    async def turn(self, client: Client, thread: str, prompt: str, **kwargs: Any) -> tuple[str, int]:
        if self.turns >= 10 or self.bound_error:
            raise RuntimeError(self.bound_error or "Turn bound reached")
        self.turns += 1
        self.result["attempts"].append(
            {"turn": self.turns, "thread": thread, "prompt": prompt, "startedAt": time.time(), "model": MODEL}
        )
        self.save("attempts.json", self.result["attempts"])
        index = len(client.messages)
        result = await client.request(
            "turn/start",
            {
                "threadId": thread,
                "model": MODEL,
                "effort": "low",
                "serviceTier": "default",
                "input": text_input(prompt),
                **kwargs,
            },
        )
        return result["turn"]["id"], index

    async def snapshot(self, client: Client, thread: str, name: str) -> dict:
        result = await client.request("thread/read", {"threadId": thread, "includeTurns": True}, raw=True)
        self.save(name + ".json", result)
        return result

    async def finish(self) -> None:
        for client in self.clients:
            await client.close()
        self.result.update(
            usage=self.usage,
            observedApiEquivalentUsd=self.estimate(),
            priceDate="2026-10-14",
            sourceAuthUnchanged=hashlib.sha256(self.auth_source.read_bytes()).hexdigest() == self.auth_hash,
            missingUsage=(
                "No upstream capture: warmups, failed/interrupted unreported work unknown; subscription billing unknown"
            ),
        )
        self.save("result.json", self.result)
        print(
            json.dumps(
                {
                    "artifacts": str(self.artifacts),
                    "error": self.result.get("error"),
                    "turnAttempts": self.turns,
                    "observedApiEquivalentUsd": self.estimate(),
                }
            ),
            flush=True,
        )


async def joins(probe: Probe) -> None:
    async with launch(probe.profile, probe.options()) as server:
        endpoint = server.endpoint
        a = await probe.client("A", endpoint, auth=True)
        b = await probe.client("B-before", endpoint)
        thread = await probe.start_thread(
            a,
            dynamicTools=[
                {
                    "type": "function",
                    "name": "join_gate",
                    "description": "A local experiment gate. Call once when instructed, then wait for its result.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"label": {"type": "string"}},
                        "required": ["label"],
                        "additionalProperties": False,
                    },
                }
            ],
        )
        probe.result["threadId"] = thread
        prompt = (
            "Call join_gate once with label first. Do not call any other tool. "
            "After its result reply exactly FIRST_DONE."
        )
        turn, index = await probe.turn(a, thread, prompt)
        callback = await a.wait("item/tool/call", after=index)
        probe.result["cases"]["beforeTurn"] = {"bEvents": b.messages, "callback": callback}
        c = await probe.client("C-pending", endpoint)
        await asyncio.sleep(0.25)
        probe.result["cases"]["pendingInit"] = list(c.messages)
        await probe.snapshot(c, thread, "pending-read")
        await asyncio.sleep(0.25)
        probe.result["cases"]["pendingReadEvents"] = list(c.messages)
        resume = await c.request("thread/resume", {"threadId": thread})
        probe.save("pending-resume.json", resume)
        await asyncio.sleep(0.25)
        probe.result["cases"]["pendingResumeEvents"] = list(c.messages)
        probe.result["cases"]["staleSteer"] = await b.request(
            "turn/steer",
            {"threadId": thread, "expectedTurnId": "stale-turn", "input": text_input("ignore stale")},
            raw=True,
        )
        await b.send(
            {
                "id": callback["id"],
                "result": {
                    "success": True,
                    "contentItems": [{"type": "inputText", "text": "B answered. Reply FIRST_DONE now."}],
                },
            }
        )
        await a.wait("turn/completed", after=index)
        probe.result["cases"]["eitherResponder"] = {
            "a": a.messages[index:],
            "b": list(b.messages),
            "c": list(c.messages),
        }
        await probe.snapshot(c, thread, "after-completion")
        await a.send(
            {
                "id": callback["id"],
                "result": {"success": True, "contentItems": [{"type": "inputText", "text": "LATE_A_ANSWER"}]},
            }
        )
        await asyncio.sleep(0.2)
        d = await probe.client("D-after", endpoint)
        probe.save("after-resume.json", await d.request("thread/resume", {"threadId": thread}))
        await b.close()
        turn, index = await probe.turn(
            a,
            thread,
            "Call join_gate once with label race. Do not call any other tool. After the result echo only its text.",
        )
        callback = await a.wait("item/tool/call", after=index)
        await asyncio.gather(
            a.send(
                {
                    "id": callback["id"],
                    "result": {"success": True, "contentItems": [{"type": "inputText", "text": "ANSWER_A"}]},
                }
            ),
            c.send(
                {
                    "id": callback["id"],
                    "result": {"success": True, "contentItems": [{"type": "inputText", "text": "ANSWER_C"}]},
                }
            ),
        )
        await a.wait("turn/completed", after=index)
        probe.result["cases"]["race"] = {"a": a.messages[index:], "c": list(c.messages)}
        await probe.snapshot(a, thread, "race-history")
        probe.result["cases"]["unsubscribeD"] = await d.request("thread/unsubscribe", {"threadId": thread}, raw=True)
        turn, index = await probe.turn(
            a,
            thread,
            "Call join_gate once with label disconnect. Do not call any other tool. "
            "After the result reply DISCONNECT_DONE.",
        )
        callback = await a.wait("item/tool/call", after=index)
        await a.close()
        await c.close()
        await d.close()
        await asyncio.sleep(1)
        probe.result["cases"]["allDisconnectedServerStatus"] = await server.status()
        e = await probe.client("E-reconnect", endpoint)
        probe.save("disconnect-resume.json", await e.request("thread/resume", {"threadId": thread}))
        await asyncio.sleep(0.3)
        replay = next((m for m in e.messages if m.get("method") == "item/tool/call"), None)
        probe.result["cases"]["allDisconnectedReplay"] = replay
        if replay:
            await e.send(
                {
                    "id": replay["id"],
                    "result": {
                        "success": True,
                        "contentItems": [{"type": "inputText", "text": "Reconnected and answered."}],
                    },
                }
            )
            await e.wait("turn/completed", timeout=60)
        await probe.snapshot(e, thread, "disconnect-history")
        probe.result["cases"]["allDisconnectedEvents"] = list(e.messages)
        await e.close()
        probe.result["cases"]["relayStatusBeforeRestart"] = await server.status()
    async with launch(probe.profile, probe.options("restart-relay.jsonl")) as server:
        f = await probe.client("F-restart", server.endpoint, auth=True)
        probe.save("restart-resume.json", await f.request("thread/resume", {"threadId": thread}))
        probe.result["cases"]["restartEvents"] = list(f.messages)
        await f.close()


async def main() -> None:
    probe = Probe()
    try:
        await probe.setup()
        async with asyncio.timeout(480):
            await joins(probe)
    except Exception as error:
        probe.result["error"] = f"{type(error).__name__}: {error}"
    finally:
        await probe.finish()


if __name__ == "__main__":
    asyncio.run(main())

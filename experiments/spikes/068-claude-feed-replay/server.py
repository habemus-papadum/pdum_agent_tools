"""Disposable, SDK-free Claude process owner and output-feed attachment service.

Run with the repository root .venv (aiohttp/psutil already installed there).
Protocol JSON remains opaque here. Clients supply complete JSONL writes; only
native stdout is broadcast. Both pipe directions are recorded for diagnosis.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import json
import os
import shutil
import signal
import time
import uuid
from pathlib import Path
from typing import Any

import psutil
from aiohttp import web


class Session:
    def __init__(self, key: str, root: Path, process: asyncio.subprocess.Process) -> None:
        self.id, self.root, self.process = key, root, process
        self.identity = psutil.Process(process.pid)
        self.created = self.identity.create_time()
        self.journal_path = root / "profile" / ".aiui" / "running" / key / "feed.jsonl"
        self.journal_path.parent.mkdir(parents=True, mode=0o700)
        self.journal_path.touch(mode=0o600)
        self.entries: list[dict[str, Any]] = []
        self.peers: set[asyncio.Queue] = set()
        self.disk: asyncio.Queue = asyncio.Queue()
        self.disk_errors: list[str] = []
        self.input_lock = asyncio.Lock()
        self.stop_lock = asyncio.Lock()
        self.exited = asyncio.Event()
        self.writer = asyncio.create_task(self._write_journal())
        self.readers = [
            asyncio.create_task(self._read(process.stdout, "stdout")),
            asyncio.create_task(self._read(process.stderr, "stderr")),
        ]
        self.watcher = asyncio.create_task(self._watch())

    def record(self, direction: str, data: bytes) -> dict:
        entry = {
            "seq": len(self.entries) + 1,
            "direction": direction,
            "timeNs": time.time_ns(),
            "bytes": len(data),
            "data": base64.b64encode(data).decode("ascii"),
        }
        self.entries.append(entry)
        self.disk.put_nowait(entry)
        if direction == "stdout":
            # Enqueue only: no disk I/O, parsing or slow client awaits here.
            event = {"kind": "output", **entry}
            for queue in self.peers:
                queue.put_nowait(event)
        return entry

    async def _read(self, stream: asyncio.StreamReader, direction: str) -> None:
        while data := await stream.read(64 * 1024):
            self.record(direction, data)

    async def _write_journal(self) -> None:
        def append(data: str) -> None:
            with self.journal_path.open("a") as output:
                output.write(data)

        while True:
            entry = await self.disk.get()
            try:
                if entry is None:
                    return
                await asyncio.to_thread(append, json.dumps(entry, separators=(",", ":")) + "\n")
            except OSError as error:
                self.disk_errors.append(type(error).__name__)
            finally:
                self.disk.task_done()

    async def _watch(self) -> None:
        code = await self.process.wait()
        await asyncio.gather(*self.readers)
        # The marker follows all stdout; it never impersonates native protocol.
        for queue in self.peers:
            queue.put_nowait({"kind": "process-exit", "exitCode": code})
        self.exited.set()

    async def write(self, data: bytes) -> None:
        # Serialize whole transport messages into the one stdin pipe. Do not
        # parse, validate, add a newline, rewrite IDs or interpret acceptance.
        async with self.input_lock:
            self.process.stdin.write(data)
            self.record("stdin", data)
            await self.process.stdin.drain()

    def attach(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        # No await: the snapshot boundary and subscriber registration form one
        # event-loop operation. Outputs after highWater enter the same queue.
        high_water = len(self.entries)
        history = [entry for entry in self.entries if entry["direction"] == "stdout"]
        queue.put_nowait(
            {
                "kind": "replay-start",
                "highWater": high_water,
                "outputChunks": len(history),
                "outputBytes": sum(e["bytes"] for e in history),
            }
        )
        for entry in history:
            queue.put_nowait({"kind": "output", **entry})
        queue.put_nowait({"kind": "replay-end", "highWater": high_water})
        self.peers.add(queue)
        if self.exited.is_set():
            queue.put_nowait({"kind": "process-exit", "exitCode": self.process.returncode})
        return queue

    def status(self) -> dict:
        return {
            "id": self.id,
            "pid": self.process.pid,
            "created": self.created,
            "running": self.process.returncode is None,
            "exitCode": self.process.returncode,
            "clients": len(self.peers),
            "journalEntries": len(self.entries),
            "journalBacklog": self.disk.qsize(),
            "journalErrors": self.disk_errors,
            "clientBacklogs": [q.qsize() for q in self.peers],
            "journalPath": str(self.journal_path),
        }

    async def stop(self) -> None:
        async with self.stop_lock:
            if (
                self.process.returncode is None
                and self.identity.is_running()
                and self.identity.create_time() == self.created
            ):
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.exited.wait(), 3)
                except TimeoutError:
                    if self.process.returncode is None:
                        self.process.kill()
                    await asyncio.wait_for(self.exited.wait(), 3)
            # returncode can be set while pipe readers still hold the exit tail.
            # Never stop the journal writer before those readers have finished.
            await asyncio.wait_for(self.exited.wait(), 3)
            await self.disk.join()

    async def close(self) -> None:
        await self.stop()
        if not self.writer.done():
            self.disk.put_nowait(None)
            await self.writer


class Owner:
    def __init__(self, root: Path, token_file: Path | None = None, executable: str | None = None) -> None:
        self.root = root.resolve()
        self.token_file = token_file
        self.executable = str(Path(executable or shutil.which("claude")).resolve())
        self.sessions: dict[str, Session] = {}
        self.lock = asyncio.Lock()

    async def launch(
        self,
        *,
        tools: str = "",
        permission: str = "bypassPermissions",
        model: str = "haiku",
        max_budget: float | None = None,
        max_turns: int | None = None,
        command: list[str] | None = None,
    ) -> Session:
        key = str(uuid.uuid4())
        directory = self.root / key
        for child in ("home", "profile", "workspace", "tmp"):
            (directory / child).mkdir(parents=True, mode=0o700)
        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(directory / "home"),
            "TMPDIR": str(directory / "tmp"),
            "CLAUDE_CONFIG_DIR": str(directory / "profile"),
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "256",
        }
        if self.token_file:
            environment["CLAUDE_CODE_OAUTH_TOKEN"] = self.token_file.read_text().strip()
        else:
            environment["CLAUDE_CODE_OAUTH_TOKEN"] = "deliberately-invalid-no-model-probe"
        args = [
            self.executable,
            "--print",
            "--input-format=stream-json",
            "--output-format=stream-json",
            "--verbose",
            "--include-partial-messages",
            "--replay-user-messages",
            f"--model={model}",
            f"--permission-mode={permission}",
            "--permission-prompt-tool=stdio",
            f"--tools={tools}",
            "--setting-sources=",
            "--strict-mcp-config",
            "--disable-slash-commands",
            '--settings={"sandbox":{"enabled":false}}',
            f"--session-id={key}",
        ]
        if max_budget is not None:
            args.append(f"--max-budget-usd={max_budget}")
        if max_turns is not None:
            args.append(f"--max-turns={max_turns}")
        if command is not None:  # Only local transport tests inject a producer.
            args = command
        async with self.lock:
            process = await asyncio.create_subprocess_exec(
                *args,
                cwd=directory / "workspace",
                env=environment,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            session = Session(key, directory, process)
            self.sessions[key] = session
        (directory / "launch.json").write_text(
            json.dumps({"argv": args, "pid": process.pid, "created": session.created}, indent=2) + "\n"
        )
        return session

    async def close(self) -> None:
        async with self.lock:
            await asyncio.gather(*(session.close() for session in self.sessions.values()))


def make_app(owner: Owner) -> web.Application:
    app = web.Application(client_max_size=0)

    async def list_sessions(request: web.Request) -> web.Response:
        return web.json_response({"sessions": [s.status() for s in owner.sessions.values()]})

    async def launch(request: web.Request) -> web.Response:
        options = await request.json() if request.can_read_body else {}
        session = await owner.launch(**options)
        return web.json_response({**session.status(), "feed": f"/sessions/{session.id}/feed"})

    async def status(request: web.Request) -> web.Response:
        return web.json_response(owner.sessions[request.match_info["id"]].status())

    async def stop(request: web.Request) -> web.Response:
        session = owner.sessions[request.match_info["id"]]
        await session.stop()
        return web.json_response(session.status())

    async def reap(request: web.Request) -> web.Response:
        session = owner.sessions[request.match_info["id"]]
        if session.process.returncode is None:
            return web.json_response({"error": "process still running"}, status=409)
        await session.close()
        shutil.rmtree(session.journal_path.parent)
        session.entries.clear()
        return web.json_response({"reaped": session.id})

    async def feed(request: web.Request) -> web.WebSocketResponse:
        session = owner.sessions[request.match_info["id"]]
        ws = web.WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        queue = session.attach()

        async def deliver() -> None:
            while True:
                event = await queue.get()
                await ws.send_json(event)

        sender = asyncio.create_task(deliver())
        try:
            async for message in ws:
                if message.type == web.WSMsgType.TEXT:
                    await session.write(message.data.encode("utf8"))
                elif message.type == web.WSMsgType.BINARY:
                    await session.write(message.data)
        except (BrokenPipeError, ConnectionResetError):
            await ws.close(code=1011, message=b"process input unavailable")
        finally:
            session.peers.discard(queue)
            sender.cancel()
            with contextlib.suppress(asyncio.CancelledError, ConnectionResetError):
                await sender
        return ws

    async def cleanup(app: web.Application) -> None:
        await owner.close()

    app.router.add_get("/sessions", list_sessions)
    app.router.add_post("/sessions", launch)
    app.router.add_get("/sessions/{id}", status)
    app.router.add_post("/sessions/{id}/stop", stop)
    app.router.add_post("/sessions/{id}/reap", reap)
    app.router.add_get("/sessions/{id}/feed", feed)
    app.on_cleanup.append(cleanup)
    return app


async def serve(owner: Owner, host: str = "127.0.0.1", port: int = 0) -> tuple[web.AppRunner, str]:
    runner = web.AppRunner(make_app(owner))
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    actual_port = site._server.sockets[0].getsockname()[1]
    return runner, f"http://{host}:{actual_port}"


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=0)
    options = parser.parse_args()
    owner = Owner(options.root, options.token_file)
    runner, url = await serve(owner, options.host, options.port)
    print(json.dumps({"url": url, "ownerPid": os.getpid()}), flush=True)
    stopped = asyncio.Event()
    for name in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(name, stopped.set)
    try:
        await stopped.wait()
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())

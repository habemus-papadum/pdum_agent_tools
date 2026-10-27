"""Real foreground HTTP processes qualify isolation and owned shutdown."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest


@dataclass
class Instance:
    process: asyncio.subprocess.Process
    ready: dict[str, Any]
    state: Path

    async def cleanup(self) -> None:
        if self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.process.stdin:
            self.process.stdin.close()


async def start_instance(path: Path, *, eof: bool = False) -> Instance:
    source = Path(__file__).resolve().parents[1] / "src"
    command = [
        sys.executable,
        "-m",
        "pdum.orchestrator",
        "serve",
        "--state-directory",
        str(path),
        "--workspace-directory",
        str(path.parent),
        "--port",
        "0",
    ]
    if eof:
        command.append("--exit-on-stdin-eof")
    process = await asyncio.create_subprocess_exec(
        *command,
        env={**os.environ, "PYTHONPATH": str(source)},
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        assert process.stdout is not None
        line = await asyncio.wait_for(process.stdout.readline(), 10)
        if not line:
            assert process.stderr is not None
            raise AssertionError((await process.stderr.read()).decode())
        ready = json.loads(line)
        assert ready["type"] == "orchestrator-ready"
        assert ready["boundHost"] == "0.0.0.0"
        assert ready["pid"] == process.pid
        return Instance(process, ready, path)
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise


async def test_two_http_instances_and_wrong_instance_shutdown(tmp_path: Path) -> None:
    first = await start_instance(tmp_path / "one")
    second: Instance | None = None
    try:
        second = await start_instance(tmp_path / "two")
        assert first.ready["url"] != second.ready["url"]
        assert first.ready["instanceId"] != second.ready["instanceId"]
        async with httpx.AsyncClient(timeout=3) as client:
            a = (await client.get(first.ready["url"] + "/api/status")).json()
            b = (await client.get(second.ready["url"] + "/api/status")).json()
            assert a["instanceId"] == first.ready["instanceId"]
            assert b["instanceId"] == second.ready["instanceId"]
            assert a["profileRoots"] != b["profileRoots"]
            assert (await client.get(first.ready["url"] + "/api/runs")).json() == {"runs": []}
            assert (await client.post(first.ready["url"] + "/api/runs", json={})).status_code == 405
            wrong = await client.post(first.ready["url"] + "/api/stop", json={"instanceId": b["instanceId"]})
            assert wrong.status_code == 409
            assert (await client.get(first.ready["url"] + "/api/status")).json()["state"] == "running"
            stopped = await client.post(first.ready["url"] + "/api/stop", json={"instanceId": a["instanceId"]})
            assert stopped.status_code == 200
            assert stopped.json() == {"instanceId": a["instanceId"], "accepted": True}
            await asyncio.wait_for(first.process.wait(), 5)
            assert first.process.returncode == 0
            assert (await client.get(second.ready["url"] + "/api/status")).json()["state"] == "running"
            saved = json.loads((first.state / "instance.json").read_text())
            assert saved["state"] == "stopped"
            assert saved["processStartedAt"] == a["processStartedAt"]
            assert saved["stoppedAt"] is not None
    finally:
        await first.cleanup()
        if second:
            await second.cleanup()


@pytest.mark.parametrize("method", ["signal", "stdin"])
async def test_entrypoint_lifetime_cleanup(tmp_path: Path, method: str) -> None:
    instance = await start_instance(tmp_path / method, eof=method == "stdin")
    try:
        if method == "signal":
            instance.process.send_signal(signal.SIGTERM)
        else:
            assert instance.process.stdin is not None
            instance.process.stdin.close()
        await asyncio.wait_for(instance.process.wait(), 5)
        assert instance.process.returncode == 0
        record = json.loads((instance.state / "instance.json").read_text())
        assert record["state"] == "stopped"
        assert record["stoppedAt"] is not None
    finally:
        await instance.cleanup()


async def test_failed_bind_never_emits_readiness_and_closes_owner(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[1] / "src"
    path = tmp_path / "failed-bind"
    with socket.socket() as occupied:
        occupied.bind(("0.0.0.0", 0))
        occupied.listen()
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "pdum.orchestrator",
            "serve",
            "--state-directory",
            str(path),
            "--port",
            str(occupied.getsockname()[1]),
            env={**os.environ, "PYTHONPATH": str(source)},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), 10)
    assert process.returncode == 1
    assert stdout == b""
    assert b"in use" in stderr.lower()
    assert json.loads((path / "instance.json").read_text())["state"] == "stopped"

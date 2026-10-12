"""Real installed native client compatibility, without credentials or inference."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import signal
import sys
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from pdum.codex_launcher.relay import open_relay
from websockets.asyncio.client import connect, unix_connect


class ProtocolRecorder:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def open(self) -> None:
        pass

    async def process(self, observation) -> None:
        self.messages.append(json.loads(observation.payload))

    async def close(self) -> None:
        pass


@pytest.fixture
async def native_app_server(tmp_path: Path) -> AsyncIterator[tuple[str, str]]:
    binary = shutil.which("codex")
    if binary is None:
        pytest.skip("Codex executable is not installed")
    home = tmp_path / "home"
    codex_home = tmp_path / "codex"
    home.mkdir()
    codex_home.mkdir()
    socket_directory = tempfile.TemporaryDirectory(prefix="pdum-tui-", dir="/tmp")
    socket_path = Path(socket_directory.name) / "backend.sock"
    environment = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "CODEX_HOME": str(codex_home),
        "TERM": "xterm-256color",
    }
    server = await asyncio.create_subprocess_exec(
        binary,
        "app-server",
        "--listen",
        f"unix://{socket_path}",
        cwd=tmp_path,
        env=environment,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        async with asyncio.timeout(15):
            while not socket_path.exists():
                assert server.returncode is None, "Native app-server exited before readiness"
                await asyncio.sleep(0.05)
        yield binary, f"unix://{socket_path}"
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(server.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(server.wait(), 5)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(server.pid, signal.SIGKILL)
            await server.wait()
        socket_directory.cleanup()


@pytest.mark.codex
@pytest.mark.skipif(sys.platform == "win32", reason="The remote TUI probe uses POSIX pseudoterminals")
async def test_real_remote_tui_through_relay(native_app_server: tuple[str, str]) -> None:
    binary, upstream_url = native_app_server
    recorder = ProtocolRecorder()
    async with open_relay(upstream_url, host="127.0.0.1", port=0, processors=(recorder,)) as relay:
        script = Path(__file__).resolve().parents[3] / "scripts" / "check_codex_client.py"
        client = await asyncio.create_subprocess_exec(
            sys.executable,
            str(script),
            relay.endpoint,
            "--binary",
            binary,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(client.communicate(), 30)
        finally:
            if client.returncode is None:
                client.terminate()
                await client.wait()
        assert client.returncode == 0, stderr.decode()
        result = json.loads(stdout)
        assert result["connected"]
        assert not result["inference_requested"]
    requests = {message.get("method"): message for message in recorder.messages if "method" in message}
    assert "initialize" in requests
    assert "account/read" in requests
    account_id = requests["account/read"]["id"]
    responses = [message for message in recorder.messages if message.get("id") == account_id and "result" in message]
    assert responses
    assert responses[-1]["result"]["account"] is None
    assert "turn/start" not in requests
    assert "account/login/start" not in requests


async def read_configuration_with_large_request(connection) -> dict:
    await connection.send(
        json.dumps(
            {
                "id": 1,
                "method": "initialize",
                "params": {"clientInfo": {"name": "pdum_large_frame_test", "version": "1"}},
            }
        )
    )
    while json.loads(await connection.recv()).get("id") != 1:
        pass
    await connection.send(json.dumps({"method": "initialized"}))
    request = json.dumps(
        {
            "id": 2,
            "method": "config/read",
            "params": {"includeLayers": False, "ignoredProbePadding": "x" * (17 * 1024 * 1024)},
        }
    )
    await connection.send([request[offset : offset + 1024 * 1024] for offset in range(0, len(request), 1024 * 1024)])
    while True:
        response = json.loads(await connection.recv())
        if response.get("id") == 2:
            assert "result" in response
            return response["result"]


@pytest.mark.codex
@pytest.mark.skipif(sys.platform == "win32", reason="Native backend probe uses Unix sockets")
async def test_large_fragmented_request_matches_native_server(native_app_server: tuple[str, str]) -> None:
    _, upstream_url = native_app_server
    async with asyncio.timeout(15):
        async with unix_connect(upstream_url.removeprefix("unix://"), max_size=None) as native:
            expected = await read_configuration_with_large_request(native)
        async with open_relay(upstream_url, host="127.0.0.1") as relay:
            async with connect(relay.endpoint, max_size=None, proxy=None) as relayed:
                result = await read_configuration_with_large_request(relayed)
                assert result == expected

"""Exercise the public foreground CLI using a real ephemeral HTTP listener."""

import asyncio
import os
import re
import signal
import sys

import httpx
import pytest
from pdum.claude_launcher.profiles import create_profile

pytest.importorskip("uvicorn")
pytest.importorskip("fastapi")


async def test_ephemeral_cli_listener_reports_a_usable_endpoint_and_stops(tmp_path):
    profile = create_profile(tmp_path / "profile", workspace=tmp_path)
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "pdum.claude_launcher",
        "--profile-dir",
        str(profile.directory),
        "launch",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env={**os.environ, "NO_COLOR": "1", "COLUMNS": "240"},
    )
    try:
        assert process.stdout is not None
        async with asyncio.timeout(10):
            while True:
                line = await process.stdout.readline()
                assert line, "CLI exited before reporting its listener"
                match = re.search(rb"Claude manager: (http://127\.0\.0\.1:(\d+));", line)
                if match:
                    endpoint = match.group(1).decode()
                    assert int(match.group(2)) > 0
                    break
            async with httpx.AsyncClient(base_url=endpoint, trust_env=False) as client:
                while True:
                    try:
                        response = await client.get("/api/profiles")
                        break
                    except httpx.ConnectError:
                        await asyncio.sleep(0.02)
                assert response.status_code == 200
                assert response.json()[0]["id"] == "profile"
                assert (await client.get("/api/workers")).json() == []
        process.send_signal(signal.SIGINT)
        await asyncio.wait_for(process.wait(), 10)
        assert process.returncode in (0, 130, -signal.SIGINT)
        async with httpx.AsyncClient(trust_env=False) as client:
            with pytest.raises(httpx.ConnectError):
                await client.get(endpoint + "/api/status", timeout=1)
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()

"""Real HTTP and WebSocket clients exercise the optional management adapter."""

import asyncio
import socket
import sys
from contextlib import asynccontextmanager
from dataclasses import replace

import httpx
import psutil
import pytest
from pdum.claude_launcher.authentication import AuthSpec
from pdum.claude_launcher.management import create_app
from pdum.claude_launcher.profiles import create_profile
from pdum.claude_launcher.runtime import ClaudeManager
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

uvicorn = pytest.importorskip("uvicorn")
pytest.importorskip("fastapi")


@pytest.fixture
def profile(tmp_path):
    script = tmp_path / "echo-child"
    script.write_text(
        f"#!{sys.executable}\nimport os\nos.write(1, b'ready\\n')\nwhile data := os.read(0, 65536): os.write(1, data)\n"
    )
    script.chmod(0o700)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return create_profile(tmp_path / "profile", workspace=workspace, executable=str(script))


@asynccontextmanager
async def running_management(profile):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    manager = ClaudeManager({"shared": profile}, stop_timeout=0.5)
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(manager),
            ws="websockets",
            ws_max_size=None,
            ws_max_queue=None,
            timeout_graceful_shutdown=1,
            log_level="critical",
        )
    )
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if task.done():
                    task.result()
                await asyncio.sleep(0.01)
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
            yield client, manager, server, task
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(task, 5)
        finally:
            await manager.aclose()
            listener.close()


async def test_http_management_independent_workers_and_explicit_stop(profile):
    async with running_management(profile) as (client, manager, _, _):
        profiles = (await client.get("/api/profiles")).json()
        assert [selected["id"] for selected in profiles] == ["shared"]
        first_response = await client.post("/api/workers", json={"profileId": "shared"})
        second_response = await client.post("/api/workers", json={"profileId": "shared"})
        assert first_response.status_code == second_response.status_code == 201
        first, second = first_response.json(), second_response.json()
        assert first["state"] == second["state"] == "waiting"
        assert first["pid"] is second["pid"] is None
        assert first["conversationId"] != second["conversationId"]
        async with connect(first["websocketUrl"]) as one, connect(second["websocketUrl"]) as two:
            assert await one.recv() == await two.recv() == "ready\n"
            one_status = (await client.get(f"/api/workers/{first['id']}")).json()
            two_status = (await client.get(f"/api/workers/{second['id']}")).json()
            assert one_status["pid"] != two_status["pid"]
            assert one_status["state"] == two_status["state"] == "connected"
            stop_response = await client.delete(f"/api/workers/{first['id']}")
            assert stop_response.status_code == 200
            assert stop_response.json()["state"] == "stopped"
            assert not psutil.pid_exists(one_status["pid"])
            with pytest.raises(ConnectionClosed):
                await one.recv()
            await two.send("independent\n")
            assert await two.recv() == "independent\n"
        async with asyncio.timeout(5):
            while manager.worker(second["id"]).state != "stopped":
                await asyncio.sleep(0.01)
        assert not psutil.pid_exists(two_status["pid"])
        assert len((await client.get("/api/status")).json()["workers"]) == 2


async def test_management_invalid_requests_have_actionable_statuses(profile):
    async with running_management(profile) as (client, _, _, _):
        assert (await client.get("/api/workers/missing")).status_code == 404
        assert (await client.delete("/api/workers/missing")).status_code == 404
        assert (await client.post("/api/workers", json={"profileId": "missing"})).status_code == 404
        assert (await client.post("/api/workers", json={})).status_code == 422
        for options in (
            "invalid",
            {"extra": "unsupported"},
            {"tools": "Bash"},
            {"tools": [42]},
            {"max_turns": 1.5},
            {"max_turns": True},
            {"max_budget_usd": -1},
            {"sandbox": "true"},
            {"model": ""},
        ):
            response = await client.post("/api/workers", json={"profileId": "shared", "options": options})
            assert response.status_code == 422, options


async def test_missing_authentication_is_an_actionable_worker_failure(profile, monkeypatch):
    variable = "PDUM_TEST_UNSET_CLAUDE_KEY"
    monkeypatch.delenv(variable, raising=False)
    profile = replace(profile, auth=AuthSpec("api-key", api_key_env=variable))
    async with running_management(profile) as (client, _, _, _):
        worker = (await client.post("/api/workers", json={"profileId": "shared"})).json()
        async with connect(worker["websocketUrl"]) as connection:
            with pytest.raises(ConnectionClosed):
                await connection.recv()
        status = (await client.get(f"/api/workers/{worker['id']}")).json()
        assert status["state"] == "failed"
        assert status["pid"] is None
        assert variable in status["reason"]
        assert status["cleanup_errors"] == 0


async def test_uvicorn_shutdown_ends_idle_socket_and_process(profile):
    async with running_management(profile) as (client, manager, server, task):
        waiting = (await client.post("/api/workers", json={"profileId": "shared"})).json()
        worker = (await client.post("/api/workers", json={"profileId": "shared"})).json()
        async with connect(worker["websocketUrl"]) as connection:
            assert await connection.recv() == "ready\n"
            pid = manager.worker(worker["id"]).pid
            server.should_exit = True
            await asyncio.wait_for(task, 5)
            with pytest.raises(ConnectionClosed):
                await connection.recv()
        await manager.aclose()
        assert manager.worker(worker["id"]).state == "stopped"
        assert manager.worker(waiting["id"]).state == "stopped"
        assert not psutil.pid_exists(pid)

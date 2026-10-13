"""Real subprocess and socket checks; the child is a transport fixture, not a model."""

import asyncio
import json
import os
import shutil
import signal
import sys
from dataclasses import replace
from pathlib import Path

import psutil
import pytest
from pdum.claude_launcher.errors import ProfileError
from pdum.claude_launcher.profiles import create_profile
from pdum.claude_launcher.relay import open_relay
from pdum.claude_launcher.runtime import ClaudeManager, LaunchOptions, worker_arguments
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed


@pytest.fixture
def fixture_profile(tmp_path):
    executable = tmp_path / "transport-child"
    executable.write_text(
        f"#!{sys.executable}\n"
        "import os, signal, subprocess, sys, time\n"
        "mode = os.environ.get('PDUM_TEST_MODE', 'echo')\n"
        "if mode == 'exit-error':\n"
        "    os.write(2, b'fixture abnormal exit\\n')\n"
        "    sys.exit(17)\n"
        "if mode == 'orphan-pipes':\n"
        "    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "    os.write(1, (str(child.pid) + '\\n').encode())\n"
        "    os._exit(0)\n"
        "if mode == 'stubborn':\n"
        "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "    child = subprocess.Popen([sys.executable, '-c', "
        "'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'])\n"
        "    os.write(1, (str(child.pid) + '\\n').encode())\n"
        "    while True: time.sleep(1)\n"
        "os.write(1, b'\\xe2')\n"
        "time.sleep(0.02)\n"
        "os.write(1, b'\\x82\\xac\\n')\n"
        "while data := os.read(0, 65536):\n"
        "    os.write(1, data)\n"
        "    os.write(2, b'fixture diagnostic\\n')\n"
    )
    executable.chmod(0o700)
    workspace = tmp_path / "work"
    workspace.mkdir()
    return create_profile(tmp_path / "profile", workspace=workspace, executable=str(executable))


async def receive_length(socket, length):
    text = ""
    while len(text) < length:
        text += await asyncio.wait_for(socket.recv(), 10)
    assert len(text) == length
    return text


async def wait_stopped(worker):
    async with asyncio.timeout(10):
        while worker.state not in {"stopped", "failed"}:
            await asyncio.sleep(0.01)


async def test_lazy_workers_share_profile_and_preserve_large_utf8_stream(fixture_profile):
    observations = []
    async with ClaudeManager(
        {"shared": fixture_profile}, observer=lambda *observation: observations.append(observation)
    ) as manager:
        first = await manager.allocate("shared")
        second = await manager.allocate("shared")
        assert first.pid is second.pid is None
        assert first.conversation_id != second.conversation_id
        async with open_relay(manager, host="127.0.0.1") as relay:
            async with (
                connect(relay.worker_url(first.id), origin="http://trusted-browser.example", max_size=None) as one,
                connect(relay.worker_url(second.id), max_size=None) as two,
            ):
                assert await receive_length(one, 2) == "€\n"
                assert await receive_length(two, 2) == "€\n"
                assert first.pid and second.pid and first.pid != second.pid
                # No NDJSON parser, size limit or newline rewriting lives in the relay.
                payload = json.dumps({"unknown_native_field": "é" * 600_000}, ensure_ascii=False) + "\n\n"
                await one.send(payload[:31])
                await one.send(payload[31:].encode())
                assert await receive_length(one, len(payload)) == payload
                await two.send("partial-json-without-newline")
                assert await receive_length(two, 28) == "partial-json-without-newline"
            await wait_stopped(first)
            await wait_stopped(second)
        assert first.exit_code == second.exit_code == 0
        assert not psutil.pid_exists(first.pid)
        assert not psutil.pid_exists(second.pid)
    first_input = b"".join(item[2] for item in observations if item[:2] == (first.id, "client_to_worker"))
    first_output = b"".join(item[2] for item in observations if item[:2] == (first.id, "worker_to_client"))
    assert first_input == payload.encode()
    assert first_output == "€\n".encode() + payload.encode()
    assert first.stderr_bytes > 0


async def test_second_controller_is_rejected_without_stopping_first(fixture_profile):
    async with ClaudeManager({"shared": fixture_profile}) as manager, open_relay(manager) as relay:
        worker = await manager.allocate("shared")
        async with connect(relay.worker_url(worker.id)) as first:
            assert await receive_length(first, 2) == "€\n"
            async with connect(relay.worker_url(worker.id)) as duplicate:
                with pytest.raises(ConnectionClosed):
                    await duplicate.recv()
                assert duplicate.close_code == 1008
            assert worker.state == "connected"
            await first.send("still-alive\n")
            assert await receive_length(first, 12) == "still-alive\n"
        await wait_stopped(worker)
        async with connect(relay.worker_url(worker.id)) as reconnect:
            with pytest.raises(ConnectionClosed):
                await reconnect.recv()
            assert reconnect.close_code == 1008


async def test_shutdown_stops_idle_client_and_unattached_allocation(fixture_profile):
    manager = ClaudeManager({"shared": fixture_profile})
    async with open_relay(manager) as relay:
        connected = await manager.allocate("shared")
        waiting = await manager.allocate("shared")
        async with connect(relay.worker_url(connected.id)) as socket:
            assert await receive_length(socket, 2) == "€\n"
            await asyncio.wait_for(manager.aclose(), 10)
            with pytest.raises(ConnectionClosed):
                await socket.recv()
        assert connected.state == waiting.state == "stopped"
        assert waiting.pid is None
        assert not psutil.pid_exists(connected.pid)
        await manager.aclose()
        with pytest.raises(RuntimeError, match="closing"):
            await manager.allocate("shared")


@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group cleanup fixture")
async def test_cleanup_escalates_for_owned_child_and_descendant(fixture_profile):
    async with (
        ClaudeManager({"shared": fixture_profile}, stop_timeout=0.2) as manager,
        open_relay(manager) as relay,
    ):
        worker = await manager.allocate("shared", options=LaunchOptions(environment={"PDUM_TEST_MODE": "stubborn"}))
        async with connect(relay.worker_url(worker.id)) as socket:
            descendant_pid = int(await asyncio.wait_for(socket.recv(), 5))
            descendant = psutil.Process(descendant_pid)
            await manager.stop(worker.id)
            assert worker.exit_code == -signal.SIGKILL
            assert worker.cleanup_errors == 0
            assert not psutil.pid_exists(worker.pid)
            assert not descendant.is_running() or descendant.status() == psutil.STATUS_ZOMBIE


async def test_launch_failure_is_retained_and_not_retried(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    profile = create_profile(tmp_path / "profile", workspace=work, executable="/nonexistent/claude-executable")
    async with ClaudeManager({"missing": profile}) as manager:
        worker = await manager.allocate("missing")

        async def receive():
            raise AssertionError("A failed child cannot receive protocol traffic")

        async def send(_):
            raise AssertionError("A failed child cannot produce protocol traffic")

        with pytest.raises(ProfileError):
            await manager.bridge(worker.id, receive, send)
        assert worker.state == "failed"
        assert worker.pid is None
        assert worker.stopped_at
        with pytest.raises(RuntimeError, match="claimed or stopped"):
            await manager.bridge(worker.id, receive, send)


async def test_cancel_bridge_and_observer_failure_do_not_leak_process(fixture_profile):
    def broken_observer(*_):
        raise OSError("injected observation failure")

    async with ClaudeManager({"shared": fixture_profile}, observer=broken_observer) as manager:
        worker = await manager.allocate("shared")
        received = asyncio.Queue()

        async def receive():
            await asyncio.Event().wait()

        task = asyncio.create_task(manager.bridge(worker.id, receive, received.put))
        assert await asyncio.wait_for(received.get(), 5) == "€\n"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert worker.state == "stopped"
        assert worker.observation_errors >= 1
        assert not psutil.pid_exists(worker.pid)


async def test_native_launch_recipe_defaults_and_explicit_limits(fixture_profile):
    async with ClaudeManager({"shared": fixture_profile}) as manager:
        worker = await manager.allocate("shared")
        args = worker_arguments(fixture_profile, worker)
        assert "--permission-mode=bypassPermissions" in args
        assert '--settings={"sandbox":{"enabled":false}}' in args
        assert "--setting-sources=user,project" in args
        assert not any(arg.startswith(("--max-turns", "--max-budget", "--tools")) for arg in args)
        await manager.stop(worker.id)
        resumed = await manager.allocate(
            "shared", resume=worker.conversation_id, options=LaunchOptions(tools=(), max_turns=1, max_budget_usd=0.05)
        )
        args = worker_arguments(fixture_profile, resumed)
        assert f"--resume={worker.conversation_id}" in args
        assert "--tools=" in args
        assert "--max-turns=1" in args
        assert "--max-budget-usd=0.05" in args
    with pytest.raises(ValueError, match="isolation"):
        LaunchOptions(environment={"CLAUDE_CONFIG_DIR": str(Path.home() / ".claude")})


async def test_abnormal_child_exit_closes_client_and_retains_failure(fixture_profile):
    async with ClaudeManager({"shared": fixture_profile}) as manager, open_relay(manager) as relay:
        worker = await manager.allocate("shared", options=LaunchOptions(environment={"PDUM_TEST_MODE": "exit-error"}))
        async with connect(relay.worker_url(worker.id)) as socket:
            with pytest.raises(ConnectionClosed):
                await socket.recv()
            assert socket.close_code == 1011
        await wait_stopped(worker)
        assert worker.state == "failed"
        assert worker.exit_code == 17
        assert worker.stderr_bytes > 0


@pytest.mark.claude
@pytest.mark.skipif(shutil.which("claude") is None, reason="Native Claude executable is not installed")
async def test_actual_native_initialize_and_disconnect_without_inference(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profile = create_profile(tmp_path / "profile", workspace=workspace, executable=shutil.which("claude"))
    async with ClaudeManager({"native": profile}) as manager, open_relay(manager, host="127.0.0.1") as relay:
        worker = await manager.allocate("native", options=LaunchOptions(tools=(), max_turns=1, max_budget_usd=0.05))
        async with connect(relay.worker_url(worker.id), origin="http://trusted-browser.example") as socket:
            await socket.send(
                json.dumps(
                    {
                        "type": "control_request",
                        "request_id": "credential-free-initialize",
                        "request": {"subtype": "initialize", "hooks": {}, "sdkMcpServers": []},
                    }
                )
                + "\n"
            )
            pending = ""
            response = None
            async with asyncio.timeout(20):
                while response is None:
                    pending += await socket.recv()
                    while "\n" in pending:
                        line, pending = pending.split("\n", 1)
                        if not line.strip():
                            continue
                        frame = json.loads(line)
                        candidate = frame.get("response", {})
                        if candidate.get("request_id") == "credential-free-initialize":
                            response = candidate
                assert response["subtype"] == "success"
                assert response["response"].get("account", {}).get("tokenSource", "none") == "none"
                assert worker.pid and psutil.pid_exists(worker.pid)
        await wait_stopped(worker)
        assert worker.state == "stopped"
        assert worker.cleanup_errors == 0
        assert not psutil.pid_exists(worker.pid)


async def test_relative_executable_resolution_matches_auth_before_changing_workspace(fixture_profile, monkeypatch):
    monkeypatch.chdir(fixture_profile.directory.parent)
    profile = replace(fixture_profile, executable="./transport-child")
    async with ClaudeManager({"shared": profile}) as manager, open_relay(manager) as relay:
        worker = await manager.allocate("shared")
        async with connect(relay.worker_url(worker.id)) as socket:
            assert await receive_length(socket, 2) == "€\n"
        await wait_stopped(worker)
        assert worker.state == "stopped"


async def test_native_exit_with_untracked_inherited_pipe_reports_incomplete_cleanup(fixture_profile):
    descendant = None
    try:
        async with (
            ClaudeManager({"shared": fixture_profile}, stop_timeout=0.1) as manager,
            open_relay(manager) as relay,
        ):
            worker = await manager.allocate(
                "shared", options=LaunchOptions(environment={"PDUM_TEST_MODE": "orphan-pipes"})
            )
            async with connect(relay.worker_url(worker.id)) as socket:
                descendant = psutil.Process(int(await asyncio.wait_for(socket.recv(), 5)))
                with pytest.raises(ConnectionClosed):
                    await asyncio.wait_for(socket.recv(), 5)
                assert socket.close_code == 1011
            assert worker.state == "failed"
            assert worker.exit_code == 0
            assert worker.cleanup_errors >= 1
            assert "output remained open" in worker.reason
            assert descendant.is_running()
    finally:
        # The test knows the fixture's child identity independently. Runtime must
        # not infer ownership from a stale parent PID or blindly kill its group.
        if descendant is not None and descendant.is_running():
            descendant.kill()

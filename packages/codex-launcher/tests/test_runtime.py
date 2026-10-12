import asyncio
import json
import os
import shutil
import signal
import sys

import psutil
import pytest
from pdum.codex_launcher import (
    LaunchOptions,
    ProfileBusy,
    ProfileSpec,
    configure_api_key,
    create_profile,
    launch,
    login_chatgpt,
    profile_status,
    stop_profile,
)
from pdum.codex_launcher.errors import LaunchError, OwnershipUncertain
from pdum.codex_launcher.runtime import profile_lease
from websockets.asyncio.client import connect

CODEX = shutil.which("codex")
requires_codex = pytest.mark.skipif(CODEX is None, reason="Native Codex executable is not installed")


async def test_profile_lease_serializes_mutations_and_aliases(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=sys.executable))
    alias = tmp_path / "alias"
    alias.symlink_to(path, target_is_directory=True)
    async with profile_lease(path):
        (path / "runtime/owner.json").write_text(json.dumps({"server": None, "state": "starting"}))
        with pytest.raises(ProfileBusy):
            async with profile_lease(alias):
                pass
        with pytest.raises(ProfileBusy):
            await configure_api_key(path, "DUMMY_ENVIRONMENT_NAME")
    async with profile_lease(alias):
        pass


async def test_stale_or_wrong_identity_cannot_be_blindly_killed(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=sys.executable))
    wrong = {"pid": os.getpid(), "uid": os.getuid(), "create_time": 0}
    (path / "runtime/owner.json").write_text(json.dumps({"server": wrong, "state": "ready"}))
    assert not (await profile_status(path))["server_alive"]
    await stop_profile(path)
    actual = {"pid": os.getpid(), "uid": os.getuid(), "create_time": psutil.Process().create_time()}
    (path / "runtime/owner.json").write_text(json.dumps({"server": actual, "state": "ready"}))
    with pytest.raises(OwnershipUncertain):
        await stop_profile(path)
    with pytest.raises(OwnershipUncertain):
        async with profile_lease(path):
            pass


@pytest.mark.codex
@requires_codex
async def test_actual_codex_readiness_isolated_account_duplicate_and_shutdown(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=CODEX, model="gpt-6-luna"))
    async with launch(path, LaunchOptions(host="127.0.0.1")) as server:
        pid = server.pid
        state = await profile_status(path)
        assert state["locked"] and state["server_alive"]
        with pytest.raises(ProfileBusy):
            async with launch(path):
                pass
        async with connect(
            server.endpoint, origin="http://arbitrary-trusted-browser.invalid", max_size=None
        ) as websocket:
            await websocket.send(
                json.dumps(
                    {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "native-test", "version": "1"}}}
                )
            )
            while json.loads(await websocket.recv()).get("id") != 1:
                pass
            await websocket.send(json.dumps({"method": "initialized"}))
            await websocket.send(json.dumps({"id": 2, "method": "account/read", "params": {"refreshToken": False}}))
            while True:
                reply = json.loads(await websocket.recv())
                if reply.get("id") == 2:
                    assert reply["result"]["account"] is None
                    break
        stopped = await stop_profile(path)
        assert not stopped["locked"]
        assert await server.wait() is not None
    assert not psutil.pid_exists(pid)
    assert not (await stop_profile(path))["locked"]


@pytest.mark.codex
@requires_codex
async def test_cancel_live_context_cleans_up_native_process(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=CODEX))
    ready = asyncio.Event()
    observed = []

    async def operation():
        async with launch(path, LaunchOptions(relay=False)) as server:
            observed.append(server.pid)
            ready.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(operation())
    await asyncio.wait_for(ready.wait(), 15)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not psutil.pid_exists(observed[0])
    assert not (await profile_status(path))["locked"]


@pytest.mark.codex
@requires_codex
async def test_native_child_survives_owner_sigkill_but_keeps_lease(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=CODEX))
    program = (
        "import asyncio,sys\n"
        "from pathlib import Path\n"
        "from pdum.codex_launcher import launch,LaunchOptions\n"
        "async def main():\n"
        " async with launch(Path(sys.argv[1]),LaunchOptions(relay=False)) as server:\n"
        "  print(server.pid,flush=True)\n"
        "  await asyncio.Event().wait()\n"
        "asyncio.run(main())\n"
    )
    owner = await asyncio.create_subprocess_exec(
        sys.executable, "-c", program, str(path), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    server_pid = None
    try:
        async with asyncio.timeout(20):
            server_pid = int(await owner.stdout.readline())
        owner.kill()
        await owner.wait()
        assert psutil.pid_exists(server_pid)
        with pytest.raises(ProfileBusy):
            async with launch(path, LaunchOptions(relay=False)):
                pass
        state = await stop_profile(path, timeout=3)
        assert not state["locked"]
        assert not state["server_alive"]
        assert state["state"] == "closed"
        assert state["recovered"]
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()
        if server_pid and psutil.pid_exists(server_pid):
            try:
                os.killpg(server_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


async def test_failed_native_start_releases_profile_lease(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=sys.executable))
    with pytest.raises(LaunchError):
        async with launch(path, LaunchOptions(relay=False, startup_timeout=2)):
            pass
    assert not (await profile_status(path))["locked"]


@pytest.mark.codex
@requires_codex
async def test_many_competing_launches_spawn_only_one_native_server(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=CODEX))
    ready = asyncio.Event()
    release = asyncio.Event()
    successful = []

    async def contender():
        async with launch(path, LaunchOptions(relay=False)) as server:
            successful.append(server.pid)
            ready.set()
            await release.wait()

    tasks = [asyncio.create_task(contender()) for _ in range(100)]
    try:
        await asyncio.wait_for(ready.wait(), 15)
    finally:
        release.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    assert len(successful) == 1
    assert sum(isinstance(result, ProfileBusy) for result in results) == 99
    assert not (await profile_status(path))["locked"]


@pytest.mark.codex
@requires_codex
async def test_cli_sigterm_cleans_up_native_server(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=CODEX))
    owner = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "pdum.codex_launcher",
        "--profile-dir",
        str(path),
        "launch",
        "--direct",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(20):
            while True:
                state = await profile_status(path)
                if state.get("state") == "ready":
                    break
                if owner.returncode is not None:
                    raise AssertionError(f"Launcher CLI exited early: {owner.returncode}")
                await asyncio.sleep(0.05)
        server_pid = state["server"]["pid"]
        owner.terminate()
        async with asyncio.timeout(20):
            await owner.communicate()
        assert owner.returncode == 143
        assert not psutil.pid_exists(server_pid)
        assert not (await profile_status(path))["locked"]
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()


async def test_orphaned_login_keeps_lease_and_requires_verified_command_for_cleanup(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=psutil.Process().exe()))
    (path / "work/login").write_text("import time\ntime.sleep(120)\n")
    program = (
        "import asyncio,sys\n"
        "from pathlib import Path\n"
        "from pdum.codex_launcher import login_chatgpt\n"
        "asyncio.run(login_chatgpt(Path(sys.argv[1])))\n"
    )
    owner = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        program,
        str(path),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    child_pid = None
    try:
        async with asyncio.timeout(10):
            while True:
                state = await profile_status(path)
                if state.get("state") == "authenticating":
                    break
                if owner.returncode is not None:
                    raise AssertionError(f"Login owner exited early: {owner.returncode}")
                await asyncio.sleep(0.05)
        child_pid = state["server"]["pid"]
        assert state["operation"] == "login"
        owner.kill()
        await owner.wait()
        assert psutil.pid_exists(child_pid)
        with pytest.raises(ProfileBusy):
            async with profile_lease(path):
                pass
        journal = path / "runtime/owner.json"
        original = journal.read_text()
        wrong = json.loads(original)
        wrong["process_command"] = ["a-different-command", "login"]
        journal.write_text(json.dumps(wrong))
        with pytest.raises(OwnershipUncertain, match="login command"):
            await stop_profile(path, timeout=2)
        assert psutil.pid_exists(child_pid)
        journal.write_text(original)
        stopped = await stop_profile(path, timeout=2)
        assert stopped["state"] == "closed"
        assert stopped["operation"] == "login"
        assert stopped["recovered"]
        assert not stopped["server_alive"]
        assert not stopped["locked"]
        assert (await stop_profile(path))["state"] == "closed"
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()
        if child_pid and psutil.pid_exists(child_pid):
            try:
                os.killpg(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


async def test_successful_local_login_process_finalizes_journal(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=psutil.Process().exe()))
    (path / "work/login").write_text("raise SystemExit(0)\n")
    assert await login_chatgpt(path) == 0
    state = await profile_status(path)
    assert state["operation"] == "login"
    assert state["state"] == "closed"
    assert state["returncode"] == 0
    assert not state["locked"]

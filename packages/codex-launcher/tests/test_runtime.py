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
from pdum.codex_launcher.errors import LaunchError, OwnershipUncertain, ProfileError
from pdum.codex_launcher.runtime import dispose_profile, mutation_lock, open_file_holders
from websockets.asyncio.client import connect

CODEX = shutil.which("codex")
requires_codex = pytest.mark.skipif(CODEX is None, reason="Native Codex executable is not installed")


def _run(status: dict, run_id: str) -> dict:
    return next(run for run in status["runs"] if run["run_id"] == run_id)


def _write_run(path, run_id: str, record: dict) -> None:
    directory = path / ".pdum/runtime/runs" / run_id
    directory.mkdir(parents=True)
    (directory / "owner.json").write_text(json.dumps({"run_id": run_id, **record}))


async def test_mutation_lock_serializes_launcher_mutations_and_aliases(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=sys.executable))
    alias = tmp_path / "alias"
    alias.symlink_to(path, target_is_directory=True)
    async with mutation_lock(path):
        with pytest.raises(ProfileBusy):
            async with mutation_lock(alias):
                pass
        with pytest.raises(ProfileBusy):
            await configure_api_key(path, "DUMMY_ENVIRONMENT_NAME")
    async with mutation_lock(alias):
        pass


async def test_bare_home_is_a_profile_and_status_lists_runs(tmp_path):
    home = tmp_path / "bare-home"
    home.mkdir()
    status = await profile_status(home)
    assert status == {"profile": str(home.resolve()), "runs": [], "live_runs": []}
    with pytest.raises(ProfileError, match="does not exist"):
        await profile_status(tmp_path / "missing")
    legacy = tmp_path / "legacy"
    (legacy / "codex").mkdir(parents=True)
    (legacy / "launcher.toml").write_text("schema_version = 1\n")
    with pytest.raises(ProfileError, match="Legacy wrapper layout"):
        await profile_status(legacy)


async def test_stale_or_wrong_identity_cannot_be_blindly_killed(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=sys.executable))
    wrong = {"pid": os.getpid(), "uid": os.getuid(), "create_time": 0}
    _write_run(path, "stale", {"server": wrong, "state": "ready", "started_at": 1})
    status = await profile_status(path)
    assert not _run(status, "stale")["server_alive"]
    assert status["live_runs"] == []
    assert _run(await stop_profile(path), "stale")["state"] == "ready"
    actual = {"pid": os.getpid(), "uid": os.getuid(), "create_time": psutil.Process().create_time()}
    _write_run(path, "reused", {"server": actual, "state": "ready", "started_at": 2, "backend_endpoint": "unix://x"})
    assert (await profile_status(path))["live_runs"] == ["reused"]
    with pytest.raises(OwnershipUncertain):
        await stop_profile(path)
    with pytest.raises(OwnershipUncertain):
        await stop_profile(path, run_id="reused")
    with pytest.raises(ProfileError, match="Unknown run"):
        await stop_profile(path, run_id="nope")


async def test_disposal_refuses_live_runs_and_open_files(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=sys.executable))
    actual = {"pid": os.getpid(), "uid": os.getuid(), "create_time": psutil.Process().create_time()}
    _write_run(path, "mine", {"server": actual, "state": "ready", "started_at": 1})
    with pytest.raises(ProfileBusy, match="live runs"):
        await dispose_profile(path)
    (path / ".pdum/runtime/runs/mine/owner.json").write_text(json.dumps({"run_id": "mine", "state": "closed"}))
    with (path / "sessions.log").open("w") as held:
        held.write("open")
        held.flush()
        holders = open_file_holders(path)
        assert any(holder["pid"] == os.getpid() and "sessions.log" in holder["paths"] for holder in holders)
        with pytest.raises(ProfileBusy, match="hold files"):
            await dispose_profile(path)
    await dispose_profile(path)
    assert not path.exists()


async def test_launch_options_render_native_overrides_without_editing_config():
    options = LaunchOptions(model="gpt-6-luna", config_overrides={"sandbox_mode": '"danger-full-access"'})
    assert options.native_arguments() == ["-c", 'model="gpt-6-luna"', "-c", 'sandbox_mode="danger-full-access"']
    with pytest.raises(ProfileError):
        LaunchOptions(config_overrides={"bad key": "1"}).native_arguments()
    with pytest.raises(ProfileError):
        LaunchOptions(model=" ").native_arguments()


@pytest.mark.codex
@requires_codex
async def test_actual_codex_readiness_isolated_account_and_shutdown(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=CODEX))
    options = LaunchOptions(host="127.0.0.1", model="gpt-6-luna")
    async with launch(path, options) as server:
        pid = server.pid
        status = await profile_status(path)
        run = _run(status, server.run_id)
        assert run["server_alive"] and run["state"] == "ready"
        assert run["arguments"][-2:] == ["-c", 'model="gpt-6-luna"']
        assert status["live_runs"] == [server.run_id]
        assert "model" not in (path / "config.toml").read_text()
        assert (run["cwd"]) == str(path / ".pdum/work")
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
        assert stopped["live_runs"] == []
        assert await server.wait() is not None
    assert not psutil.pid_exists(pid)
    assert (await stop_profile(path))["live_runs"] == []


@pytest.mark.codex
@requires_codex
async def test_two_servers_share_one_profile_and_stop_individually(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=CODEX))
    async with launch(path, LaunchOptions(relay=False)) as first, launch(path, LaunchOptions(relay=False)) as second:
        assert first.pid != second.pid
        status = await profile_status(path)
        assert sorted(status["live_runs"]) == sorted([first.run_id, second.run_id])
        stopped = await stop_profile(path, run_id=first.run_id)
        assert stopped["live_runs"] == [second.run_id]
        assert await first.wait() is not None
        assert psutil.pid_exists(second.pid)
    assert (await profile_status(path))["live_runs"] == []


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
    assert (await profile_status(path))["live_runs"] == []


@pytest.mark.codex
@requires_codex
async def test_native_child_survives_owner_sigkill_and_is_recovered_by_run(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=CODEX))
    program = (
        "import asyncio,sys\n"
        "from pathlib import Path\n"
        "from pdum.codex_launcher import launch,LaunchOptions\n"
        "async def main():\n"
        " async with launch(Path(sys.argv[1]),LaunchOptions(relay=False)) as server:\n"
        "  print(server.pid,server.run_id,flush=True)\n"
        "  await asyncio.Event().wait()\n"
        "asyncio.run(main())\n"
    )
    owner = await asyncio.create_subprocess_exec(
        sys.executable, "-c", program, str(path), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    server_pid = None
    try:
        async with asyncio.timeout(20):
            server_pid, run_id = (await owner.stdout.readline()).decode().split()
            server_pid = int(server_pid)
        owner.kill()
        await owner.wait()
        assert psutil.pid_exists(server_pid)
        orphan = _run(await profile_status(path), run_id)
        assert orphan["server_alive"] and not orphan["owner_alive"]
        async with launch(path, LaunchOptions(relay=False)) as sibling:
            assert sorted((await profile_status(path))["live_runs"]) == sorted([run_id, sibling.run_id])
            recovered = _run(await stop_profile(path, timeout=3, run_id=run_id), run_id)
            assert not recovered["live"]
            assert recovered["state"] == "closed"
            assert recovered["recovered"]
            assert not psutil.pid_exists(server_pid)
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()
        if server_pid and psutil.pid_exists(server_pid):
            try:
                os.killpg(server_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


async def test_failed_native_start_records_closed_run(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=sys.executable))
    with pytest.raises(LaunchError):
        async with launch(path, LaunchOptions(relay=False, startup_timeout=2)):
            pass
    status = await profile_status(path)
    assert status["live_runs"] == []
    assert [run["state"] for run in status["runs"]] == ["closed"]


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
                status = await profile_status(path)
                ready = [run for run in status["runs"] if run.get("state") == "ready"]
                if ready:
                    break
                if owner.returncode is not None:
                    raise AssertionError(f"Launcher CLI exited early: {owner.returncode}")
                await asyncio.sleep(0.05)
        server_pid = ready[0]["server"]["pid"]
        owner.terminate()
        async with asyncio.timeout(20):
            await owner.communicate()
        assert owner.returncode == 143
        assert not psutil.pid_exists(server_pid)
        assert (await profile_status(path))["live_runs"] == []
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()


async def test_orphaned_login_holds_mutation_lock_and_requires_verified_command_for_cleanup(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=psutil.Process().exe()))
    (path / ".pdum/work/login").write_text("import time\ntime.sleep(120)\n")
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
                runs = (await profile_status(path))["runs"]
                authenticating = [run for run in runs if run.get("state") == "authenticating"]
                if authenticating:
                    state = authenticating[0]
                    break
                if owner.returncode is not None:
                    raise AssertionError(f"Login owner exited early: {owner.returncode}")
                await asyncio.sleep(0.05)
        child_pid = state["server"]["pid"]
        assert state["operation"] == "login"
        with pytest.raises(ProfileBusy):
            async with mutation_lock(path):
                pass
        owner.kill()
        await owner.wait()
        assert psutil.pid_exists(child_pid)
        journal = path / ".pdum/runtime/runs" / state["run_id"] / "owner.json"
        original = journal.read_text()
        wrong = json.loads(original)
        wrong["process_command"] = ["a-different-command", "login"]
        journal.write_text(json.dumps(wrong))
        with pytest.raises(OwnershipUncertain, match="login command"):
            await stop_profile(path, timeout=2)
        assert psutil.pid_exists(child_pid)
        journal.write_text(original)
        stopped = _run(await stop_profile(path, timeout=2), state["run_id"])
        assert stopped["state"] == "closed"
        assert stopped["operation"] == "login"
        assert stopped["recovered"]
        assert not stopped["server_alive"]
        assert (await profile_status(path))["live_runs"] == []
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()
        if child_pid and psutil.pid_exists(child_pid):
            try:
                os.killpg(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


async def test_successful_local_login_process_finalizes_run_record(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=psutil.Process().exe()))
    (path / ".pdum/work/login").write_text("raise SystemExit(0)\n")
    assert await login_chatgpt(path) == 0
    status = await profile_status(path)
    (run,) = status["runs"]
    assert run["operation"] == "login"
    assert run["state"] == "closed"
    assert run["returncode"] == 0
    assert status["live_runs"] == []

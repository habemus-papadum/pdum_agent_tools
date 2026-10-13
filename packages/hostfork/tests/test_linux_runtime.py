"""Real prepared-host qualification of ownership, mounts and failure recovery."""

import asyncio
import json
import os
import signal
import sys
import time
import uuid
from pathlib import Path

import pytest

if sys.platform != "linux":
    pytest.skip("Linux execution backend", allow_module_level=True)

from pdum.hostfork.backends.linux import LinuxRuntime
from pdum.hostfork.backends.linux._syscalls import alive, cgroup_path, identity, populated, signal_identity

pytestmark = pytest.mark.hostfork_linux


@pytest.fixture(autouse=True)
def helper_coverage(request, monkeypatch):
    """Measure the same real helper syscalls when pytest-cov is active."""
    plugin = request.config.pluginmanager.get_plugin("_cov")
    controller = getattr(plugin, "cov_controller", None)
    if controller is None or getattr(controller, "cov", None) is None:
        return
    from pdum.hostfork.backends.linux import runtime as implementation

    wrapper = Path(__file__).parent / "fixtures" / "coverage_helper.py"
    monkeypatch.setenv("PDUM_HOSTFORK_TEST_REAL_HELPER", str(implementation._HELPER))
    monkeypatch.setenv("PDUM_HOSTFORK_TEST_COVERAGE_FILE", str(Path(controller.cov.config.data_file).resolve()))
    monkeypatch.setenv("PDUM_HOSTFORK_TEST_COVERAGE_BRANCH", "1" if controller.cov.config.branch else "0")
    monkeypatch.setenv("PDUM_HOSTFORK_TEST_HELPER_WRAPPER", str(wrapper))
    monkeypatch.setattr(implementation, "_HELPER", wrapper)


@pytest.fixture
async def runtime_factory(tmp_path):
    if sys.platform != "linux" or not Path(f"/run/user/{os.getuid()}/bus").exists():
        if os.environ.get("PDUM_HOSTFORK_REQUIRE_LINUX") == "1":
            pytest.fail("Prepared Linux host required but unavailable")
        pytest.skip("Requires prepared Linux user namespaces and systemd user manager")
    runtimes = []

    async def create(mounts=None, **kwargs):
        root = tmp_path / uuid.uuid4().hex
        runtime = await LinuxRuntime.create(
            uuid.uuid4().hex, root, mounts or [], max_runtime=kwargs.pop("max_runtime", 20), **kwargs
        )
        runtimes.append(runtime)
        return runtime

    try:
        try:
            probe = await create()
            await probe.stop()
        except (OSError, RuntimeError) as error:
            if os.environ.get("PDUM_HOSTFORK_REQUIRE_LINUX") == "1":
                raise
            pytest.skip(f"Linux runtime capability unavailable: {error}")
        yield create
    finally:
        for runtime in reversed(runtimes):
            result = await runtime.stop("test_cleanup")
            assert result["state"] == "stopped", result
            assert not alive(result.get("keeper_identity"))
            if result.get("cgroup"):
                assert not populated(cgroup_path(result["cgroup"]))


async def test_direct_process_and_reusable_view(runtime_factory, tmp_path):
    source, target = tmp_path / "source", tmp_path / "target"
    source.mkdir()
    target.mkdir()
    runtime = await runtime_factory([{"kind": "bind", "source": str(source), "target": str(target)}])
    original = Path("/proc/self/ns/mnt").readlink()
    command = await runtime.spawn(
        [
            sys.executable,
            "-c",
            "import os,pathlib; pathlib.Path('made').write_text('yes'); print(os.getpid(),os.getppid())",
        ],
        command_id="first",
        cwd=target,
        stdout=asyncio.subprocess.PIPE,
    )
    stdout, _ = await command.native_process.communicate()
    assert list(map(int, stdout.split())) == [command.native_process.pid, os.getpid()]
    assert command.native_process.returncode == 0
    assert (source / "made").read_text() == "yes"
    assert not (target / "made").exists()
    assert Path("/proc/self/ns/mnt").readlink() == original
    await command.wait_tree()
    verifier = await runtime.spawn(
        ["/bin/cat", str(target / "made")], command_id="second", stdout=asyncio.subprocess.PIPE
    )
    assert (await verifier.native_process.communicate())[0] == b"yes"


async def test_overlay_cwd_and_retained_upper(runtime_factory, tmp_path):
    project, upper, work = (tmp_path / x for x in ("project", "upper", "work"))
    for path in (project, upper, work):
        path.mkdir()
    (project / "original").write_text("host")
    runtime = await runtime_factory(
        [{"kind": "overlay", "source": str(project), "target": str(project), "upper": str(upper), "work": str(work)}]
    )
    command = await runtime.spawn(
        ["/bin/sh", "-c", "echo private > original; echo result > new"], command_id="write", cwd=project
    )
    assert await command.native_process.wait() == 0
    await runtime.stop()
    assert (project / "original").read_text() == "host"
    assert not (project / "new").exists()
    assert (upper / "new").read_text() == "result\n"
    # Storage owns work-directory deletion; make kernel scratch traversable for pytest.
    nested = work / "work"
    if nested.exists():
        nested.chmod(0o700)


async def test_read_only_and_fresh(runtime_factory, tmp_path):
    readonly, fresh = tmp_path / "readonly", tmp_path / "fresh"
    readonly.mkdir()
    fresh.mkdir()
    (fresh / "hidden").write_text("host")
    runtime = await runtime_factory(
        [
            {"kind": "read_only", "target": str(readonly)},
            {"kind": "fresh", "target": str(fresh)},
        ]
    )
    command = await runtime.spawn(
        [
            sys.executable,
            "-c",
            "import errno,pathlib,sys; p=pathlib.Path(sys.argv[1]); "
            "\ntry: (p/'new').write_text('bad')\nexcept OSError as e: assert e.errno==errno.EROFS\n"
            "else: raise AssertionError('writable')\nassert not pathlib.Path(sys.argv[2],'hidden').exists()",
            str(readonly),
            str(fresh),
        ],
        command_id="readonly",
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await command.native_process.communicate()
    assert command.native_process.returncode == 0, err
    assert not (readonly / "new").exists()


async def test_command_kill_includes_setsid_but_preserves_sidecar(runtime_factory, tmp_path):
    runtime = await runtime_factory()
    marker = tmp_path / "descendant.json"
    sidecar = await runtime.spawn(["/bin/sleep", "30"], command_id="sidecar")
    worker = await runtime.spawn(
        [
            sys.executable,
            "-c",
            "import subprocess,sys; subprocess.Popen([sys.executable,'-c',"
            "\"import os,json,pathlib,time; pathlib.Path(os.environ['MARKER'])"
            ".write_text(json.dumps({'pid':os.getpid()})); "
            'time.sleep(60)"], start_new_session=True); sys.exit(7)',
        ],
        command_id="worker",
        env={**os.environ, "MARKER": str(marker)},
    )
    assert await worker.native_process.wait() == 7
    for _ in range(200):
        if marker.exists():
            break
        await asyncio.sleep(0.01)
    descendant = identity(json.loads(marker.read_text())["pid"])
    waiter = asyncio.create_task(worker.wait_tree())
    await asyncio.sleep(0.05)
    assert not waiter.done()
    await worker.stop_tree()
    await waiter
    assert not alive(descendant)
    assert sidecar.native_process.returncode is None
    assert alive(runtime.record["keeper_identity"])


async def test_concurrent_commands(runtime_factory):
    runtime = await runtime_factory()
    commands = await asyncio.gather(
        *[
            runtime.spawn(["/bin/echo", str(index)], command_id=f"c{index}", stdout=asyncio.subprocess.PIPE)
            for index in range(12)
        ]
    )
    for index, command in enumerate(commands):
        assert (await command.native_process.communicate())[0] == f"{index}\n".encode()
        await command.wait_tree()


async def test_duplicate_command_does_not_corrupt_or_stop_original(runtime_factory):
    runtime = await runtime_factory()
    original = await runtime.spawn(["/bin/sleep", "30"], command_id="same")
    with pytest.raises(FileExistsError):
        await runtime.spawn(["/bin/false"], command_id="same")
    saved = json.loads(runtime._command_file("same").read_text())
    assert saved["identity"] == original.identity
    assert original.native_process.returncode is None


async def test_deadline_kills_frozen_keeper_and_payload(runtime_factory):
    runtime = await runtime_factory(max_runtime=1.2, grace_seconds=0.15)
    command = await runtime.spawn(["/bin/sleep", "30"], command_id="frozen")
    signal_identity(runtime.record["keeper_identity"], signal.SIGSTOP)
    signal_identity(command.identity, signal.SIGSTOP)
    # systemd sends SIGCONT as part of graceful termination of stopped tasks.
    assert await asyncio.wait_for(command.native_process.wait(), 4) in (-signal.SIGKILL, -signal.SIGTERM)
    result = await runtime.stop()
    assert result["final_manager"]["Result"] == "timeout"
    assert time.monotonic() - result["deadline_monotonic"] < 1


async def test_reopen_detach_and_idempotent_stop(runtime_factory):
    runtime = await runtime_factory()
    command = await runtime.spawn(["/bin/sleep", "30"], command_id="detached")
    deadline = runtime.record["deadline_monotonic"]
    await runtime.detach()
    reopened = await LinuxRuntime.reopen(runtime.state_dir)
    try:
        assert (await reopened.inspect())["keeper_alive"]
        second = await reopened.spawn(["/bin/true"], command_id="later")
        assert await second.native_process.wait() == 0
        assert reopened.record["deadline_monotonic"] == deadline
        result = await reopened.stop()
        assert result["state"] == "stopped"
        assert await command.native_process.wait() < 0
        assert (await reopened.stop())["state"] == "stopped"
    finally:
        await reopened.stop()


@pytest.mark.parametrize("mode", ["detach_exit", "retain_exit"])
async def test_retained_keeper_survives_normal_event_loop_shutdown(runtime_factory, tmp_path, mode):
    state = tmp_path / mode
    owner = await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).parent / "fixtures" / "runtime_owner.py"),
        str(state),
        uuid.uuid4().hex,
        mode,
        "10",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    reopened = None
    try:
        stdout, stderr = await asyncio.wait_for(owner.communicate(), 5)
        assert owner.returncode == 0, stderr.decode()
        ready = json.loads(stdout)
        reopened = await LinuxRuntime.reopen(state)
        assert (await reopened.inspect())["keeper_alive"]
        assert reopened.record["deadline_monotonic"] == ready["deadline"]
        command = await reopened.spawn(["/bin/true"], command_id="after-owner-exit")
        assert isinstance(command.native_process, asyncio.subprocess.Process)
        assert await command.native_process.wait() == 0
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()
        if (state / "runtime.json").exists():
            reopened = reopened or await LinuxRuntime.reopen(state)
            assert (await reopened.stop())["state"] == "stopped"


async def test_cancel_after_registration_prevents_application(runtime_factory, monkeypatch, tmp_path):
    runtime = await runtime_factory()
    registered = asyncio.Event()
    original = runtime.manager.start

    async def blocked(unit, *args, **kwargs):
        result = await original(unit, *args, **kwargs)
        registered.set()
        await asyncio.Event().wait()
        return result

    monkeypatch.setattr(runtime.manager, "start", blocked)
    marker = tmp_path / "must-not-exist"
    launch = asyncio.create_task(runtime.spawn(["/usr/bin/touch", str(marker)], command_id="cancelled"))
    await registered.wait()
    launch.cancel()
    with pytest.raises(asyncio.CancelledError):
        await launch
    state = await runtime.inspect()
    assert not state["commands"][0]["populated"]
    assert not alive(state["commands"][0]["identity"])
    assert not marker.exists()


async def test_stop_fences_concurrent_launches(runtime_factory, tmp_path):
    runtime = await runtime_factory()
    launches = [asyncio.create_task(runtime.spawn(["/bin/sleep", "30"], command_id=f"race{i}")) for i in range(15)]
    await asyncio.sleep(0.01)
    result = await runtime.stop()
    await asyncio.gather(*launches, return_exceptions=True)
    assert result["state"] == "stopped", result
    assert not populated(cgroup_path(runtime.record["cgroup"]))
    with pytest.raises(RuntimeError, match="closed"):
        await runtime.spawn(["/bin/true"], command_id="after")


async def test_setup_failure_cleans_resources(runtime_factory, tmp_path):
    with pytest.raises(RuntimeError, match="must already exist"):
        await runtime_factory([{"kind": "bind", "source": str(tmp_path), "target": str(tmp_path / "absent")}])


async def test_keeper_loss_stops_payload(runtime_factory):
    runtime = await runtime_factory()
    command = await runtime.spawn(["/bin/sleep", "30"], command_id="worker")
    signal_identity(runtime.record["keeper_identity"])
    assert await asyncio.wait_for(command.native_process.wait(), 3) < 0
    await runtime._keeper_watch
    assert runtime.record["stop_reason"] == "keeper_lost"


async def test_limits_and_real_oom(runtime_factory):
    runtime = await runtime_factory(memory_bytes=70 * 1024**2, cpu_cores=0.5)
    state = await runtime.inspect()
    assert state["manager"]["MemoryMax"] == 70 * 1024**2
    assert state["manager"]["CPUQuotaPerSecUSec"] == 500000
    command = await runtime.spawn(
        [
            sys.executable,
            "-c",
            "import time; blocks=[]\nwhile True: blocks.append(bytearray(8*1024*1024)); time.sleep(.01)",
        ],
        command_id="oom",
    )
    assert await asyncio.wait_for(command.native_process.wait(), 8) == -signal.SIGKILL
    result = await runtime.stop()
    assert result["final_manager"]["Result"] == "oom-kill", result


@pytest.mark.parametrize("mode", ["stop", "detach", "freeze", "gate"])
async def test_external_owner_failure_recovery(runtime_factory, tmp_path, mode):
    # runtime_factory probes prerequisites and owns ordinary in-process resources.
    state = tmp_path / ("external-" + mode)
    owner = await asyncio.create_subprocess_exec(
        sys.executable,
        str(Path(__file__).parent / "fixtures" / "runtime_owner.py"),
        str(state),
        uuid.uuid4().hex,
        mode,
        "1.5" if mode in ("freeze", "gate") else "10",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    owner_identity = identity(owner.pid)
    reopened = None
    try:
        ready = await asyncio.wait_for(owner.stdout.readline(), 5)
        assert ready, (await owner.stderr.read()).decode()
        reopened = await LinuxRuntime.reopen(state)
        before = await reopened.inspect()
        expected = before["commands"][0]["identity"]
        if mode in ("freeze", "gate"):
            signal_identity(owner_identity, signal.SIGSTOP)
        else:
            signal_identity(owner_identity)
            await owner.wait()
        if mode == "detach":
            await asyncio.sleep(0.15)
            assert alive(expected)
            assert (await reopened.inspect())["keeper_alive"]
            assert (await reopened.stop())["state"] == "stopped"
        else:
            until = time.monotonic() + 4
            while (alive(expected) or alive(before["keeper_identity"])) and time.monotonic() < until:
                await asyncio.sleep(0.02)
            assert not alive(expected)
            assert not alive(before["keeper_identity"])
            result = await reopened.stop()
            if mode == "gate":
                assert result["state"] == "cleanup_pending"
                assert any("in-flight" in item for item in result["cleanup_errors"])
            else:
                assert result["state"] == "stopped", result
        signal_identity(owner_identity)
        await owner.wait()
        assert (await reopened.stop())["state"] == "stopped"
    finally:
        signal_identity(owner_identity)
        await owner.wait()
        if reopened:
            await reopened.stop()


async def test_kernel_setup_timer_kills_frozen_unadopted_gate(runtime_factory, monkeypatch):
    import pdum.hostfork.backends.linux.runtime as implementation

    runtime = await runtime_factory()
    monkeypatch.setattr(implementation, "_SETUP_SECONDS", 1.0)
    ready = asyncio.Event()

    async def never_adopt(*args, **kwargs):
        ready.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(runtime.manager, "start", never_adopt)
    launch = asyncio.create_task(runtime.spawn(["/bin/sleep", "60"], command_id="unadopted"))
    await ready.wait()
    expected = json.loads(runtime._command_file("unadopted").read_text())["identity"]
    signal_identity(expected, signal.SIGSTOP)
    until = time.monotonic() + 2
    while alive(expected) and time.monotonic() < until:
        await asyncio.sleep(0.01)
    assert not alive(expected)
    launch.cancel()
    with pytest.raises(asyncio.CancelledError):
        await launch


async def test_colliding_environment_unit_is_never_stopped(runtime_factory, tmp_path):
    runtime = await runtime_factory()
    command = await runtime.spawn(["/bin/sleep", "30"], command_id="original")
    with pytest.raises(RuntimeError, match="UnitExists"):
        await LinuxRuntime.create(runtime.record["id"], tmp_path / "collision", [], max_runtime=5)
    assert alive(runtime.record["keeper_identity"])
    assert command.native_process.returncode is None
    collision = json.loads((tmp_path / "collision" / "runtime.json").read_text())
    assert not alive(collision["keeper_identity"])


async def test_stop_keeps_manager_evidence_on_repeated_reopen(runtime_factory):
    runtime = await runtime_factory()
    await runtime.stop()
    original = runtime.record["final_manager"]
    reopened = await LinuxRuntime.reopen(runtime.state_dir)
    second = await reopened.stop()
    assert second["final_manager"] == original
    assert original["Result"] == "success"


async def test_two_reapers_and_per_command_cleanup(runtime_factory):
    runtime = await runtime_factory()
    await runtime.spawn(["/bin/sleep", "30"], command_id="work")
    first, second = await LinuxRuntime.reopen(runtime.state_dir), await LinuxRuntime.reopen(runtime.state_dir)
    results = await asyncio.gather(first.stop(), second.stop())
    assert all(result["state"] == "stopped" for result in results)
    assert not populated(cgroup_path(runtime.record["cgroup"]))


async def test_concurrent_environment_activation(runtime_factory):
    runtimes = await asyncio.gather(*(runtime_factory() for _ in range(10)))
    commands = await asyncio.gather(*(runtime.spawn(["/bin/true"], command_id="check") for runtime in runtimes))
    assert await asyncio.gather(*(command.native_process.wait() for command in commands)) == [0] * 10
    assert all(runtime.record["activated_monotonic"] > 0 for runtime in runtimes)


async def test_recursive_read_only_includes_nested_bind(runtime_factory, tmp_path):
    target, source = tmp_path / "target", tmp_path / "source"
    (target / "nested").mkdir(parents=True)
    source.mkdir()
    runtime = await runtime_factory(
        [
            {"kind": "bind", "source": str(source), "target": str(target / "nested")},
            {"kind": "read_only", "target": str(target)},
        ]
    )
    command = await runtime.spawn(
        [
            sys.executable,
            "-c",
            "import pathlib,errno,sys\n"
            "try:pathlib.Path(sys.argv[1]).write_text('bad')\n"
            "except OSError as e:assert e.errno==errno.EROFS\n"
            "else:raise AssertionError('nested mount remained writable')",
            str(target / "nested" / "file"),
        ],
        command_id="nested",
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await command.native_process.communicate()
    assert command.native_process.returncode == 0, err
    assert not (source / "file").exists()


async def test_nested_shared_directory_keeps_original_host_inode_and_socket(runtime_factory, tmp_path):
    import shutil

    project = tmp_path / "project"
    shared = project / "shared"
    shared.mkdir(parents=True)
    (project / "private").write_text("host")
    (shared / "data").write_text("old")
    private = tmp_path / "private-copy"
    shutil.copytree(project, private)

    async def respond(reader, writer):
        writer.write(await reader.readexactly(4))
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    endpoint = shared / "service.sock"
    server = await asyncio.start_unix_server(respond, path=str(endpoint))
    try:
        runtime = await runtime_factory(
            [
                {"kind": "bind", "source": str(private), "target": str(project)},
                {"kind": "bind", "source": str(shared), "target": str(shared)},
            ]
        )
        command = await runtime.spawn(
            [
                sys.executable,
                "-c",
                "import pathlib,socket,sys; p=pathlib.Path(sys.argv[1]); "
                "(p/'private').write_text('private'); (p/'shared'/'data').write_text('shared'); "
                "s=socket.socket(socket.AF_UNIX); s.connect(str(p/'shared'/'service.sock')); "
                "s.sendall(b'ping'); assert s.recv(4)==b'ping'",
                str(project),
            ],
            command_id="shared",
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await command.native_process.communicate()
        assert command.native_process.returncode == 0, err
        assert (project / "private").read_text() == "host"
        assert (private / "private").read_text() == "private"
        assert (shared / "data").read_text() == "shared"
        assert (private / "shared" / "data").read_text() == "old"
    finally:
        server.close()
        await server.wait_closed()


async def test_unreadable_runtime_and_command_journals_do_not_prevent_stop(runtime_factory, monkeypatch):
    from pdum.hostfork.backends.linux import runtime as implementation

    runtime = await runtime_factory()
    command = await runtime.spawn(["/bin/sleep", "30"], command_id="owned")
    read = implementation._read

    def unreadable(path, default=None):
        if path.name in ("runtime.json", "command.json"):
            raise PermissionError("injected unavailable journal")
        return read(path, default)

    with monkeypatch.context() as patch:
        patch.setattr(implementation, "_read", unreadable)
        result = await runtime.stop()
        assert result["state"] == "cleanup_pending"
        assert any("journal unreadable" in item for item in result["cleanup_errors"])
        assert not alive(command.identity)
        assert not alive(runtime.record["keeper_identity"])
    assert (await runtime.stop())["state"] == "stopped"


async def test_closed_manager_does_not_wait_for_cyclic_gc_to_release_fds(runtime_factory):
    import gc

    # Keep runtime objects alive and disable collection so delayed socket closure
    # cannot conceal a per-environment descriptor leak.
    gc.collect()
    baseline = len(list(Path("/proc/self/fd").iterdir()))
    gc.disable()
    try:
        for _ in range(5):
            runtime = await runtime_factory()
            await runtime.stop()
        assert len(list(Path("/proc/self/fd").iterdir())) == baseline
    finally:
        gc.enable()

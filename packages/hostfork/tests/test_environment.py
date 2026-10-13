"""Real public lifecycle tests, including recovery through another controller."""

import asyncio
import os
import sys
from pathlib import Path

import pytest
from pdum.hostfork import (
    EnvironmentClosed,
    EnvironmentSpec,
    Hostfork,
    HostView,
    Lifetime,
    PrivateTree,
    Retention,
    WorkspaceView,
)
from pdum.hostfork.doctor import doctor


@pytest.fixture
async def capable():
    result = await doctor(probe=True)
    capabilities = result["capabilities"]
    if not capabilities["namespace"]["available"] or not capabilities["systemd"]["available"]:
        if os.environ.get("PDUM_HOSTFORK_REQUIRE_LINUX"):
            pytest.fail(str(result))
        pytest.skip("requires usable Linux namespaces and user systemd; see doctor --probe")


pytestmark = [pytest.mark.asyncio, pytest.mark.hostfork_linux]


async def test_public_multiple_commands_export_and_gc(tmp_path, capable):
    source = tmp_path / "source"
    source.mkdir()
    (source / "original").write_text("baseline")
    host = Hostfork(tmp_path / "state")
    spec = EnvironmentSpec(
        trees={"work": PrivateTree(source)},
        view=HostView(replace={str(source): "work"}),
        lifetime=Lifetime(max_runtime=20),
    )
    environment = await host.create(spec)
    try:
        command = await environment.spawn(
            [
                sys.executable,
                "-c",
                "import os,pathlib;print(os.getpid(),os.getppid());pathlib.Path('new').write_text('private')",
            ],
            cwd=source,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        output, error = await command.communicate()
        assert error == b""
        assert output.decode().split() == [str(command.pid), str(os.getpid())]
        assert command.native_process.returncode == 0
        assert (await command.wait()).exit_observed
        assert not (source / "new").exists()
        second = await environment.spawn(["/bin/sh", "-c", "echo durable; exit 7"])
        result = await second.wait()
        assert result.returncode == 7
        assert Path(result.stdout_path).read_text() == "durable\n"
        await second.wait_tree()
    finally:
        stopped = await environment.stop()
    assert stopped["state"] == "stopped"
    export = await environment.export("work", tmp_path / "export")
    assert export["state"] == "complete"
    assert (tmp_path / "export" / "new").read_text() == "private"
    assert (await host.usage())["retained_trees"] == 1
    reopened = await Hostfork(host.store.root).open(environment.id)
    assert (await reopened.status())["commands"][1]["returncode"] == 7
    assert (await host.gc(environment.id))[0]["released"] == []
    collected = await host.gc(environment.id, force=True)
    assert collected[0]["state"] == "purged", collected
    assert not environment.evidence_path.exists()
    assert (source / "original").read_text() == "baseline"
    assert (tmp_path / "export" / "new").exists()


async def test_workspace_context_and_detach(tmp_path, capable):
    host = Hostfork(tmp_path / "state")
    spec = EnvironmentSpec(
        trees={"work": PrivateTree(storage="empty")}, view=WorkspaceView("work"), lifetime=Lifetime(max_runtime=10)
    )
    async with await host.create(spec) as environment:
        process = await environment.spawn(["/bin/pwd"], stdout=asyncio.subprocess.PIPE)
        stdout, _ = await process.communicate()
        assert stdout.decode().strip() == str(environment.paths["work"])
        with pytest.raises(EnvironmentClosed):
            await environment.export("work", tmp_path / "premature")
    assert host.store.environment(environment.id)["state"] == "stopped"
    with pytest.raises(EnvironmentClosed):
        await environment.spawn(["true"])
    persistent = await host.create(EnvironmentSpec(lifetime=Lifetime(max_runtime=2)))
    await persistent.detach()
    reopened = await Hostfork(host.store.root).open(persistent.id)
    child = await reopened.spawn(["/bin/echo", "reopened"], stdout=asyncio.subprocess.PIPE)
    assert (await child.communicate())[0] == b"reopened\n"
    await asyncio.sleep(2)
    result = await host.reap(persistent.id)
    assert result[0]["state"] == "stopped", result


async def test_overlay_export_after_namespace_exit(tmp_path, capable):
    source = tmp_path / "source"
    source.mkdir()
    (source / "deleted").write_text("original")
    host = Hostfork(tmp_path / "state")
    environment = await host.create(
        EnvironmentSpec(
            trees={"work": PrivateTree(source, storage="overlay", stable=True)},
            view=HostView(replace={str(source): "work"}),
            lifetime=Lifetime(max_runtime=10),
        )
    )
    try:
        command = await environment.spawn(["/bin/sh", "-c", "rm deleted; echo addition > added"], cwd=source)
        assert (await command.wait()).returncode == 0
    finally:
        await environment.stop()
    result = await environment.export("work", tmp_path / "export")
    assert result["state"] == "complete", result
    assert not (tmp_path / "export" / "deleted").exists()
    assert (tmp_path / "export" / "added").read_text() == "addition\n"
    assert (source / "deleted").exists()
    assert not (await host.gc(environment.id, force=True))[0]["pending"]


async def test_retention_and_application_error(tmp_path, capable):
    host = Hostfork(tmp_path / "state")
    environment = await host.create(EnvironmentSpec(lifetime=Lifetime(max_runtime=10), retention=Retention(0, 0)))
    command = await environment.spawn(["/bin/sh", "-c", "exit 19"])
    assert (await command.wait()).returncode == 19
    await environment.stop()
    assert (await host.reap(environment.id))[0]["gc"]["state"] == "purged"


async def test_failed_setup_is_recoverable(tmp_path, capable):
    host = Hostfork(tmp_path / "state")
    source = tmp_path / "source"
    target = source / "nested"
    target.mkdir(parents=True)
    # The nested target exists in host view but is absent after replacement.
    spec = EnvironmentSpec(
        trees={"empty": PrivateTree(storage="empty")},
        view=HostView(replace={str(source): "empty"}, read_only=(str(target),)),
        lifetime=Lifetime(max_runtime=10),
    )
    with pytest.raises(RuntimeError):
        await host.create(spec)
    record = (await host.list())[0]
    assert record["state"] == "setup_failed"
    result = await host.reap(record["id"])
    assert result[0]["state"] == "stopped", result
    assert not (await host.gc(record["id"], force=True))[0]["pending"]


async def test_reaper_does_not_stop_live_activation(tmp_path, capable, monkeypatch):
    from pdum.hostfork.backends.linux import LinuxRuntime

    entered, resume = asyncio.Event(), asyncio.Event()
    original = LinuxRuntime._create

    async def paused(self, *args):
        entered.set()
        await resume.wait()
        return await original(self, *args)

    monkeypatch.setattr(LinuxRuntime, "_create", paused)
    host = Hostfork(tmp_path / "state")
    task = asyncio.create_task(host.create(EnvironmentSpec(lifetime=Lifetime(max_runtime=10))))
    await entered.wait()
    try:
        record = host.store.environments()[0]
        result = await Hostfork(host.store.root).reap(record["id"])
        assert result[0]["state"] == "creating", result
        assert not host.store.environment(record["id"])["stop_requested_at"]
    finally:
        resume.set()
    environment = await task
    await environment.stop()


async def test_stop_during_activation_and_log_allocation_failure(tmp_path, capable, monkeypatch):
    from pdum.hostfork.backends.linux import LinuxRuntime

    entered, resume = asyncio.Event(), asyncio.Event()
    original = LinuxRuntime._create

    async def paused(self, *args):
        entered.set()
        await resume.wait()
        return await original(self, *args)

    monkeypatch.setattr(LinuxRuntime, "_create", paused)
    host = Hostfork(tmp_path / "state")
    task = asyncio.create_task(host.create(EnvironmentSpec(lifetime=Lifetime(max_runtime=10))))
    await entered.wait()
    record = host.store.environments()[0]
    await (await Hostfork(host.store.root).open(record["id"])).stop()
    resume.set()
    with pytest.raises((RuntimeError, OSError, EnvironmentClosed)):
        await task
    await host.reap(record["id"])
    assert host.store.environment(record["id"])["state"] == "stopped"
    monkeypatch.setattr(LinuxRuntime, "_create", original)
    environment = await host.create(EnvironmentSpec(lifetime=Lifetime(max_runtime=10)))
    original_open = Path.open

    def full_disk(path, *args, **kwargs):
        if path.name.endswith(".stderr.log"):
            raise OSError(28, "Injected log disk full")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", full_disk)
    try:
        with pytest.raises(OSError, match="disk full"):
            await environment.spawn(["/bin/true"])
        command = host.store.commands(environment.id)[0]
        assert command["state"] == "launch_failed"
        assert "disk full" in command["error"]
    finally:
        await environment.stop()


async def test_managed_export_retained_with_evidence(tmp_path, capable):
    host = Hostfork(tmp_path / "state")
    environment = await host.create(
        EnvironmentSpec(
            trees={"work": PrivateTree(storage="empty")},
            view=WorkspaceView("work"),
            lifetime=Lifetime(max_runtime=10),
            retention=Retention(trees=0),
        )
    )
    command = await environment.spawn(["/bin/sh", "-c", "echo evidence > note"])
    await command.wait()
    await environment.stop()
    exported = await environment.export("work")
    destination = Path(exported["path"])
    assert exported["managed"] and destination.is_relative_to(environment.evidence_path)
    assert (destination / "note").read_text() == "evidence\n"
    await host.gc(environment.id)
    assert destination.exists()
    await host.gc(environment.id, force=True)
    assert not destination.exists()
    assert (await environment.stop())["state"] == "purged"


async def test_registry_read_failure_cannot_prevent_owned_stop(tmp_path, capable, monkeypatch):
    host = Hostfork(tmp_path / "state")
    environment = await host.create(EnvironmentSpec(lifetime=Lifetime(max_runtime=10)))
    command = await environment.spawn(["/bin/sleep", "30"])
    original = host.store.environment

    def broken_registry(*_args):
        raise OSError("Injected registry unavailable")

    monkeypatch.setattr(host.store, "environment", broken_registry)
    try:
        with pytest.raises(OSError, match="registry unavailable"):
            await environment.stop()
        assert not (await environment._runtime.inspect())["keeper_alive"]
        await asyncio.wait_for(command.native_process.wait(), 2)
    finally:
        monkeypatch.setattr(host.store, "environment", original)
        await environment.stop()


async def test_cli_real_foreground_detach_exec_export_gc(tmp_path, capable):
    import json

    state = tmp_path / "state"

    async def cli(*args):
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "pdum.hostfork",
            "--root",
            str(state),
            "--json",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
        assert process.returncode == 0, (stdout.decode(), stderr.decode())
        return stdout.decode()

    assert await cli("run", "--ttl", "10", "--", "/bin/echo", "foreground") == "foreground\n"
    spec = EnvironmentSpec(
        trees={"work": PrivateTree(storage="empty")}, view=WorkspaceView("work"), lifetime=Lifetime(max_runtime=10)
    )
    path = tmp_path / "spec.json"
    path.write_text(json.dumps(spec.to_dict()))
    created = json.loads(await cli("create", "--spec", str(path)))
    environment_id = created["id"]
    try:
        assert (
            await cli("exec", environment_id, "--", "/bin/sh", "-c", "echo artifact > file; echo detached")
            == "detached\n"
        )
        assert json.loads(await cli("status", environment_id))["detached"]
    finally:
        await cli("stop", environment_id)
    exported = json.loads(await cli("export", environment_id, "work"))
    assert exported["managed"] and Path(exported["path"], "file").read_text() == "artifact\n"
    assert json.loads(await cli("gc", "--environment", environment_id, "--force"))[0]["state"] == "purged"


async def test_real_aggregate_cpu_quota(tmp_path, capable):
    from pdum.hostfork import Limits
    from pdum.hostfork.backends.linux._syscalls import cgroup_path

    host = Hostfork(tmp_path / "state")
    async with await host.create(
        EnvironmentSpec(limits=Limits(cpu_cores=0.25), lifetime=Lifetime(max_runtime=15))
    ) as environment:
        group = cgroup_path(environment._runtime.record["cgroup"])
        before = dict(line.split() for line in (group / "cpu.stat").read_text().splitlines())
        work = "import time; end=time.monotonic()+1.5\nwhile time.monotonic()<end: pass"
        code = (
            "import subprocess,sys; "
            "ps=[subprocess.Popen([sys.executable,'-c',sys.argv[1]]) for _ in range(2)]; [p.wait() for p in ps]"
        )
        started = asyncio.get_running_loop().time()
        command = await environment.spawn([sys.executable, "-c", code, work])
        assert (await command.wait()).returncode == 0
        await command.wait_tree()
        elapsed = asyncio.get_running_loop().time() - started
        after = dict(line.split() for line in (group / "cpu.stat").read_text().splitlines())
        assert int(after["nr_throttled"]) > int(before["nr_throttled"])
        used = (int(after["usage_usec"]) - int(before["usage_usec"])) / 1_000_000
        assert used / elapsed < 0.65  # generous timing tolerance; two unbounded workers use ~2 cores

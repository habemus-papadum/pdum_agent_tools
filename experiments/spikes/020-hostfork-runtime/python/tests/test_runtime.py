"""Real local namespace tests: no successful operating-system calls are mocked."""

import asyncio
import json
import os
import signal
import sys
import time
from pathlib import Path

import pytest
from hostfork_spike import Environment, EnvironmentSpec, Export, Mount, status_at, stop_at
from hostfork_spike.linux import alive, identity, signal_verified


async def create_or_skip(spec: EnvironmentSpec, root: Path) -> Environment:
    try:
        return await Environment.create(spec, artifact_root=root)
    except RuntimeError as error:
        if "Operation not permitted" in str(error) or "[Errno 1]" in str(error):
            pytest.skip(f"Host does not permit this namespace probe: {error}")
        raise


async def wait_closed(path: Path, timeout: float = 10) -> dict:
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        state = await status_at(path)
        if state["state"] in ("closed", "failed", "lost"):
            return state
        await asyncio.sleep(0.02)
    raise AssertionError(f"Environment did not close: {path}")


def test_mounts_multicommand_and_final_exports(tmp_path: Path) -> None:
    async def scenario() -> None:
        project, readonly, fresh, target, shared = [
            tmp_path / name for name in ("project", "ro", "fresh", "target", "shared")
        ]
        for path in (project, readonly, fresh, target, shared):
            path.mkdir()
            (path / "original").write_text("host")
        spec = EnvironmentSpec(
            mounts=[
                Mount("overlay", str(project)),
                Mount("read_only", str(readonly)),
                Mount("fresh", str(fresh)),
                Mount("bind", str(target), str(shared)),
            ],
            deadline_seconds=20,
            exports=[Export(str(project), "project")],
        )
        environment = await create_or_skip(spec, tmp_path / "artifacts")
        try:
            code = """
import os, pathlib, sys
p,ro,fresh,shared = map(pathlib.Path,sys.argv[1:])
assert (p/'original').read_text() == 'host'
(p/'original').unlink()
(p/'new').write_text('private')
try: (ro/'original').write_text('bad')
except OSError as error: assert error.errno == 30
else: raise AssertionError('readonly mount is writable')
assert list(fresh.iterdir()) == []
(fresh/'created').write_text('fresh')
(shared/'written').write_text('shared')
assert os.getpid() > 1
assert pathlib.Path('/proc/1/comm').exists()
print('hello')
print('error output', file=sys.stderr)
"""
            result = await environment.run([sys.executable, "-c", code, *map(str, (project, readonly, fresh, target))])
            assert result["returncode"] == 0, Path(result["stderr_path"]).read_text()
            assert Path(result["stdout_path"]).read_text() == "hello\n"
            assert Path(result["stderr_path"]).read_text() == "error output\n"
            second = await environment.run(["/bin/cat", str(project / "new")])
            assert Path(second["stdout_path"]).read_text() == "private"
            assert (project / "original").read_text() == "host"
            assert not (project / "new").exists()
            assert (fresh / "original").exists()
            assert (shared / "written").read_text() == "shared"
        finally:
            state = await environment.close()
        assert state["cleanup"]["graceful"]
        assert state["cleanup"]["overlay_work"][0]["state"] == "removed"
        assert not (environment.path / "overlay/0/work").exists()
        assert not (environment.path / "exports/project/original").exists()
        assert (environment.path / "exports/project/new").read_text() == "private"
        assert (environment.path / "fresh/2/created").read_text() == "fresh"

    asyncio.run(scenario())


def test_deadline_kills_setsid_descendant_after_leader_exit(tmp_path: Path) -> None:
    async def scenario() -> None:
        environment = await create_or_skip(EnvironmentSpec(deadline_seconds=1), tmp_path)
        state = await environment.status()
        try:
            result = await environment.run(
                [
                    sys.executable,
                    "-c",
                    "import subprocess; subprocess.Popen(['/bin/sleep','100'],start_new_session=True);print('partial')",
                ]
            )
            assert result["returncode"] == 0
            children_path = Path(f"/proc/{state['namespace_init_pid']}/task/{state['namespace_init_pid']}/children")
            child_pids = list(map(int, children_path.read_text().split()))
            assert child_pids
            children = [identity(pid) for pid in child_pids]
            final = await wait_closed(environment.path)
            assert final["reason"] == "deadline"
            assert final["init_final"]["payloads_reaped"]
            assert not alive(state["namespace_init_identity"])
            assert all(not alive(child) for child in children)
            assert Path(result["stdout_path"]).read_text() == "partial\n"
        finally:
            await environment.close()

    asyncio.run(scenario())


def test_deadline_escalates_signal_ignoring_command_and_preserves_status(tmp_path: Path) -> None:
    async def scenario() -> None:
        environment = await create_or_skip(EnvironmentSpec(deadline_seconds=0.6), tmp_path)
        try:
            process = await environment.spawn(
                [
                    sys.executable,
                    "-c",
                    "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                    "print('started',flush=True);time.sleep(99)",
                ]
            )
            result = await process.wait(timeout=5)
            assert result["returncode"] == -signal.SIGKILL
            assert result["signal"] == signal.SIGKILL
            assert result["reason"] == "deadline"
            final = await wait_closed(environment.path)
            assert final["init_final"]["kill_escalation"]
            assert Path(result["stdout_path"]).read_text() == "started\n"
        finally:
            await environment.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("retain", [False, True])
def test_owner_loss_policy(tmp_path: Path, retain: bool) -> None:
    async def scenario() -> None:
        environment = await create_or_skip(
            EnvironmentSpec(deadline_seconds=0.8, retain_on_owner_exit=retain),
            tmp_path,
        )
        await environment.spawn(["/bin/sleep", "99"])
        environment.detach()
        await asyncio.sleep(0.15)
        early = await status_at(environment.path)
        if retain:
            assert early["state"] == "running"
        final = await wait_closed(environment.path)
        assert final["reason"] == ("deadline" if retain else "owner_lost")
        await environment._helper.wait()

    asyncio.run(scenario())


def test_supervisor_sigkill_causes_init_cleanup_and_partial_export(tmp_path: Path) -> None:
    async def scenario() -> None:
        project = tmp_path / "project"
        project.mkdir()
        environment = await create_or_skip(
            EnvironmentSpec(
                mounts=[Mount("overlay", str(project))],
                deadline_seconds=10,
                exports=[Export(str(project), "project")],
            ),
            tmp_path / "artifacts",
        )
        try:
            result = await environment.run(["/bin/sh", "-c", f"echo partial > {project}/partial"])
            assert result["returncode"] == 0
            await environment.spawn(["/bin/sleep", "99"])
            state = await environment.status()
            signal_verified(state["supervisor_identity"], signal.SIGKILL)
            await environment._helper.wait()
            until = time.monotonic() + 5
            while alive(state["namespace_init_identity"]) and time.monotonic() < until:
                await asyncio.sleep(0.02)
            assert not alive(state["namespace_init_identity"])
            final = json.loads((environment.path / "init-final.json").read_text())
            assert final["reason"] == "supervisor_lost"
            assert final["payloads_reaped"]
            assert (environment.path / "exports/project/partial").read_text() == "partial\n"
            recovery = await stop_at(environment.path)
            assert recovery["reason"] == "supervisor_lost"
            assert not (environment.path / "overlay/0/work").exists()
        finally:
            environment.detach()

    asyncio.run(scenario())


def test_invalid_spawn_does_not_destroy_environment(tmp_path: Path) -> None:
    async def scenario() -> None:
        environment = await create_or_skip(EnvironmentSpec(deadline_seconds=10), tmp_path)
        try:
            with pytest.raises(RuntimeError, match="FileNotFoundError"):
                await environment.spawn(["/does/not/exist"])
            result = await environment.run(["/bin/true"])
            assert result["returncode"] == 0
        finally:
            await environment.close()

    asyncio.run(scenario())


def test_stale_identity_cannot_signal_unrelated_process() -> None:
    wrong = identity(os.getpid())
    wrong["starttime"] += 1
    assert not signal_verified(wrong)


def test_artifacts_cannot_be_hidden_by_mount(tmp_path: Path) -> None:
    async def scenario() -> None:
        with pytest.raises(ValueError, match="hide runtime artifacts"):
            await Environment.create(
                EnvironmentSpec(mounts=[Mount("overlay", str(tmp_path))]),
                artifact_root=tmp_path / "artifacts",
            )

    asyncio.run(scenario())


def test_relative_cwd_is_resolved_inside_new_view(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.chdir(project)

    async def scenario() -> None:
        environment = await create_or_skip(
            EnvironmentSpec(mounts=[Mount("overlay", str(project))], deadline_seconds=10),
            tmp_path / "artifacts",
        )
        try:
            result = await environment.run(["/bin/sh", "-c", "echo private > relative"])
            assert result["returncode"] == 0
            assert not (project / "relative").exists()
            second = await environment.run(["/bin/cat", "relative"])
            assert Path(second["stdout_path"]).read_text() == "private\n"
        finally:
            await environment.close()

    asyncio.run(scenario())


def test_frozen_init_has_bounded_cleanup_and_unknown_exit_status(tmp_path: Path) -> None:
    async def scenario() -> None:
        environment = await create_or_skip(
            EnvironmentSpec(deadline_seconds=0.4, cleanup_timeout_seconds=0.2),
            tmp_path,
        )
        process = await environment.spawn(["/bin/sleep", "99"])
        state = await environment.status()
        signal_verified(state["namespace_init_identity"], signal.SIGSTOP)
        try:
            final = await wait_closed(environment.path)
            assert final["reason"] == "deadline"
            assert final["state"] == "failed"
            assert final["cleanup"]["init_kill_escalation"]
            assert final["cleanup"]["namespace_released"]
            result = await process.wait()
            assert result["returncode"] is None
            assert not result["exit_observed"]
        finally:
            await environment.close()

    asyncio.run(scenario())


def test_precursor_loss_does_not_orphan_namespace_init(tmp_path: Path) -> None:
    async def scenario() -> None:
        environment = await create_or_skip(EnvironmentSpec(deadline_seconds=10), tmp_path)
        await environment.spawn(["/bin/sleep", "99"])
        state = await environment.status()
        try:
            signal_verified(state["precursor_identity"], signal.SIGKILL)
            final = await wait_closed(environment.path)
            assert final["state"] == "failed"
            assert final["reason"] == "init_lost"
            assert not alive(state["namespace_init_identity"])
        finally:
            await environment.close()

    asyncio.run(scenario())


def test_cancelled_creation_cleans_retained_environment(tmp_path: Path) -> None:
    async def scenario() -> None:
        task = asyncio.create_task(
            Environment.create(
                EnvironmentSpec(deadline_seconds=30, retain_on_owner_exit=True),
                artifact_root=tmp_path,
            )
        )
        state_path = None
        while state_path is None:
            state_path = next(tmp_path.glob("env-*/state.json"), None)
            await asyncio.sleep(0.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        final = await wait_closed(state_path.parent)
        assert final["reason"] == "startup_cancelled"
        assert not alive(final["namespace_init_identity"])

    asyncio.run(scenario())


def test_cancelled_close_still_reaps_retained_environment(tmp_path: Path) -> None:
    async def scenario() -> None:
        environment = await create_or_skip(
            EnvironmentSpec(deadline_seconds=30, retain_on_owner_exit=True),
            tmp_path,
        )
        await environment.spawn(
            [
                sys.executable,
                "-c",
                "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(99)",
            ]
        )
        closing = asyncio.create_task(environment.close())
        await asyncio.sleep(0)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        state = await environment.status()
        assert state["state"] == "closed"
        assert state["reason"] == "requested"

    asyncio.run(scenario())

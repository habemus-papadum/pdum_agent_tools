"""Real systemd scope, subprocess, descendant and controller-failure experiments."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import signal
import sys
import time
import traceback
import uuid
from pathlib import Path

from hostfork_scope_spike import ScopedProcess, launch_scoped
from hostfork_scope_spike.scoped_process import command, forget, inspect, members, membership, save, stop
from hostfork_spike.linux import alive, identity, signal_verified

HERE = Path(__file__).resolve().parent
WORKLOAD = HERE / "workloads.py"


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def process_identity(record: dict) -> dict:
    return {key: record[key] for key in ("pid", "starttime", "boot_id")}


async def ready(path: Path, timeout: float = 5) -> dict:
    until = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() >= until:
            raise TimeoutError(f"Readiness missing: {path}")
        await asyncio.sleep(0.01)
    return read(path)


async def wait_dead(identities: list[dict], timeout: float = 6) -> float:
    started = time.monotonic()
    while any(alive(item) for item in identities):
        if time.monotonic() - started > timeout:
            raise TimeoutError(f"Processes still alive: {[item for item in identities if alive(item)]}")
        await asyncio.sleep(0.02)
    return time.monotonic() - started


def argv(mode: str, root: Path) -> list[str]:
    return [sys.executable, str(WORKLOAD), mode, "--artifacts", str(root / "workload"), "--duration", "20"]


def snapshot(record: dict, root: Path) -> dict:
    fixture = read(root / "workload" / "ready.json")
    roles = {role: read(root / "workload" / f"{role}.json") for role in fixture["roles"]}
    for role in roles.values():
        assert role["cgroup"] == f"0::{record['cgroup']}", role
    owned = members(record["cgroup"])
    assert owned
    result = {"roles": roles, "cgroup_members": owned, "observed_at": time.time()}
    save(root / "members.json", result)
    return result


def remove_owned_semaphores(root: Path) -> list[str]:
    """Report and unlink only names allocated by this fixture, after its death."""
    import _multiprocessing

    path = root / "workload" / "resources.json"
    leftovers = []
    if path.exists():
        for name in read(path)["named_semaphores"]:
            try:
                _multiprocessing.sem_unlink(name)
                leftovers.append(name)
            except FileNotFoundError:
                pass
    save(root / "resource-cleanup.json", {"residual_semaphores_unlinked": leftovers})
    return leftovers


async def io_case(root: Path, mode: str = "io") -> dict:
    working = root / "working"
    working.mkdir()
    scoped = await launch_scoped(
        argv(mode, root),
        artifact_root=root / "environment",
        deadline_seconds=4,
        cwd=working,
        env={"HOSTFORK_SCOPE_TEST": "explicit-environment"},
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        assert isinstance(scoped.process, asyncio.subprocess.Process)
        output, errors = await asyncio.wait_for(scoped.process.communicate(b"input\x00bytes\n"), 5)
        role = read(root / "workload" / f"{mode}.json")
        assert role["pid"] == scoped.process.pid
        assert role["ppid"] == os.getpid()
        if mode == "io":
            assert output == b"STDOUT:input\x00bytes\n" and errors == b"STDERR:input\x00bytes\n"
            assert role["cwd"] == str(working) and role["env_value"] == "explicit-environment"
            assert scoped.process.returncode == 0
        else:
            assert scoped.process.returncode == 7
        # Deliberately let systemd GC run; AddRef must preserve final metadata.
        await asyncio.sleep(0.1)
        state = await inspect(scoped.record["unit"])
        assert state["LoadState"] == "loaded" and state["Result"] == "success"
        return {
            "pid_preserved": True,
            "parent_preserved": True,
            "returncode": scoped.process.returncode,
            "scope": state,
            "registration_seconds": scoped.record["registration_seconds"],
        }
    finally:
        await scoped.close()


async def rejected_case(root: Path) -> dict:
    scoped = await ScopedProcess.prepare(argv("io", root), artifact_root=root / "environment")
    try:
        try:
            await scoped.adopt(3, invalid_property=True)
        except RuntimeError as error:
            assert "HostforkDeliberatelyInvalidProperty" in str(error)
            rejection = str(error)
        else:
            raise AssertionError("Deliberately invalid systemd property was accepted")
        scoped.drop_gate()
        assert await asyncio.wait_for(scoped.process.wait(), 3) == 125
        assert not (root / "environment" / "released.txt").exists()
        assert not (root / "workload").exists()
        return {"registration_error": rejection, "gate_returncode": 125, "workload_ran": False}
    finally:
        await scoped.close()


async def tree_case(root: Path, mode: str) -> dict:
    started = time.monotonic()
    with (root / "stdout.log").open("wb") as out, (root / "stderr.log").open("wb") as err:
        scoped = await launch_scoped(
            argv("orphan_tree" if mode == "orphan" else "tree", root),
            artifact_root=root / "environment",
            deadline_seconds=3,
            stdout=out,
            stderr=err,
        )
        observed = None
        try:
            await ready(root / "workload" / "ready.json")
            observed = snapshot(scoped.record, root)
            if mode == "orphan":
                assert await asyncio.wait_for(scoped.process.wait(), 1) == 0
                assert any(alive(item) for item in observed["cgroup_members"])
                assert (await inspect(scoped.record["unit"]))["ActiveState"] == "active"
            if mode == "stop":
                save(root / "stop-request.json", {"reason": "explicit_external_stop", "time": time.time()})
                await stop(scoped.record["unit"])
            await wait_dead(observed["cgroup_members"])
            elapsed = time.monotonic() - started
            returncode = await asyncio.wait_for(scoped.process.wait(), 2)
            state = await inspect(scoped.record["unit"])
            # TERM-resistant tasks also produce Result=timeout when an explicit
            # stop exhausts TimeoutStopSec. Persist the initiating decision too.
            assert state["Result"] == "timeout", state
            assert returncode == (0 if mode == "orphan" else -signal.SIGKILL)
            assert not members(scoped.record["cgroup"])
            assert all(p.stat().st_size for p in (root / "workload").glob("*.partial"))
            return {
                "roles": list(observed["roles"]),
                "observed_processes": len(observed["cgroup_members"]),
                "elapsed_seconds": elapsed,
                "returncode": returncode,
                "scope": state,
                "registration_seconds": scoped.record["registration_seconds"],
            }
        finally:
            await scoped.close()
            if observed:
                await wait_dead(observed["cgroup_members"])
            remove_owned_semaphores(root)


async def owner(root: Path, stage: str) -> None:
    """Disposable Python caller whose death/freeze the outer harness injects."""
    with (root / "stdout.log").open("wb") as out, (root / "stderr.log").open("wb") as err:
        scoped = await ScopedProcess.prepare(
            argv("tree", root),
            artifact_root=root / "environment",
            stdout=out,
            stderr=err,
        )
        try:
            if stage != "gated":
                await scoped.adopt(3)
            if stage in ("released", "frozen"):
                scoped.release()
                await ready(root / "workload" / "ready.json")
                snapshot(scoped.record, root)
            save(root / "owner-ready.json", {"stage": stage, "identity": identity(os.getpid())})
            await asyncio.sleep(15)
        finally:
            await scoped.close()


async def owner_failure_case(root: Path, stage: str) -> dict:
    caller = await asyncio.create_subprocess_exec(
        sys.executable,
        str(HERE / "probe.py"),
        "--owner-stage",
        stage,
        "--output",
        str(root),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    caller_id = identity(caller.pid)
    record = None
    try:
        await ready(root / "owner-ready.json")
        record = read(root / "environment" / "record.json")
        known = [record["launcher"]]
        if (root / "members.json").exists():
            known = read(root / "members.json")["cgroup_members"]
        save(root / "injection.json", {"owner": caller_id, "action": "SIGSTOP" if stage == "frozen" else "SIGKILL"})
        signal_verified(caller_id, signal.SIGSTOP if stage == "frozen" else signal.SIGKILL)
        elapsed = await wait_dead(known)
        state = await inspect(record["unit"])
        if stage in ("released", "frozen"):
            assert state["Result"] == "timeout", state
            assert (root / "workload" / "parent.partial").stat().st_size > 0
        else:
            assert not (root / "environment" / "released.txt").exists()
            assert not (root / "workload").exists()
        return {
            "injected_stage": stage,
            "elapsed_after_injection_seconds": elapsed,
            "observed_processes": len(known),
            "scope": state,
            "partial_evidence": (root / "workload" / "parent.partial").exists(),
        }
    finally:
        signal_verified(caller_id, signal.SIGKILL)
        _, errors = await asyncio.wait_for(caller.communicate(), 4)
        (root / "caller-stderr.log").write_bytes(errors)
        if record is None and (root / "environment" / "record.json").exists():
            record = read(root / "environment" / "record.json")
        if record:
            await forget(record["unit"])
            signal_verified(record["launcher"])
            if record.get("cgroup"):
                assert not members(record["cgroup"])
        remove_owned_semaphores(root)


async def late_adoption_case(root: Path) -> dict:
    """Negative control: migration of a parent does not move existing children."""
    environment = root / "environment"
    environment.mkdir()
    with (root / "stdout.log").open("wb") as out, (root / "stderr.log").open("wb") as err:
        process = await asyncio.create_subprocess_exec(*argv("late_adoption", root), stdout=out, stderr=err)
        record = {
            "unit": f"hostfork-scope-{uuid.uuid4().hex}.scope",
            "launcher": identity(process.pid),
            "original_cgroup": membership(process.pid),
            "stage": "ungated-negative-control",
        }
        save(environment / "record.json", record)
        scoped = ScopedProcess(environment, process, None, record)
        child = None
        try:
            await ready(root / "workload" / "ready.json")
            child = process_identity(read(root / "workload" / "preexisting_child.json"))
            await scoped.adopt(1)
            assert membership(child["pid"]) == record["original_cgroup"]
            assert membership(child["pid"]) != scoped.record["cgroup"]
            assert await asyncio.wait_for(process.wait(), 3) == -signal.SIGKILL
            assert alive(child), "Negative control unexpectedly lost its outside-scope child"
            state = await inspect(record["unit"])
            assert state["Result"] == "timeout"
            return {
                "parent_timed_out": True,
                "preexisting_child_survived": True,
                "original_cgroup": record["original_cgroup"],
                "scope": state,
            }
        finally:
            try:
                await scoped.close()
            finally:
                child_path = root / "workload" / "preexisting_child.json"
                if child is None and child_path.exists():
                    child = process_identity(read(child_path))
                if child:
                    signal_verified(child)
                    await wait_dead([child])


async def namespace_case(root: Path) -> dict:
    """Outer ownership survives additional user/mount/PID namespaces inside it."""
    from hostfork_spike import stop_at

    view = root / "view"
    view.mkdir()
    (view / "data").write_text("host baseline\n")
    with (root / "stdout.log").open("wb") as out, (root / "stderr.log").open("wb") as err:
        scoped = await launch_scoped(
            [sys.executable, str(HERE / "namespace_workload.py"), str(root)],
            artifact_root=root / "environment",
            deadline_seconds=4,
            stdout=out,
            stderr=err,
        )
        try:
            await ready(root / "workload" / "ready.json")
            inner = Path(read(root / "inner-location.json")["path"])
            owned = members(scoped.record["cgroup"])
            assert len(owned) >= 12, owned
            # Fixture PIDs now belong to its private PID namespace. Ownership
            # checks use host identities read from the outer cgroup instead.
            save(root / "members.json", {"cgroup_members": owned, "private_pid_namespace": True})
            await wait_dead(owned)
            await asyncio.wait_for(scoped.process.wait(), 3)
            state = await inspect(scoped.record["unit"])
            assert state["Result"] == "timeout"
            assert (view / "data").read_text() == "host baseline\n"
            assert (inner / "overlay/0/upper/data").read_text() == "private write\n"
            semaphore_files = list((inner / "fresh/1").glob("sem.*"))
            assert semaphore_files, "Expected private, retained semaphore files after SIGKILL"
            return {
                "observed_processes": len(owned),
                "scope": state,
                "host_baseline_unchanged": True,
                "private_write_retained": True,
                "retained_private_semaphores": len(semaphore_files),
            }
        finally:
            await scoped.close()
            if (root / "inner-location.json").exists():
                # External recovery cleans overlay scratch after namespace loss;
                # upper/fresh directories deliberately remain as forensic data.
                await stop_at(read(root / "inner-location.json")["path"], reason="scope_test_recovery")


async def audit(root: Path) -> dict:
    remaining = []
    units = []
    cgroups = []
    identities = []
    for path in root.glob("*/environment/record.json"):
        record = read(path)
        units.append(record["unit"])
        state = await inspect(record["unit"])
        if state.get("LoadState") != "not-found":
            remaining.append({"unit": record["unit"], "state": state})
        if record.get("cgroup"):
            cgroups.append(record["cgroup"])
        identities.append(record["launcher"])
    for path in root.glob("*/members.json"):
        identities.extend(read(path)["cgroup_members"])
    for path in root.glob("*/workload/*.json"):
        item = read(path)
        if "pid" in item:
            identities.append(process_identity(item))
    live = [item for item in identities if alive(item)]
    residual_cgroups = [path for path in cgroups if (Path("/sys/fs/cgroup") / path.lstrip("/")).exists()]
    result = {
        "units_checked": len(units),
        "identity_observations": len(identities),
        "remaining_units": remaining,
        "live_processes": live,
        "residual_cgroups": residual_cgroups,
    }
    save(root / "audit.json", result)
    assert not remaining and not live and not residual_cgroups, result
    return result


async def matrix(root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=False)
    versions = {
        "python": sys.version,
        "kernel": platform.release(),
        "systemd": (await command("systemctl", "--version"))[1].splitlines()[0],
        "dbus_next": "0.2.3",
        "uid": os.getuid(),
        "git_head": (await command("git", "rev-parse", "HEAD"))[1],
    }
    sources = {
        str(path.relative_to(HERE)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in HERE.rglob("*.py")
        if "__pycache__" not in str(path)
    }
    results = {"started_at": time.time(), "versions": versions, "source_sha256": sources, "cases": []}
    save(root / "results.json", results)
    cases = [
        ("io", lambda path: io_case(path)),
        ("application_exit7", lambda path: io_case(path, "exit7")),
        ("registration_rejected", rejected_case),
        ("tree_deadline", lambda path: tree_case(path, "deadline")),
        ("tree_external_stop", lambda path: tree_case(path, "stop")),
        ("leader_exit_before_descendants", lambda path: tree_case(path, "orphan")),
        ("owner_killed_before_registration", lambda path: owner_failure_case(path, "gated")),
        ("owner_killed_before_release", lambda path: owner_failure_case(path, "registered")),
        ("owner_killed_after_release", lambda path: owner_failure_case(path, "released")),
        ("owner_frozen_after_release", lambda path: owner_failure_case(path, "frozen")),
        ("late_adoption_negative_control", late_adoption_case),
        ("nested_namespace_tree", namespace_case),
    ]
    for name, function in cases:
        path = root / name
        path.mkdir()
        started = time.monotonic()
        try:
            outcome = await asyncio.wait_for(function(path), 14)
            result = {"case": name, "passed": True, "duration_seconds": time.monotonic() - started, **outcome}
        except Exception as error:
            result = {
                "case": name,
                "passed": False,
                "error": f"{type(error).__name__}: {error}",
                "traceback": traceback.format_exc(),
            }
        results["cases"].append(result)
        save(root / "results.json", results)
        print(f"{name}: {'PASS' if result['passed'] else result['error']}", flush=True)
    results["audit"] = await audit(root)
    results["finished_at"] = time.time()
    save(root / "results.json", results)
    assert all(item["passed"] for item in results["cases"]), f"See failures in {root / 'results.json'}"
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--owner-stage", choices=("gated", "registered", "released", "frozen"), help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = (args.output or Path("artifacts/024-hostfork-scope") / f"run-{time.time_ns()}").resolve()
    if args.owner_stage:
        asyncio.run(owner(root, args.owner_stage))
    else:
        print(f"Evidence: {root}", flush=True)
        asyncio.run(matrix(root))


if __name__ == "__main__":
    main()

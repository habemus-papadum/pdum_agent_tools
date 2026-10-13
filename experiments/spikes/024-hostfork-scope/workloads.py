"""Independent, bounded process trees for scope ownership and asyncio I/O probes.

Public modes are tree, orphan_tree, late_adoption, io and exit7. The other modes
are internal helpers. No namespace, cgroup or scope is created by this fixture.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import multiprocessing
import multiprocessing.forkserver
import multiprocessing.resource_tracker
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve()
EXPECTED_ROLES = (
    "parent",
    "subprocess_python",
    "shell",
    "shell_sleep",
    "pool_spawn",
    "forkserver_child",
    "resource_tracker",
    "forkserver",
    "daemon",
)


def process_record(pid: int, role: str) -> dict:
    """Read the process identity and actual cgroup membership from procfs."""
    directory = Path("/proc") / str(pid)
    fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
    return {
        "role": role,
        "pid": pid,
        "ppid": int(fields[1]),
        "starttime": int(fields[19]),
        "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "cgroup": (directory / "cgroup").read_text().strip(),
        "cmdline": (directory / "cmdline").read_bytes().decode(errors="replace").split("\0")[:-1],
        "session": int(fields[3]),
        "observed_at": time.time(),
    }


def write_record(artifacts: Path, role: str, pid: int | None = None, **extra: object) -> dict:
    """Atomically publish a role record so readers never see incomplete JSON."""
    record = {**process_record(os.getpid() if pid is None else pid, role), **extra}
    temporary = artifacts / f".{role}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps(record, indent=2) + "\n")
    temporary.replace(artifacts / f"{role}.json")
    return record


def heartbeat(artifacts_string: str, role: str, deadline: float) -> dict:
    """Publish identity and flushed partial evidence until the common deadline."""
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    artifacts = Path(artifacts_string)
    record = write_record(artifacts, role, deadline_monotonic=deadline)
    with (artifacts / f"{role}.partial").open("a", buffering=1) as stream:
        while time.monotonic() < deadline and not (artifacts / "stop").exists():
            event = {"role": role, "pid": os.getpid(), "time": time.time()}
            stream.write(json.dumps(event) + "\n")
            print(json.dumps(event), flush=True)
            time.sleep(0.1)
    return {"role": role, "pid": record["pid"], "finished_at": time.time()}


def daemonize(artifacts: Path, deadline: float) -> None:
    """Double-fork in a fresh interpreter and leave a bounded setsid daemon."""
    first = os.fork()
    if first:
        os.waitpid(first, 0)
        return
    os.setsid()
    write_record(artifacts, "daemon_intermediate")
    parent = os.getpid()
    second = os.fork()
    if second:
        os._exit(0)
    # Capture the final daemon after its intermediate parent has really exited.
    until = min(deadline, time.monotonic() + 1)
    while os.getppid() == parent and time.monotonic() < until:
        time.sleep(0.005)
    try:
        heartbeat(str(artifacts), "daemon", deadline)
    finally:
        os._exit(0)


def child_command(mode: str, artifacts: Path, deadline: float, *extra: str) -> list[str]:
    """Build an explicit interpreter invocation for an independent descendant."""
    return [
        sys.executable,
        str(SCRIPT),
        mode,
        "--artifacts",
        str(artifacts),
        "--deadline",
        str(deadline),
        *extra,
    ]


def record_pool_resources(artifacts: Path, executor: concurrent.futures.ProcessPoolExecutor) -> None:
    """Identify exact owned semaphore names for cleanup after tracker SIGKILL."""
    allocations: dict[str, str] = {}
    for queue_name in ("_call_queue", "_result_queue"):
        queue = getattr(executor, queue_name)
        for field in ("_rlock", "_wlock", "_sem"):
            semaphore = getattr(getattr(queue, field, None), "_semlock", None)
            name = getattr(semaphore, "name", None)
            if name:
                allocations[f"{queue_name}.{field}"] = name
    write_record(
        artifacts,
        "resources",
        named_semaphores=sorted(set(allocations.values())),
        allocation_sites=allocations,
        note="After every scope process stops, the harness may unlink these exact owned names if still present.",
    )


def process_tree(artifacts: Path, deadline: float, orphan: bool) -> None:
    """Create mixed Python/native descendants and publish complete readiness."""
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    write_record(artifacts, "parent", deadline_monotonic=deadline)
    subprocesses: list[subprocess.Popen] = []
    executor = None
    forkserver_child = None
    try:
        subprocesses.append(
            subprocess.Popen(
                child_command("worker", artifacts, deadline, "--role", "subprocess_python"),
                stdin=subprocess.DEVNULL,
            )
        )
        # The shell is a persistent parent of a native sleep, not an exec alias.
        # SIG_IGN is inherited across exec, so both survive ordinary SIGTERM.
        shell_script = """
trap '' TERM
/bin/sleep "$1" &
child=$!
"$2" "$3" register --artifacts "$4" --role shell --pid "$$"
"$2" "$3" register --artifacts "$4" --role shell_sleep --pid "$child"
while kill -0 "$child" 2>/dev/null; do
    printf 'shell=%s child=%s still alive\\n' "$$" "$child" >> "$4/shell.partial"
    /bin/sleep 0.1
done
wait "$child"
"""
        subprocesses.append(
            subprocess.Popen(
                [
                    "/bin/sh",
                    "-c",
                    shell_script,
                    "hostfork-scope-fixture",
                    str(max(0.01, deadline - time.monotonic())),
                    sys.executable,
                    str(SCRIPT),
                    str(artifacts),
                ],
                stdin=subprocess.DEVNULL,
            )
        )
        executor = concurrent.futures.ProcessPoolExecutor(
            max_workers=1,
            mp_context=multiprocessing.get_context("spawn"),
            # An orphan worker exits after this one task, rather than waiting
            # indefinitely for another item from an abandoned work queue.
            max_tasks_per_child=1,
        )
        record_pool_resources(artifacts, executor)
        future = executor.submit(heartbeat, str(artifacts), "pool_spawn", deadline)
        forkserver_child = multiprocessing.get_context("forkserver").Process(
            target=heartbeat, args=(str(artifacts), "forkserver_child", deadline)
        )
        forkserver_child.start()
        # These implementation details are deliberately confined to a Python
        # 3.14 fixture; scope ownership must not depend on this registration.
        tracker_pid = multiprocessing.resource_tracker._resource_tracker._pid
        forkserver_pid = multiprocessing.forkserver._forkserver._forkserver_pid
        if tracker_pid is None or forkserver_pid is None:
            raise RuntimeError("multiprocessing helper identities unavailable")
        write_record(artifacts, "resource_tracker", tracker_pid)
        write_record(artifacts, "forkserver", forkserver_pid)
        daemon_parent = subprocess.Popen(child_command("daemonize", artifacts, deadline), stdin=subprocess.DEVNULL)
        subprocesses.append(daemon_parent)
        daemon_parent.wait(timeout=3)
        ready_until = min(deadline, time.monotonic() + 5)
        while not all((artifacts / f"{role}.json").exists() for role in EXPECTED_ROLES):
            if future.done() and future.exception() is not None:
                raise RuntimeError("spawn worker failed") from future.exception()
            if time.monotonic() >= ready_until:
                missing = [role for role in EXPECTED_ROLES if not (artifacts / f"{role}.json").exists()]
                raise TimeoutError(f"Workload roles did not become ready: {missing}")
            time.sleep(0.01)
        ready = write_record(artifacts, "ready", roles=list(EXPECTED_ROLES), orphan=orphan)
        print("READY " + json.dumps(ready), flush=True)
        if orphan:
            # Deliberately bypass executor atexit handlers: the experiment must
            # prove scope ownership survives the original command's exit.
            os._exit(0)
        heartbeat(str(artifacts), "parent", deadline)
    finally:
        # Normal completion and setup failure cooperate with Python descendants.
        # A forcibly killed/orphaned parent cannot execute this block; every
        # workload still has the same <=25-second self-expiry deadline.
        (artifacts / "stop").write_text("parent cleanup\n")
        for process in subprocesses:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
        if forkserver_child is not None:
            forkserver_child.join(timeout=1)
            if forkserver_child.is_alive():
                forkserver_child.kill()
                forkserver_child.join(timeout=3)
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)


def late_adoption(artifacts: Path, deadline: float) -> None:
    """Create a detached child before a controller adopts only the main PID."""
    write_record(artifacts, "parent", deadline_monotonic=deadline)
    child = subprocess.Popen(
        child_command("worker", artifacts, deadline, "--role", "preexisting_child"),
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        ready_until = min(deadline, time.monotonic() + 5)
        while not (artifacts / "preexisting_child.json").exists():
            if child.poll() is not None:
                raise RuntimeError("Preexisting child exited before readiness")
            if time.monotonic() > ready_until:
                raise TimeoutError("Preexisting child did not become ready")
            time.sleep(0.01)
        ready = write_record(artifacts, "ready", roles=["parent", "preexisting_child"])
        print("READY " + json.dumps(ready), flush=True)
        heartbeat(str(artifacts), "parent", deadline)
    finally:
        (artifacts / "stop").write_text("parent cleanup\n")
        if child.poll() is None:
            child.kill()
        child.wait(timeout=3)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode", choices=("tree", "orphan_tree", "late_adoption", "io", "exit7", "worker", "daemonize", "register")
    )
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument(
        "--duration", type=float, default=20, help="Common lifetime, greater than 0 and at most 25 seconds"
    )
    parser.add_argument("--deadline", type=float, help=argparse.SUPPRESS)
    parser.add_argument("--role", default="worker", help=argparse.SUPPRESS)
    parser.add_argument("--pid", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 0 < args.duration <= 25:
        parser.error("duration must be greater than 0 and at most 25 seconds")
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    deadline = args.deadline if args.deadline is not None else time.monotonic() + args.duration
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if args.mode in ("tree", "orphan_tree"):
        process_tree(artifacts, deadline, orphan=args.mode == "orphan_tree")
    elif args.mode == "late_adoption":
        late_adoption(artifacts, deadline)
    elif args.mode == "worker":
        heartbeat(str(artifacts), args.role, deadline)
    elif args.mode == "daemonize":
        daemonize(artifacts, deadline)
    elif args.mode == "register":
        write_record(artifacts, args.role, args.pid)
    elif args.mode == "io":
        payload = sys.stdin.buffer.read()
        write_record(
            artifacts,
            "io",
            stdin_hex=payload.hex(),
            cwd=os.getcwd(),
            env_value=os.environ.get("HOSTFORK_SCOPE_TEST"),
            executable=sys.executable,
        )
        sys.stdout.buffer.write(b"STDOUT:" + payload)
        sys.stdout.buffer.flush()
        sys.stderr.buffer.write(b"STDERR:" + payload)
        sys.stderr.buffer.flush()
    elif args.mode == "exit7":
        write_record(artifacts, "exit7")
        print("exit7 stdout", flush=True)
        print("exit7 stderr", file=sys.stderr, flush=True)
        return 7
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

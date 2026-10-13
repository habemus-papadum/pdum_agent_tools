"""Fresh, single-threaded Linux supervisor and PID-namespace init.

Executed by filename under Python isolated mode. Imports finish before unshare;
the host-side supervisor never enters the workload's namespaces.
"""

import json
import os
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback
import uuid
from pathlib import Path

# Isolated Python deliberately omits this directory from sys.path.
sys.path.insert(0, str(Path(__file__).parent))
from linux import (  # noqa: E402
    MS_BIND,
    MS_RDONLY,
    MS_REC,
    MS_REMOUNT,
    enter_namespaces,
    identity,
    mount,
    parent_death_signal,
    remove_overlay_work,
    signal_verified,
)


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def send(connection: socket.socket, value: dict) -> None:
    connection.sendall((json.dumps(value) + "\n").encode())


def apply_mounts(config: dict) -> None:
    root = Path(config["artifact_path"])
    for index, spec in enumerate(config["spec"]["mounts"]):
        target, source = spec["target"], spec.get("source") or spec["target"]
        kind = spec["kind"]
        if kind == "overlay":
            upper, work = root / "overlay" / str(index) / "upper", root / "overlay" / str(index) / "work"
            upper.mkdir(parents=True)
            work.mkdir()
            # Escaping mount option delimiters is deliberately not inferred.
            if any(character in str(value) for value in (source, upper, work) for character in (",", ":", "\\")):
                raise ValueError("Overlay paths containing commas, colons or backslashes are unsupported in this spike")
            mount("overlay", target, "overlay", data=f"lowerdir={source},upperdir={upper},workdir={work},userxattr")
        elif kind == "fresh":
            directory = root / "fresh" / str(index)
            directory.mkdir(parents=True)
            mount(str(directory), target, None, MS_BIND)
        else:
            mount(source, target, None, MS_BIND | MS_REC)
            if kind == "read_only":
                mount(None, target, None, MS_REMOUNT | MS_BIND | MS_RDONLY)


def export_paths(config: dict) -> list[dict]:
    root = Path(config["artifact_path"]) / "exports"
    results = []
    for spec in config["spec"]["exports"]:
        source, target = Path(spec["source"]), root / spec["destination"]
        result = {"source": str(source), "destination": str(target)}
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir() and not source.is_symlink():
                shutil.copytree(source, target, symlinks=True)
            else:
                shutil.copy2(source, target, follow_symlinks=False)
            result["state"] = "exported"
        except Exception as error:
            result.update(state="failed", error=f"{type(error).__name__}: {error}")
        results.append(result)
    return results


def namespace_processes() -> list[int]:
    # This is safe only after mounting proc for the new PID namespace.
    return [int(path.name) for path in Path("/proc").iterdir() if path.name.isdigit() and int(path.name) > 1]


def terminate_namespace(sig: int) -> None:
    for pid in namespace_processes():
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def init_main(config: dict, connection: socket.socket) -> None:
    root = Path(config["artifact_path"])
    spec = config["spec"]
    # Read from the inherited host proc view before replacing it. The outer
    # supervisor can then verify this PID using its unchanged host proc view.
    host_pid = int(Path("/proc/self/stat").read_text().split(" ", 1)[0])
    send(connection, {"event": "init_identity", "identity": identity(host_pid)})
    mount("proc", "/proc", "proc")
    if os.getpid() != 1 or Path("/proc/self/stat").read_text().split(" ", 1)[0] != "1":
        raise RuntimeError("Refusing descendant cleanup without a private proc view and namespace PID 1")
    apply_mounts(config)
    # An inherited cwd descriptor can still refer to the covered lower tree.
    # Re-resolve each command's cwd from its path in the new mounted view.
    os.chdir("/")
    processes: dict[str, dict] = {}
    running: dict[int, str] = {}
    handles: dict[int, subprocess.Popen] = {}
    output_handles: dict[int, list] = {}
    events_lost = False
    shutdown_reason: str | None = None
    shutdown_start = 0.0
    killed = False

    def emit(event: dict) -> None:
        nonlocal events_lost
        try:
            send(connection, event)
        except (BrokenPipeError, ConnectionResetError):
            events_lost = True

    def reap() -> None:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if not pid:
                return
            code = os.waitstatus_to_exitcode(status)
            if pid in running:
                item = processes[running.pop(pid)]
                handles.pop(pid).returncode = code
                for handle in output_handles.pop(pid, []):
                    handle.close()
                item.update(
                    state="exited",
                    returncode=code,
                    signal=-code if code < 0 else None,
                    reason=shutdown_reason or ("signal" if code < 0 else "exit"),
                    exited_at=time.time(),
                    exit_observed=True,
                )
                emit({"event": "process", "process": item})

    def on_signal(number: int, frame: object) -> None:
        nonlocal shutdown_reason, shutdown_start
        if shutdown_reason is None:
            shutdown_reason, shutdown_start = f"init_signal_{number}", time.monotonic()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    selector = selectors.DefaultSelector()
    selector.register(connection, selectors.EVENT_READ)
    buffer = b""
    emit({"event": "ready"})
    while True:
        reap()
        if shutdown_reason:
            terminate_namespace(signal.SIGKILL if killed else signal.SIGTERM)
            if time.monotonic() - shutdown_start >= spec["termination_grace_seconds"]:
                killed = True
                terminate_namespace(signal.SIGKILL)
            reap()
            if not namespace_processes():
                break
        for key, _ in selector.select(0.01):
            try:
                data = connection.recv(65536)
            except ConnectionResetError:
                data = b""
            if not data:
                selector.unregister(connection)
                if shutdown_reason is None:
                    shutdown_reason, shutdown_start = "supervisor_lost", time.monotonic()
                continue
            buffer += data
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                request = json.loads(line)
                if request["method"] == "stop":
                    if shutdown_reason is None:
                        shutdown_reason, shutdown_start = request["reason"], time.monotonic()
                elif request["method"] == "spawn":
                    request_id = request["request_id"]
                    files = []
                    try:
                        if shutdown_reason is not None:
                            raise RuntimeError("Environment is stopping")
                        process_id = uuid.uuid4().hex[:12]
                        directory = root / "processes" / process_id
                        directory.mkdir(parents=True)
                        stdout_path, stderr_path = directory / "stdout.log", directory / "stderr.log"
                        kwargs = {}
                        if request["stdio"] == "logs":
                            files = [stdout_path.open("ab", buffering=0), stderr_path.open("ab", buffering=0)]
                            kwargs = {"stdin": subprocess.DEVNULL, "stdout": files[0], "stderr": files[1]}
                        command_env = os.environ.copy()
                        command_env.update(request.get("env") or {})
                        child = subprocess.Popen(
                            request["argv"],
                            cwd=request.get("cwd") or config["initial_cwd"],
                            env=command_env,
                            **kwargs,
                        )
                        item = {
                            "id": process_id,
                            "namespace_pid": child.pid,
                            "argv": request["argv"],
                            "state": "running",
                            "returncode": None,
                            "signal": None,
                            "reason": None,
                            "started_at": time.time(),
                            "exit_observed": False,
                            "stdio": request["stdio"],
                            "stdout_path": str(stdout_path) if files else None,
                            "stderr_path": str(stderr_path) if files else None,
                        }
                        processes[process_id], running[child.pid] = item, process_id
                        handles[child.pid], output_handles[child.pid] = child, files
                        emit({"event": "process", "process": item})
                        emit({"request_id": request_id, "result": item})
                    except Exception as error:
                        for file in files:
                            file.close()
                        emit({"request_id": request_id, "error": f"{type(error).__name__}: {error}"})
    exports = export_paths(config)
    result = {
        "reason": shutdown_reason,
        "exports": exports,
        "processes": processes,
        "payloads_reaped": True,
        "kill_escalation": killed,
        "supervisor_events_lost": events_lost,
        "closed_at": time.time(),
    }
    write_json(root / "init-final.json", result)
    emit({"event": "init_final", "result": result})


def setup_namespace(config: dict, fd: int) -> None:
    connection = socket.socket(fileno=fd)
    try:
        enter_namespaces()
        parent_pid = os.getpid()
        child = os.fork()
        if child:
            connection.close()
            _, status = os.waitpid(child, 0)
            sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
        parent_death_signal(signal.SIGKILL)
        host_stat = Path("/proc/self/stat").read_text()
        if int(host_stat[host_stat.rindex(")") + 2 :].split()[1]) != parent_pid:
            os._exit(1)
        try:
            init_main(config, connection)
        finally:
            connection.close()
        os._exit(0)
    except BaseException as error:
        if not isinstance(error, SystemExit):
            try:
                send(connection, {"event": "failure", "error": f"{type(error).__name__}: {error}"})
            except OSError:
                pass
            with (Path(config["artifact_path"]) / "supervisor.log").open("a") as log:
                traceback.print_exc(file=log)
        raise


def supervisor(config: dict, owner_fd: int) -> None:
    root = Path(config["artifact_path"])
    spec = config["spec"]
    started = time.monotonic()
    state = {
        "environment_id": config["environment_id"],
        "artifact_path": str(root),
        "state": "starting",
        "reason": None,
        "supervisor_identity": identity(os.getpid()),
        "supervisor_pid": os.getpid(),
        "namespace_init_identity": None,
        "namespace_init_pid": None,
        "processes": {},
        "started_at": time.time(),
        "deadline_seconds": spec["deadline_seconds"],
        "deadline_monotonic": started + spec["deadline_seconds"] if spec["deadline_seconds"] else None,
        "cleanup": {"namespace_released": False, "artifacts_retained": True},
    }
    write_json(root / "state.json", state)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind("\0" + config["socket_name"])
    listener.listen(128)
    connection, child_connection = socket.socketpair()
    helper_log = (root / "supervisor.log").open("ab", buffering=0)
    precursor = subprocess.Popen(
        [sys.executable, "-I", __file__, "init", str(root), str(child_connection.fileno())],
        pass_fds=(child_connection.fileno(),),
    )
    child_connection.close()
    state["precursor_identity"] = identity(precursor.pid)
    selector = selectors.DefaultSelector()
    selector.register(listener, selectors.EVENT_READ, "listener")
    selector.register(connection, selectors.EVENT_READ, "init")
    selector.register(owner_fd, selectors.EVENT_READ, "owner")
    buffers: dict[socket.socket, bytes] = {connection: b""}
    replies: dict[socket.socket, bytes] = {}
    pending: dict[str, socket.socket] = {}
    stopping_at: float | None = None
    init_connected = True
    final_received = False

    def persist() -> None:
        write_json(root / "state.json", state)

    def stop(reason: str) -> None:
        nonlocal stopping_at
        if stopping_at is not None:
            return
        stopping_at = time.monotonic()
        state.update(state="stopping", reason=reason, stopping_at=time.time())
        # Persist the initiating reason before sending any teardown signal.
        persist()
        if init_connected:
            try:
                send(connection, {"method": "stop", "reason": reason})
            except (BrokenPipeError, ConnectionResetError):
                pass

    def on_signal(number: int, frame: object) -> None:
        stop(f"supervisor_signal_{number}")

    def reply(client: socket.socket, value: dict) -> None:
        # A client that does not read must never stall the deadline supervisor.
        if client.fileno() < 0:
            return
        buffers.pop(client, None)
        replies[client] = (json.dumps(value) + "\n").encode()
        selector.modify(client, selectors.EVENT_WRITE, "reply")

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    persist()
    while True:
        now = time.monotonic()
        if state["deadline_monotonic"] and now >= state["deadline_monotonic"]:
            stop("deadline")
        if stopping_at is not None and now - stopping_at >= spec["cleanup_timeout_seconds"]:
            if "kill_sent_at" not in state["cleanup"]:
                expected = state.get("namespace_init_identity")
                if expected:
                    state["cleanup"]["init_kill_escalation"] = signal_verified(expected)
                else:
                    state["cleanup"]["precursor_kill_escalation"] = signal_verified(state["precursor_identity"])
                state["cleanup"]["kill_sent_at"] = time.time()
                persist()
            if now - stopping_at >= spec["cleanup_timeout_seconds"] + 2:
                state.update(state="failed", error="Cleanup did not complete after SIGKILL; external reap required")
                state["cleanup"]["incomplete"] = True
                persist()
                break
        for key, _ in selector.select(0.01):
            if key.data == "reply":
                client = key.fileobj
                try:
                    sent = client.send(replies[client])
                    replies[client] = replies[client][sent:]
                except (BrokenPipeError, ConnectionResetError):
                    replies[client] = b""
                except BlockingIOError:
                    continue
                if not replies[client]:
                    replies.pop(client)
                    selector.unregister(client)
                    client.close()
                continue
            if key.data == "listener":
                client, _ = listener.accept()
                client.setblocking(False)
                buffers[client] = b""
                selector.register(client, selectors.EVENT_READ, "client")
                continue
            if key.data == "owner":
                if not os.read(owner_fd, 1):
                    selector.unregister(owner_fd)
                    os.close(owner_fd)
                    state["owner_lost_at"] = time.time()
                    if not spec["retain_on_owner_exit"]:
                        stop("owner_lost")
                    else:
                        persist()
                continue
            stream = key.fileobj
            try:
                data = stream.recv(65536)
            except ConnectionResetError:
                data = b""
            if not data:
                selector.unregister(stream)
                buffers.pop(stream, None)
                if key.data == "init":
                    init_connected = False
                    if stopping_at is None:
                        stop("init_lost")
                else:
                    stream.close()
                continue
            buffers[stream] += data
            while b"\n" in buffers.get(stream, b""):
                line, buffers[stream] = buffers[stream].split(b"\n", 1)
                try:
                    message = json.loads(line)
                    if key.data == "client":
                        if message.get("environment_id") != config["environment_id"]:
                            raise ValueError("Environment identity mismatch")
                        method = message["method"]
                        if method == "status":
                            reply(stream, {"result": state})
                        elif method == "stop":
                            stop(message.get("reason", "external_stop"))
                            reply(stream, {"result": state})
                        elif method == "spawn":
                            if state["state"] != "running":
                                raise RuntimeError("Environment is not accepting new commands")
                            request_id = uuid.uuid4().hex
                            pending[request_id] = stream
                            send(connection, {**message, "request_id": request_id})
                        else:
                            raise ValueError(f"Unknown method: {method}")
                    elif "request_id" in message:
                        client = pending.pop(message["request_id"], None)
                        if client is not None:
                            reply(client, message)
                    elif message["event"] == "init_identity":
                        state["namespace_init_identity"] = message["identity"]
                        state["namespace_init_pid"] = message["identity"]["pid"]
                        persist()
                    elif message["event"] == "ready":
                        if stopping_at is None:
                            state.update(
                                state="running",
                                ready_at=time.time(),
                                startup_seconds=time.monotonic() - started,
                            )
                        persist()
                    elif message["event"] == "process":
                        item = message["process"]
                        state["processes"][item["id"]] = item
                        persist()
                    elif message["event"] == "init_final":
                        final_received = True
                        state["init_final"] = message["result"]
                        state["processes"] = message["result"]["processes"]
                        persist()
                    elif message["event"] == "failure":
                        state["error"] = message["error"]
                        stop("setup_failed")
                except Exception as error:
                    if key.data == "client":
                        reply(stream, {"error": f"{type(error).__name__}: {error}"})
                    else:
                        state["error"] = f"Protocol error: {type(error).__name__}: {error}"
                        stop("protocol_failed")
        returncode = precursor.poll()
        if returncode is not None:
            # Drain already delivered final frames before concluding when possible.
            if init_connected:
                continue
            for client in pending.values():
                reply(client, {"error": "Namespace init exited before command acknowledgement"})
            state.update(
                state="closed" if final_received and not state.get("error") else "failed",
                reason=state["reason"] or "init_lost",
                precursor_returncode=returncode,
                closed_at=time.time(),
                lifetime_seconds=time.monotonic() - started,
            )
            state["cleanup"].update(namespace_released=True, graceful=final_received)
            state["cleanup"]["overlay_work"] = remove_overlay_work(root, spec["mounts"])
            for item in state["processes"].values():
                if item["returncode"] is None:
                    item.update(state="lost", reason=state["reason"], exit_observed=False)
            persist()
            break
    connection.close()
    listener.close()
    helper_log.close()


if __name__ == "__main__":
    mode, artifact_path, descriptor = sys.argv[1:]
    configuration = json.loads((Path(artifact_path) / "config.json").read_text())
    if mode == "supervisor":
        try:
            supervisor(configuration, int(descriptor))
        except BaseException:
            with (Path(artifact_path) / "supervisor.log").open("a") as log:
                traceback.print_exc(file=log)
            raise
    else:
        setup_namespace(configuration, int(descriptor))

"""Qualify the official Node SDK through the Python launcher without credentials or inference.

Run from the repository root after installing the workspace and the pinned
examples/claude-client pnpm dependencies. No browser or paid compatibility is implied.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib.metadata
import json
import os
import platform
import shutil
import signal
import socket
import sys
import tempfile
from pathlib import Path
from typing import Any

import psutil

ROOT = Path(__file__).resolve().parents[1]


def _alive(process: psutil.Process) -> bool:
    try:
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


async def _stop_owned(processes: set[psutil.Process]) -> None:
    for action in ("terminate", "kill"):
        for process in processes:
            if _alive(process):
                with contextlib.suppress(psutil.NoSuchProcess):
                    getattr(process, action)()
        deadline = asyncio.get_running_loop().time() + 3
        while any(_alive(process) for process in processes) and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.02)
    if any(_alive(process) for process in processes):
        raise RuntimeError("An owned compatibility-check process survived cleanup")


async def _command(*args: str, environment: dict[str, str], timeout: float) -> bytes:
    """Capture output privately and retain process identities for failure cleanup."""
    process = await asyncio.create_subprocess_exec(
        *args,
        env=environment,
        cwd=ROOT,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    identity = None
    owned: set[psutil.Process] = set()
    with contextlib.suppress(psutil.NoSuchProcess):
        identity = psutil.Process(process.pid)
        identity.create_time()
        owned.add(identity)
    communication = asyncio.create_task(process.communicate())
    leader_exited_at: float | None = None
    try:
        async with asyncio.timeout(timeout):
            while not communication.done():
                if identity is not None and _alive(identity):
                    with contextlib.suppress(psutil.NoSuchProcess):
                        for child in identity.children(recursive=True):
                            child.create_time()
                            owned.add(child)
                if process.returncode is not None:
                    now = asyncio.get_running_loop().time()
                    leader_exited_at = leader_exited_at or now
                    if now - leader_exited_at > 0.2:
                        raise RuntimeError("Compatibility-check subprocess exited without closing output pipes")
                await asyncio.sleep(0.01)
            output, _ = await communication
            if process.returncode:
                raise RuntimeError(f"Compatibility-check subprocess exited with code {process.returncode}")
            return output
    finally:
        # Identities, rather than a broad executable-name kill, also cover native
        # workers that start their own process groups and later become orphaned.
        try:
            await _stop_owned(owned)
        finally:
            try:
                await asyncio.wait_for(process.wait(), 3)
            finally:
                if process.returncode is not None:
                    # Only close this subprocess's handles after its leader
                    # exits; an escaped descendant may still hold stdout open.
                    process._transport.close()
                if not communication.done():
                    communication.cancel()
                await asyncio.gather(communication, return_exceptions=True)


async def _run_clients(arguments: argparse.Namespace) -> dict[str, Any]:
    import uvicorn
    from pdum.claude_launcher import AuthSpec, ClaudeManager, create_profile
    from pdum.claude_launcher.authentication import auth_status
    from pdum.claude_launcher.management import create_app

    class ForegroundServer(uvicorn.Server):
        @contextlib.contextmanager
        def capture_signals(self):
            # The application owns cancellation and cleanup, not this adapter.
            yield

    workspace = Path(arguments.state) / "workspace"
    workspace.mkdir()
    profile = create_profile(
        Path(arguments.state) / "profile",
        workspace=workspace,
        executable=arguments.binary,
        setting_sources=("user",),
        auth=AuthSpec("native"),
    )
    if (await auth_status(profile)).logged_in:
        raise RuntimeError("Fresh native profile unexpectedly has credentials")
    manager = ClaudeManager({"qualification": profile}, stop_timeout=2)
    owned: set[psutil.Process] = set()
    worker_identities: dict[str, psutil.Process] = {}
    peak_workers = 0
    monitoring = True

    async def monitor() -> None:
        nonlocal peak_workers
        while monitoring:
            active = 0
            for status in manager.list_workers():
                identity = worker_identities.get(status["id"])
                if identity is None:
                    if status["pid"] is None or status["state"] not in {"connected", "stopping"}:
                        continue
                    try:
                        identity = psutil.Process(status["pid"])
                        identity.create_time()
                        marker = f"--session-id={status['conversation_id']}"
                        if marker not in identity.cmdline():
                            raise RuntimeError("Native worker PID did not match its allocated conversation")
                        if not identity.is_running():
                            continue
                        worker_identities[status["id"]] = identity
                        owned.add(identity)
                    except psutil.NoSuchProcess:
                        continue
                # Reuse the saved identity, which detects PID reuse. Never adopt
                # historical worker PIDs as a new process after disconnect.
                if _alive(identity):
                    active += 1
                    with contextlib.suppress(psutil.NoSuchProcess):
                        owned.update(identity.children(recursive=True))
            peak_workers = max(peak_workers, active)
            await asyncio.sleep(0.01)

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    base_url = f"http://127.0.0.1:{sock.getsockname()[1]}"
    server = ForegroundServer(
        uvicorn.Config(
            create_app(manager),
            log_level="critical",
            access_log=False,
            ws_max_size=None,
            timeout_graceful_shutdown=3,
        )
    )
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    watching = asyncio.create_task(monitor())
    reports: list[dict[str, Any]] = []
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if serving.done():
                    await serving
                    raise RuntimeError("Management server exited before becoming ready")
                await asyncio.sleep(0.01)
        for _ in range(arguments.rounds):
            tasks = [
                asyncio.create_task(
                    _command(
                        arguments.node,
                        str(arguments.example_dir / "node.mjs"),
                        base_url,
                        "qualification",
                        environment=dict(os.environ),
                        timeout=arguments.timeout,
                    )
                )
                for _ in range(arguments.clients)
            ]
            try:
                outputs = await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            for output in outputs:
                report = json.loads(output)
                if (
                    report.get("status") != "passed"
                    or report.get("modelRequests") != 0
                    or report.get("live") is not False
                    or len(report.get("checks", [])) != 3
                ):
                    raise RuntimeError("Official Node SDK initialization/control/disconnect probe failed")
                reports.append(report)
        statuses = manager.list_workers()
        if len(statuses) != arguments.clients * arguments.rounds:
            raise RuntimeError("Unexpected worker allocation count")
        if any(
            status["state"] != "stopped"
            or status["pid"] is None
            or status["exit_code"] is None
            or status["cleanup_errors"]
            or status["transport_errors"]
            for status in statuses
        ):
            raise RuntimeError("A native worker did not stop cleanly after SDK disconnect")
        if any(_alive(identity) for identity in owned):
            raise RuntimeError("An owned native worker or descendant survived SDK disconnect")
        if peak_workers < arguments.clients:
            raise RuntimeError("Requested native worker concurrency was not observed")
        return {
            "status": "passed",
            "clients_per_round": arguments.clients,
            "rounds": arguments.rounds,
            "completed_clients": len(reports),
            "peak_native_workers": peak_workers,
            "workers_reaped": len(statuses),
            "initialization_checks": len(reports),
            "interrupt_checks": len(reports),
            "disconnect_checks": len(reports),
            "model_requests": 0,
            "credentials": "fresh native profile; logged out",
            "captures": "disabled",
            "browser": "not exercised",
        }
    finally:
        await manager.aclose()
        monitoring = False
        await watching
        server.should_exit = True
        try:
            await asyncio.wait_for(serving, 10)
        finally:
            sock.close()
            await _stop_owned(owned)


async def check_clients(arguments: argparse.Namespace) -> dict[str, Any]:
    """Own temporary state and supervise a runner with no inherited credentials.

    Parameters
    ----------
    arguments
        Parsed executable selections, concurrency, repetition and time bounds.

    Returns
    -------
    dict
        Capture-free version and lifecycle results. No inference is requested.
    """
    with tempfile.TemporaryDirectory(prefix="pdum-claude-clients-") as directory:
        state = Path(directory)
        home = state / "home"
        home.mkdir()
        environment = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(home),
            "TMPDIR": str(state),
            "LANG": "C.UTF-8",
            "CLAUDE_CONFIG_DIR": str(state / "version-config"),
            "ANTHROPIC_CONFIG_DIR": str(state / "version-anthropic"),
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_AUTOUPDATER": "1",
        }
        sdk = json.loads(
            (arguments.example_dir / "node_modules/@anthropic-ai/claude-agent-sdk/package.json").read_text()
        )["version"]
        manifest = json.loads((arguments.example_dir / "package.json").read_text())
        if sdk != manifest["dependencies"]["@anthropic-ai/claude-agent-sdk"]:
            raise RuntimeError("Installed official Node SDK does not match the pinned example manifest")
        async with asyncio.timeout(arguments.timeout):
            native = (
                (await _command(arguments.binary, "--version", environment=environment, timeout=10)).decode().strip()
            )
            if "Claude Code" not in native:
                raise RuntimeError("Selected executable did not identify itself as Claude Code")
            node = (await _command(arguments.node, "--version", environment=environment, timeout=10)).decode().strip()
            output = await _command(
                sys.executable,
                str(Path(__file__).resolve()),
                "--runner",
                "--state",
                str(state),
                "--binary",
                arguments.binary,
                "--node",
                arguments.node,
                "--example-dir",
                str(arguments.example_dir),
                "--clients",
                str(arguments.clients),
                "--rounds",
                str(arguments.rounds),
                "--timeout",
                str(arguments.timeout),
                environment=environment,
                timeout=arguments.timeout,
            )
        report = json.loads(output)
        report["versions"] = {
            "native_claude": native,
            "node": node,
            "typescript_sdk": sdk,
            "python_sdk": importlib.metadata.version("claude-agent-sdk"),
            "python": platform.python_version(),
            "platform": platform.system(),
        }
        return report


def main() -> None:
    """Run the bounded, credential-free compatibility check."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default=shutil.which("claude"))
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--example-dir", type=Path, default=ROOT / "examples/claude-client")
    parser.add_argument("--clients", type=int, default=4)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=120, help="Total check deadline in seconds, excluding cleanup")
    parser.add_argument("--runner", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--state", help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if not arguments.binary or not arguments.node:
        parser.error("Install native Claude and Node, or select --binary and --node")
    if arguments.clients < 1 or arguments.rounds < 1 or arguments.timeout <= 0:
        parser.error("clients, rounds and timeout must be positive")
    if arguments.runner and not arguments.state:
        parser.error("Internal runner needs temporary state")
    arguments.binary = str(Path(shutil.which(arguments.binary) or arguments.binary).resolve())
    arguments.node = str(Path(shutil.which(arguments.node) or arguments.node).resolve())
    arguments.example_dir = arguments.example_dir.resolve()

    async def run() -> dict[str, Any]:
        task = asyncio.current_task()
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(signum, task.cancel)
        return await (_run_clients(arguments) if arguments.runner else check_clients(arguments))

    try:
        result = asyncio.run(run())
    except (Exception, asyncio.CancelledError) as error:
        # Never print raw subprocess stdout/stderr, authentication or protocol.
        result = {"status": "failed", "error": type(error).__name__, "model_requests": 0, "captures": "disabled"}
        print(json.dumps(result, indent=2))
        raise SystemExit(1) from None
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

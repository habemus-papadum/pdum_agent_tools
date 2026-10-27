"""Small foreground owner for an isolated coordinator instance."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import tempfile
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import psutil

API_VERSION = "0"


class CoordinatorError(RuntimeError):
    """Base error for an explicit coordinator operation."""


class StateDirectoryError(CoordinatorError):
    """The selected state directory cannot be newly owned by this instance."""


class InstanceMismatchError(CoordinatorError):
    """An operation names a different coordinator instance."""


def _timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class Coordinator:
    """Own isolated instance metadata without launching any provider.

    Parameters
    ----------
    state_directory
        New directory to create. Omit to allocate a unique temporary directory.
        Existing directories are not adopted, even if empty or previously stopped.
    workspace_directory
        Existing working directory shown as the launch-context starting point.
    host_id
        Host identity supplied by the application; defaults to this host's name.

    Notes
    -----
    Construction is inert. Use the async context manager or call ``start`` and
    ``close`` explicitly. State is retained after close for inspection; the owner
    that allocated the development instance may remove it separately.
    """

    def __init__(
        self,
        *,
        state_directory: Path | None = None,
        workspace_directory: Path | None = None,
        host_id: str | None = None,
    ) -> None:
        self._requested_directory = state_directory
        self._requested_workspace = workspace_directory
        self.host_id = host_id or socket.gethostname()
        self.instance_id = str(uuid4())
        self._state_directory: Path | None = None
        self._workspace_directory: Path | None = None
        self._started_at: str | None = None
        self._stopped_at: str | None = None
        self._pid: int | None = None
        self._process_started_at: float | None = None
        self._stop_requested = asyncio.Event()
        self._state = "new"
        self._lifecycle_lock = asyncio.Lock()

    @property
    def state_directory(self) -> Path:
        """Return the allocated state directory after startup."""
        if self._state_directory is None:
            raise CoordinatorError("Coordinator has not started")
        return self._state_directory

    @property
    def workspace_directory(self) -> Path:
        """Return the resolved workspace after startup."""
        if self._workspace_directory is None:
            raise CoordinatorError("Coordinator has not started")
        return self._workspace_directory

    async def start(self) -> Coordinator:
        """Allocate fresh state and record the actual owner identity.

        Returns
        -------
        Coordinator
            This running owner. A stopped owner cannot be restarted or adopted.
        """
        async with self._lifecycle_lock:
            if self._state != "new":
                raise CoordinatorError("Coordinator can only be started once")
            workspace = (self._requested_workspace or Path.cwd()).expanduser().resolve(strict=True)
            if not workspace.is_dir():
                raise CoordinatorError(f"Workspace is not a directory: {workspace}")
            if self._requested_directory is None:
                directory = Path(tempfile.mkdtemp(prefix="pdum-orchestrator-"))
            else:
                directory = self._requested_directory.expanduser().absolute()
                try:
                    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
                except FileExistsError:
                    raise StateDirectoryError(
                        f"State directory already exists; select a new directory: {directory}"
                    ) from None
                directory = directory.resolve()
            self._state_directory = directory
            self._workspace_directory = workspace
            self._pid = os.getpid()
            self._process_started_at = psutil.Process(self._pid).create_time()
            self._started_at = _timestamp()
            try:
                for provider in ("codex", "claude", "hp"):
                    (directory / "profiles" / provider).mkdir(parents=True, mode=0o700)
                self._state = "running"
                await self._write_record()
            except BaseException:
                self._state = "stopped"
                self._stopped_at = _timestamp()
                with suppress(OSError):
                    await self._write_record()
                raise
        return self

    def status(self) -> dict[str, Any]:
        """Return actual owner metadata and implemented management capabilities.

        Returns
        -------
        dict
            API-versioned, camelCase JSON values. No authentication state or
            provider readiness is inferred from these service facts.
        """
        directory = self.state_directory
        return {
            "apiVersion": API_VERSION,
            "instanceId": self.instance_id,
            "hostId": self.host_id,
            "pid": self._pid,
            "processStartedAt": self._process_started_at,
            "startedAt": self._started_at,
            "stoppedAt": self._stopped_at,
            "state": self._state,
            "stateDirectory": str(directory),
            "workspaceDirectory": str(self.workspace_directory),
            "profileRoots": {
                provider: str(directory / "profiles" / provider) for provider in ("codex", "claude", "hp")
            },
            "capabilities": ["status", "runs", "stop"],
        }

    def list_runs(self) -> list[dict[str, Any]]:
        """Return current owned provider runs; S0 has no provider-launch operation."""
        self.state_directory  # Require a started owner without inventing provider state.
        return []

    def verify_instance(self, instance_id: str) -> None:
        """Check an operation's target identity without granting or denying access."""
        if instance_id != self.instance_id:
            raise InstanceMismatchError("Requested instanceId does not match this coordinator")

    def request_stop(self, instance_id: str) -> None:
        """Request this owner to stop; never signal a PID named by the caller."""
        self.verify_instance(instance_id)
        if self._state == "new":
            raise CoordinatorError("Coordinator has not started")
        if self._state == "running":
            self._state = "stopping"
        self._stop_requested.set()

    async def wait_for_stop(self) -> None:
        """Wait for an explicit shutdown request from this owner's entry point."""
        await self._stop_requested.wait()

    async def _write_record(self) -> None:
        directory = self.state_directory
        value = json.dumps(self.status(), indent=2) + "\n"

        def write() -> None:
            record = directory / "instance.json"
            if record.exists():
                existing = json.loads(record.read_text(encoding="utf8"))
                if existing.get("instanceId") != self.instance_id:
                    raise StateDirectoryError("Instance record now belongs to another owner; not overwriting it")
            temporary = directory / f".instance-{uuid4()}.tmp"
            try:
                with temporary.open("x", encoding="utf8") as output:
                    temporary.chmod(0o600)
                    output.write(value)
                temporary.replace(record)
            finally:
                temporary.unlink(missing_ok=True)

        # Cancellation must not leave a background write racing a later stopped
        # record. Finish this small atomic metadata update before propagating it.
        task = asyncio.create_task(asyncio.to_thread(write))
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise

    async def close(self) -> None:
        """Record orderly shutdown and retain owned evidence, idempotently."""
        async with self._lifecycle_lock:
            if self._state in {"new", "stopped"}:
                return
            self._stop_requested.set()
            self._state = "stopped"
            self._stopped_at = _timestamp()
            await self._write_record()

    async def __aenter__(self) -> Coordinator:
        return await self.start()

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

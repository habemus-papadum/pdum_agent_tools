"""Profile-scoped saved conversations using the official Python Agent SDK."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .authentication import build_environment

if TYPE_CHECKING:
    from .profiles import Profile


class HistoryError(RuntimeError):
    """The SDK history helper failed or stopped before completing a request."""


class History:
    """Read and modify saved conversations within one profile and workspace.

    Parameters
    ----------
    profile
        Profile whose native history is managed. Multiple History instances may
        access the same profile; each helper receives a fixed environment.
    operation_timeout
        Deadline in seconds for a helper operation, excluding time queued behind
        other calls. None disables the deadline. No transcript size limit applies.

    Notes
    -----
    Calls start a helper lazily and perform no inference. The helper uses only
    public SDK functions; this package does not interpret transcript files.
    Results retain the Python SDK's snake_case field names as ordinary JSON
    objects. Closing a History object does not stop any conversation worker.
    """

    def __init__(self, profile: Profile, *, operation_timeout: float | None = 30.0) -> None:
        if operation_timeout is not None and operation_timeout <= 0:
            raise ValueError("operation_timeout must be positive or None")
        self.profile = profile
        self.operation_timeout = operation_timeout
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._buffer = bytearray()
        self._closed = False

    @property
    def pid(self) -> int | None:
        """Return the helper PID, or None before the first operation."""
        return self._process.pid if self._process else None

    @property
    def closed(self) -> bool:
        """Whether new operations require a fresh History instance.

        Callers may replace a closed instance for a subsequent request. They
        should not automatically retry failed rename/fork operations: the SDK
        might have performed the write before the response was lost.
        """
        return self._closed or (self._process is not None and self._process.returncode is not None)

    async def __aenter__(self) -> History:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def _start(self) -> asyncio.subprocess.Process:
        if self._closed:
            raise HistoryError("History helper is closed")
        if self._process is None:
            environment = await build_environment(self.profile, authenticate=False)
            spawning = asyncio.create_task(
                asyncio.create_subprocess_exec(
                    sys.executable,
                    "-I",
                    str(Path(__file__).with_name("_storage_helper.py")),
                    str(self.profile.workspace),
                    cwd=self.profile.workspace,
                    env=environment,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
            )
            try:
                self._process = await asyncio.shield(spawning)
            except asyncio.CancelledError:
                # A canceled create_subprocess_exec await can otherwise lose
                # ownership after the OS child exists but before it returns.
                self._closed = True
                self._process = await spawning
                await self._stop()
                raise
            if self._closed:
                await self._stop()
                raise HistoryError("History helper is closed")
        if self._process.returncode is not None:
            raise HistoryError(f"History helper exited with code {self._process.returncode}")
        return self._process

    async def _read_response(self, process: asyncio.subprocess.Process) -> dict[str, Any]:
        assert process.stdout is not None
        # A transcript can exceed asyncio's default readline limit. Chunked
        # reads preserve full responses without introducing a payload cap.
        while b"\n" not in self._buffer:
            chunk = await process.stdout.read(65536)
            if not chunk:
                raise HistoryError("History helper stopped before responding")
            self._buffer.extend(chunk)
        line, _, remainder = self._buffer.partition(b"\n")
        self._buffer = bytearray(remainder)
        try:
            response = json.loads(line)
        except (ValueError, UnicodeError) as error:
            raise HistoryError("History helper returned an invalid response") from error
        if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
            raise HistoryError("History helper returned an invalid response")
        return response

    async def _call(self, operation: str, **fields: Any) -> Any:
        async with self._lock:
            try:
                async with asyncio.timeout(self.operation_timeout):
                    process = await self._start()
                    assert process.stdin is not None
                    process.stdin.write((json.dumps({"operation": operation, **fields}) + "\n").encode())
                    await process.stdin.drain()
                    response = await self._read_response(process)
            except TimeoutError:
                self._closed = True
                await asyncio.shield(self._stop())
                raise TimeoutError(
                    f"History {operation} operation timed out; completion is unknown and the operation was not retried"
                ) from None
            except BaseException:
                # Cancellation must not leave a response for the next caller.
                self._closed = True
                await asyncio.shield(self._stop())
                raise
            if response["ok"]:
                return response.get("result")
            error_type = {"ValueError": ValueError, "FileNotFoundError": FileNotFoundError}.get(
                response.get("error_type"), HistoryError
            )
            raise error_type(response.get("error", "History operation failed"))

    async def list(self, *, limit: int | None = None, offset: int = 0) -> list[dict[str, Any]]:
        """List saved conversations for this profile's workspace."""
        return await self._call("list", limit=limit, offset=offset)

    async def info(self, session_id: str) -> dict[str, Any] | None:
        """Return SDK metadata, or None if the conversation does not exist."""
        return await self._call("info", session_id=session_id)

    async def read(self, session_id: str, *, limit: int | None = None, offset: int = 0) -> list[dict[str, Any]]:
        """Read saved messages using the SDK's native worktree lookup semantics."""
        return await self._call("read", session_id=session_id, limit=limit, offset=offset)

    async def rename(self, session_id: str, title: str) -> None:
        """Set the native conversation title through the SDK."""
        await self._call("rename", session_id=session_id, title=title)

    async def fork(
        self, session_id: str, *, title: str | None = None, up_to_message_id: str | None = None
    ) -> dict[str, Any]:
        """Copy a conversation through the SDK and return its new session_id."""
        return await self._call("fork", session_id=session_id, title=title, up_to_message_id=up_to_message_id)

    async def _stop(self) -> None:
        process = self._process
        if process is None:
            return
        if process.stdin is not None:
            process.stdin.close()
        try:
            await asyncio.wait_for(asyncio.shield(process.wait()), timeout=3)
        except TimeoutError:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()

    async def close(self) -> None:
        """Close and reap this helper; subsequent operations fail explicitly."""
        self._closed = True
        await self._stop()

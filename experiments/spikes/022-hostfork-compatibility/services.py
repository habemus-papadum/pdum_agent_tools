"""Small real host services for filesystem-view compatibility experiments."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path


class HostServices:
    """Serve file reads over TCP/Unix sockets and receive a FIFO message."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.unix_path = directory / "host.sock"
        self.fifo_path = directory / "host.fifo"
        self._servers: list[asyncio.Server] = []
        self._fifo_fd = -1
        self._writers: set[asyncio.StreamWriter] = set()
        self.tcp_port = 0

    async def __aenter__(self) -> HostServices:
        self.directory.mkdir(parents=True)
        os.mkfifo(self.fifo_path)
        self._fifo_fd = os.open(self.fifo_path, os.O_RDONLY | os.O_NONBLOCK)
        self._servers.append(await asyncio.start_unix_server(self._read_file, path=self.unix_path))
        tcp = await asyncio.start_server(self._read_file, host="127.0.0.1", port=0)
        self._servers.append(tcp)
        self.tcp_port = tcp.sockets[0].getsockname()[1]
        return self

    async def _read_file(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        try:
            requested = Path((await asyncio.wait_for(reader.readline(), 5)).decode().rstrip("\n"))
            # This service is intentionally a real host process resolving an absolute path.
            response = {"content": requested.read_text(), "pid": os.getpid()}
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()
        except (OSError, TimeoutError) as exc:
            writer.write(json.dumps({"error": str(exc)}).encode() + b"\n")
            with contextlib.suppress(ConnectionError):
                await writer.drain()
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()
            self._writers.discard(writer)

    def configuration(self) -> dict:
        """Return endpoints passed to the client running in a namespace."""
        return {
            "unix_path": str(self.unix_path),
            "fifo_path": str(self.fifo_path),
            "tcp_port": self.tcp_port,
        }

    def fifo_message(self) -> str:
        """Read the small probe message without blocking the event loop."""
        try:
            return os.read(self._fifo_fd, 4096).decode()
        except BlockingIOError:
            return ""

    async def __aexit__(self, *_: object) -> None:
        for server in self._servers:
            server.close()
        for server in self._servers:
            await server.wait_closed()
        for writer in tuple(self._writers):
            writer.close()
        if self._fifo_fd >= 0:
            os.close(self._fifo_fd)

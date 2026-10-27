"""Mountable Typer commands; the invoked entry point owns signals and shutdown."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from .runtime import Coordinator, CoordinatorError
from .server import open_server


def create_cli() -> typer.Typer:
    """Create a mountable CLI without touching state, listeners or signal handlers."""
    application = typer.Typer(help="Foreground coordination for owned agent runtimes.", no_args_is_help=True)

    @application.callback()
    def main() -> None:
        """Run explicit coordinator operations."""

    @application.command("serve")
    def serve(
        host: Annotated[str, typer.Option(help="Listening address; defaults to all IPv4 interfaces.")] = "0.0.0.0",
        port: Annotated[int, typer.Option(min=0, max=65535, help="Listening port; 0 selects an available port.")] = 0,
        state_directory: Annotated[Path | None, typer.Option(help="New isolated instance directory.")] = None,
        workspace_directory: Annotated[
            Path | None, typer.Option(help="Existing launch-context working directory.")
        ] = None,
        host_id: Annotated[str | None, typer.Option(help="Application-supplied host identity.")] = None,
        exit_on_stdin_eof: Annotated[
            bool, typer.Option(help="Stop when the owning supervisor closes stdin; Unix pipe hosting only.")
        ] = False,
    ) -> None:
        """Serve real instance metadata and explicit targeted shutdown."""
        try:
            asyncio.run(
                _serve(
                    host=host,
                    port=port,
                    state_directory=state_directory,
                    workspace_directory=workspace_directory,
                    host_id=host_id,
                    exit_on_stdin_eof=exit_on_stdin_eof,
                )
            )
        except (CoordinatorError, RuntimeError, OSError, ValueError) as error:
            Console(stderr=True).print(str(error), style="red", markup=False)
            raise typer.Exit(1) from None

    return application


async def _serve(
    *,
    host: str,
    port: int,
    state_directory: Path | None,
    workspace_directory: Path | None,
    host_id: str | None,
    exit_on_stdin_eof: bool,
) -> None:
    coordinator = Coordinator(
        state_directory=state_directory,
        workspace_directory=workspace_directory,
        host_id=host_id,
    )
    loop = asyncio.get_running_loop()
    signals: list[signal.Signals] = []
    stdin_fd: int | None = None
    async with coordinator:
        try:
            for name in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(name, coordinator.request_stop, coordinator.instance_id)
                signals.append(name)
            if exit_on_stdin_eof:
                if os.name != "posix":
                    raise RuntimeError("--exit-on-stdin-eof currently requires a Unix pipe host")
                stdin_fd = sys.stdin.fileno()

                def readable() -> None:
                    try:
                        data = os.read(stdin_fd, 4096)
                    except BlockingIOError:
                        return
                    if not data:
                        loop.remove_reader(stdin_fd)
                        coordinator.request_stop(coordinator.instance_id)

                loop.add_reader(stdin_fd, readable)
            async with open_server(coordinator, host=host, port=port) as running:
                print(json.dumps(running.readiness()), flush=True)
                await running.wait()
        finally:
            if stdin_fd is not None:
                loop.remove_reader(stdin_fd)
            for name in signals:
                loop.remove_signal_handler(name)


app = create_cli()

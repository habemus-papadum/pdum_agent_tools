"""Exported, mountable Typer CLI over the async sidecar library."""

import asyncio
import json
import signal
from collections.abc import Mapping
from pathlib import Path
from typing import Annotated

import typer

from .config import ProcessorSpec, SidecarConfig
from .processors import discover_processors
from .sidecar import open_sidecar


def _processor_spec(value: str) -> ProcessorSpec:
    reference, separator, configuration = value.partition("=")
    options = json.loads(configuration) if separator else {}
    if not isinstance(options, dict):
        raise ValueError("processor configuration must be a JSON object")
    return ProcessorSpec(factory=reference, config=options)


def create_app(*, providers: Mapping[str, typer.Typer] | None = None) -> typer.Typer:
    """Create an independent command tree, optionally mounting provider apps.

    Parameters
    ----------
    providers
        Explicit namespaced Typer apps; registration never starts a proxy.

    Returns
    -------
    typer.Typer
        Application suitable for direct execution or ``parent.add_typer``.
    """
    application = typer.Typer(help="Launch a generic, application-owned interception proxy.")

    @application.command()
    def run(
        capture_dir: Annotated[Path | None, typer.Option(help="Parent directory for unique run archives.")] = None,
        record: Annotated[bool, typer.Option(help="Enable capture immediately.")] = False,
        host: str = "0.0.0.0",
        port: int = 0,
        upstream_ca: Path | None = None,
        processor: Annotated[
            list[str] | None, typer.Option(help="Explicit module:factory[=JSON object] observation processor.")
        ] = None,
    ) -> None:
        """Run in the foreground until interrupted; print ready connection data."""
        try:
            config = SidecarConfig(
                capture_dir=capture_dir, recording=record, bind_host=host, port=port, upstream_ca=upstream_ca
            )
            asyncio.run(_run(config, [_processor_spec(value) for value in processor or []]))
        except (ValueError, RuntimeError) as error:
            raise typer.BadParameter(str(error)) from error

    @application.command("processors")
    def list_processors() -> None:
        """List installed processor entry points without activating them."""
        typer.echo(json.dumps(discover_processors(), indent=2))

    for name, provider in (providers or {}).items():
        if name in {"run", "processors"}:
            raise ValueError(f"provider command collides with built-in command: {name}")
        application.add_typer(provider, name=name)
    return application


async def _run(config: SidecarConfig, processors: list[ProcessorSpec]) -> None:
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    signals = (signal.SIGINT, signal.SIGTERM)
    for stop_signal in signals:
        loop.add_signal_handler(stop_signal, stopped.set)
    try:
        async with open_sidecar(config, processors=processors) as handle:
            typer.echo(
                json.dumps(
                    {
                        "pid": handle.pid,
                        "proxy_url": handle.connection.proxy_url,
                        "ca_cert_path": str(handle.connection.ca_cert_path),
                        "capture_path": str(handle.capture_path) if handle.capture_path else None,
                    }
                )
            )
            stopped_task = asyncio.create_task(stopped.wait())
            failure_task = asyncio.create_task(handle.wait_failure())
            try:
                await asyncio.wait((stopped_task, failure_task), return_when=asyncio.FIRST_COMPLETED)
                if failure_task.done() and failure_task.result() is not None:
                    raise failure_task.result()
            finally:
                stopped_task.cancel()
                failure_task.cancel()
                await asyncio.gather(stopped_task, failure_task, return_exceptions=True)
    finally:
        for stop_signal in signals:
            loop.remove_signal_handler(stop_signal)


app = create_app()

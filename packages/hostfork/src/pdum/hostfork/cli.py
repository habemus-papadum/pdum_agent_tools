"""Mountable Typer adapters over the asynchronous Hostfork library."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import tomllib
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.pretty import Pretty

from .environment import Hostfork
from .models import EnvironmentSpec, HostView, Limits, PrivateTree


def _run(operation):
    try:
        return asyncio.run(operation)
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        typer.echo(f"Error: {error}", err=True)
        raise typer.Exit(1) from error


def _parse(operation, *arguments):
    """Present request-shape errors without hiding unexpected runtime TypeErrors."""
    try:
        return operation(*arguments)
    except (OSError, ValueError, KeyError, TypeError) as error:
        typer.echo(f"Error: {error}", err=True)
        raise typer.Exit(1) from error


def _emit(ctx: typer.Context, value) -> None:
    if ctx.obj["json"] or not Console().is_terminal:
        typer.echo(json.dumps(value, indent=2, default=str))
    else:
        Console().print(Pretty(value))


def _host(ctx: typer.Context) -> Hostfork:
    return ctx.obj["host"]


def _read_spec(path: Path | None) -> EnvironmentSpec:
    if path is None:
        return EnvironmentSpec()
    value = tomllib.loads(path.read_text()) if path.suffix == ".toml" else json.loads(path.read_text())
    return EnvironmentSpec.from_dict(value)


def _spec(path, copy, overlay, read_only, fresh, ttl, memory, cpu) -> EnvironmentSpec:
    spec = _read_spec(path)
    if (copy or overlay or read_only or fresh) and not isinstance(spec.view, HostView):
        raise ValueError("Mount options require HostView")
    trees = dict(spec.trees)
    replace = dict(spec.view.replace) if isinstance(spec.view, HostView) else {}
    for kind, values in (("copy", copy), ("overlay", overlay)):
        for value in values or []:
            source, separator, target = value.partition("=")
            if not separator:
                raise ValueError(f"--{kind} requires SOURCE=TARGET (absolute paths)")
            name = f"cli_{len(trees)}"
            trees[name] = PrivateTree(source=source, storage=kind, stable=kind == "overlay")
            if target in replace:
                raise ValueError(f"Duplicate private target: {target}")
            replace[target] = name
    view = spec.view
    if isinstance(view, HostView):
        view = dataclasses.replace(
            view, replace=replace, read_only=(*view.read_only, *(read_only or [])), fresh=(*view.fresh, *(fresh or []))
        )
    lifetime = dataclasses.replace(spec.lifetime, max_runtime=ttl) if ttl is not None else spec.lifetime
    limits = Limits(
        memory if memory is not None else spec.limits.memory_bytes, cpu if cpu is not None else spec.limits.cpu_cores
    )
    return dataclasses.replace(spec, trees=trees, view=view, lifetime=lifetime, limits=limits)


async def _foreground(host: Hostfork, spec: EnvironmentSpec, argv: list[str], cwd: Path | None) -> int:
    environment = await host.create(spec)
    try:
        child = await environment.spawn(argv, cwd=cwd, stdout=None, stderr=None)
        result = await child.wait()
        return (
            result.returncode
            if result.returncode is not None and result.returncode >= 0
            else 128 + (result.signal or 0)
        )
    finally:
        await environment.stop("foreground_complete")


def create_app() -> typer.Typer:
    """Build a CLI without launching processes, installing handlers or initializing state."""
    app = typer.Typer(no_args_is_help=True, help="Host-derived Linux environments for trusted operators.")
    support_app = typer.Typer(no_args_is_help=True, help="Explicit user-systemd recovery support.")
    baseline_app = typer.Typer(no_args_is_help=True, help="Register prepared borrowed inputs.")
    app.add_typer(support_app, name="support")
    app.add_typer(baseline_app, name="baseline")

    @app.callback()
    def main(
        ctx: typer.Context,
        root: Annotated[Path, typer.Option(help="Persistent state and evidence directory.")] = Path(
            "~/.local/state/pdum-hostfork"
        ),
        pool: Annotated[list[str] | None, typer.Option(help="Allocation pool NAME=/absolute/path; repeatable.")] = None,
        json_output: Annotated[bool, typer.Option("--json", help="Machine-readable output.")] = False,
    ):
        pools = {}
        for item in pool or []:
            name, separator, path = item.partition("=")
            if not separator or not name or not Path(path).is_absolute():
                raise typer.BadParameter("--pool requires NAME=/absolute/path")
            pools[name] = Path(path)
        ctx.obj = {"host": Hostfork(root, pools=pools), "json": json_output}

    @app.command("doctor")
    def doctor_command(ctx: typer.Context, probe: bool = False):
        """Inspect capabilities; --probe runs disposable OS checks."""
        from .doctor import doctor

        _emit(ctx, _run(doctor(_host(ctx).store.root, probe=probe)))

    @app.command("plan")
    def plan_command(ctx: typer.Context, spec: Annotated[Path, typer.Option(exists=True)]):
        """Resolve a JSON/TOML environment request without allocation."""
        result = _run(_host(ctx).plan(_parse(_read_spec, spec)))
        _emit(ctx, result.to_dict())
        if not result.supported:
            raise typer.Exit(1)

    @app.command("run", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
    def run_command(
        ctx: typer.Context,
        command: Annotated[list[str], typer.Argument(help="Executable and arguments after --.")],
        spec: Path | None = None,
        cwd: Path | None = None,
        ttl: float | None = None,
        copy: list[str] | None = None,
        overlay: list[str] | None = None,
        read_only: list[str] | None = None,
        fresh: list[str] | None = None,
        memory: int | None = None,
        cpu: float | None = None,
    ):
        """Run a foreground command; --overlay asserts that its lower is stable."""
        request = _parse(_spec, spec, copy, overlay, read_only, fresh, ttl, memory, cpu)
        raise typer.Exit(_run(_foreground(_host(ctx), request, command, cwd)))

    @app.command("shell")
    def shell_command(
        ctx: typer.Context,
        spec: Path | None = None,
        cwd: Path | None = None,
        ttl: float | None = None,
        copy: list[str] | None = None,
        overlay: list[str] | None = None,
        read_only: list[str] | None = None,
        fresh: list[str] | None = None,
        memory: int | None = None,
        cpu: float | None = None,
    ):
        """Open bash using the existing terminal (no allocated PTY)."""
        request = _parse(_spec, spec, copy, overlay, read_only, fresh, ttl, memory, cpu)
        raise typer.Exit(_run(_foreground(_host(ctx), request, ["/bin/bash", "-i"], cwd)))

    @app.command("create")
    def create_command(
        ctx: typer.Context, spec: Annotated[Path, typer.Option(exists=True)], until_stopped: bool = False
    ):
        """Create and detach; requires a deadline or --until-stopped."""
        request = _parse(_read_spec, spec)

        async def operation():
            if request.lifetime.max_runtime is None and not until_stopped:
                raise ValueError("Detached creation needs a deadline or --until-stopped")
            environment = await _host(ctx).create(request)
            try:
                await environment.detach(until_stopped=until_stopped)
            except BaseException:
                await environment.stop("detach_failed")
                raise
            return {"id": environment.id, "paths": environment.paths, "evidence": environment.evidence_path}

        _emit(ctx, _run(operation()))

    @app.command("exec", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
    def exec_command(ctx: typer.Context, environment: str, command: list[str], cwd: Path | None = None):
        """Run another foreground command in a retained environment."""

        async def operation():
            owner = await _host(ctx).open(environment)
            child = await owner.spawn(command, cwd=cwd, stdout=None, stderr=None)
            try:
                result = await child.wait()
                return result.returncode if (result.returncode or 0) >= 0 else 128 + result.signal
            except BaseException:
                await child.stop_tree()
                raise

        raise typer.Exit(_run(operation()) or 0)

    @app.command("status")
    def status_command(ctx: typer.Context, environment: str):
        async def operation():
            return await (await _host(ctx).open(environment)).status()

        _emit(ctx, _run(operation()))

    @app.command("list")
    def list_command(ctx: typer.Context):
        _emit(ctx, _run(_host(ctx).list()))

    @app.command("usage")
    def usage_command(ctx: typer.Context):
        _emit(ctx, _run(_host(ctx).usage()))

    @app.command("stop")
    def stop_command(ctx: typer.Context, environment: str):
        async def operation():
            return await (await _host(ctx).open(environment)).stop()

        _emit(ctx, _run(operation()))

    @app.command("export")
    def export_command(
        ctx: typer.Context, environment: str, tree: str, destination: Annotated[Path | None, typer.Argument()] = None
    ):
        async def operation():
            return await (await _host(ctx).open(environment)).export(tree, destination)

        result = _run(operation())
        _emit(ctx, result)
        if result["state"] != "complete":
            raise typer.Exit(1)

    @app.command("reap")
    def reap_command(ctx: typer.Context, environment: str | None = None):
        _emit(ctx, _run(_host(ctx).reap(environment)))

    @app.command("finalize", hidden=True)
    def finalize_command(ctx: typer.Context, environment: str):
        _emit(ctx, _run(_host(ctx).reap(environment)))

    @app.command("gc")
    def gc_command(
        ctx: typer.Context,
        environment: str | None = None,
        force: bool = False,
        discard_incomplete: bool = False,
        reclamation_timeout: float | None = None,
    ):
        """Cull eligible stopped resources; --force overrides retention only."""
        _emit(
            ctx,
            _run(
                _host(ctx).gc(
                    environment,
                    force=force,
                    discard_incomplete=discard_incomplete,
                    reclamation_timeout=reclamation_timeout,
                )
            ),
        )

    @baseline_app.command("register")
    def register_command(ctx: typer.Context, name: str, path: Path, storage: str = "copy", stable: bool = True):
        _emit(ctx, _run(_host(ctx).register_baseline(name, path, storage=storage, stable=stable)))

    @baseline_app.command("list")
    def baselines_command(ctx: typer.Context):
        _emit(ctx, _host(ctx).store.baselines())

    def support_operation(ctx, action, unit_dir, python_executable, force=False):
        from . import support

        host = _host(ctx)
        kwargs = {"unit_dir": unit_dir, "python_executable": python_executable}
        if action == "uninstall":
            kwargs.update(
                active_runs=[
                    record["id"] for record in host.store.environments() if record["state"] not in ("stopped", "purged")
                ],
                force=force,
            )
        _emit(ctx, _run(getattr(support, action)(host.store.root, **kwargs)))

    @support_app.command("plan")
    def support_plan(ctx: typer.Context, unit_dir: Path | None = None, python_executable: Path | None = None):
        support_operation(ctx, "plan", unit_dir, python_executable)

    @support_app.command("install")
    def support_install(ctx: typer.Context, unit_dir: Path | None = None, python_executable: Path | None = None):
        support_operation(ctx, "install", unit_dir, python_executable)

    @support_app.command("status")
    def support_status(ctx: typer.Context, unit_dir: Path | None = None, python_executable: Path | None = None):
        support_operation(ctx, "status", unit_dir, python_executable)

    @support_app.command("uninstall")
    def support_uninstall(
        ctx: typer.Context, unit_dir: Path | None = None, python_executable: Path | None = None, force: bool = False
    ):
        support_operation(ctx, "uninstall", unit_dir, python_executable, force)

    return app


app = create_app()

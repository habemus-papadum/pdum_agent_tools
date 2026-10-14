"""Mountable Typer commands delegating to the async Claude launcher library."""

from __future__ import annotations

import asyncio
import json
import sys
from contextlib import AsyncExitStack, nullcontext
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Annotated, Any
from urllib.request import Request, urlopen

import questionary
import typer
from rich.console import Console
from rich.table import Table
from typer.core import TyperGroup

from .authentication import AuthSpec, auth_status, auth_warnings, login_auth
from .errors import LauncherError
from .observation import JsonlRecorder, ObservationHub, UsageObserver
from .profiles import (
    Profile,
    create_profile,
    list_profiles,
    load_profile,
    resolve_profile,
    temporary_profile,
)
from .runtime import ClaudeManager
from .storage import History

console = Console(stderr=True)


class _CommandGroup(TyperGroup):
    def invoke(self, ctx):
        try:
            return super().invoke(ctx)
        except (LauncherError, ValueError, OSError) as error:
            console.print(str(error), style="red", markup=False)
            raise typer.Exit(1) from None


@dataclass
class _Selection:
    name: str | None
    directory: Path | None
    root: Path | None

    def directory_for(self, name: str | None = None) -> Path:
        return resolve_profile(name or self.name, self.directory, self.root)

    def load(self) -> Profile:
        return load_profile(self.directory_for())


def _json(value: Any) -> None:
    typer.echo(json.dumps(value, indent=2, default=str))


def _run(awaitable):
    try:
        return asyncio.run(awaitable)
    except (LauncherError, ValueError, OSError, RuntimeError) as error:
        console.print(str(error), style="red", markup=False)
        raise typer.Exit(1) from None


def _warn(profile: Profile) -> None:
    for warning in auth_warnings(profile.auth):
        console.print(warning, style="yellow", markup=False)


def _describe(profile: Profile) -> dict[str, Any]:
    return {
        "name": profile.directory.name,
        "directory": str(profile.directory),
        "config_directory": str(profile.config_directory),
        "workspace": str(profile.workspace),
        "executable": profile.executable,
        "model": profile.model,
        "setting_sources": profile.setting_sources,
        "authentication": asdict(profile.auth),
    }


def _interview(model: str, auth: str, sources: str) -> tuple[str, str, str] | None:
    """Collect choices only; cancellation never writes or starts authentication."""
    method = questionary.select(
        "Authentication",
        choices=[
            questionary.Choice("Dedicated Claude account login", "native"),
            questionary.Choice("API key from an environment variable", "api-key"),
            questionary.Choice("Reuse existing login for debugging", "reuse-login"),
        ],
        default=auth,
    ).ask()
    if method is None:
        return None
    selected_model = questionary.text("Default model", default=model).ask()
    if selected_model is None:
        return None
    selected_sources = questionary.checkbox(
        "Native settings sources",
        choices=[
            questionary.Choice(source, checked=source in sources.split(",")) for source in ("user", "project", "local")
        ],
    ).ask()
    if selected_sources is None:
        return None
    return selected_model, method, ",".join(selected_sources)


async def _serve(
    profiles: dict[str, Profile],
    host: str,
    port: int,
    record: Path | None,
    mitm: bool,
    capture_directory: Path | None,
    capture: bool,
    example_directory: Path | None,
) -> None:
    try:
        import uvicorn
    except ImportError:
        raise RuntimeError("Install habemus-papadum-claude-launcher[management] to launch the HTTP service") from None
    from .management import create_app

    usage = UsageObserver()
    processors = (usage,) if record is None else (usage, JsonlRecorder(record))
    hub = ObservationHub(processors)
    manager: ClaudeManager | None = None
    await hub.start()
    try:
        async with AsyncExitStack() as stack:
            worker_environment: dict[str, str] = {}
            if mitm:
                try:
                    from pdum.mitm import SidecarConfig, open_sidecar
                except ImportError:
                    raise RuntimeError("Install habemus-papadum-claude-launcher[mitm] for interception") from None
                proxy = await stack.enter_async_context(
                    open_sidecar(SidecarConfig(capture_dir=capture_directory or Path("artifacts/claude-mitm")))
                )
                worker_environment = proxy.connection.environment({}, trust="node")
                await proxy.configure_capture(capture)
                console.print(f"MITM: {proxy.connection.proxy_url}; recording {'on' if capture else 'off'}")
            manager = await stack.enter_async_context(ClaudeManager(profiles, observer=hub.emit))
            application = create_app(
                manager,
                observer=hub,
                usage=usage,
                worker_environment=worker_environment,
                example_directory=example_directory,
            )
            server = uvicorn.Server(
                uvicorn.Config(
                    application,
                    host=host,
                    port=port,
                    ws="websockets",
                    ws_max_size=None,
                    ws_max_queue=None,
                    ws_ping_interval=20,
                    ws_ping_timeout=20,
                    timeout_graceful_shutdown=5,
                    log_level="warning",
                )
            )
            with server.config.bind_socket() as listener:
                bound_port = listener.getsockname()[1]
                url_host = f"[{host}]" if ":" in host else host
                console.print(
                    f"Claude manager: http://{url_host}:{bound_port}; profiles: {', '.join(profiles)}", markup=False
                )
                console.print(
                    "Workers start on SDK attachment and stop on client disconnect. Ctrl-C stops the manager."
                )
                await server.serve(sockets=[listener])
    finally:
        await hub.close()
        if manager is not None:
            for worker in manager.list_workers():
                if worker["cleanup_errors"]:
                    console.print(
                        f"Incomplete worker cleanup: {worker['id']} (PID {worker['pid']}); inspect owned processes.",
                        style="yellow",
                    )
        if any(status["lost"] or status["error"] for status in hub.status()):
            console.print(f"Observation failures: {hub.status()}", markup=False)


def create_app() -> typer.Typer:
    """Return a fresh mountable CLI without processes or installed signal handlers."""
    application = typer.Typer(
        help="Manage isolated Claude profiles and official SDK client sessions.", cls=_CommandGroup
    )
    profiles_app = typer.Typer(help="Create and inspect isolated profiles.")
    auth_app = typer.Typer(help="Host-side native login and authentication status.")
    sessions_app = typer.Typer(help="Saved conversations through official SDK helpers.")
    application.add_typer(profiles_app, name="profile")
    application.add_typer(auth_app, name="auth")
    application.add_typer(sessions_app, name="sessions")

    @application.callback()
    def select(
        ctx: typer.Context,
        profile: Annotated[str | None, typer.Option("--profile")] = None,
        profile_dir: Annotated[Path | None, typer.Option("--profile-dir")] = None,
        profiles_dir: Annotated[Path | None, typer.Option("--profiles-dir")] = None,
    ):
        if profile_dir is not None and (profile is not None or profiles_dir is not None):
            raise typer.BadParameter("--profile-dir cannot be combined with --profile or --profiles-dir")
        ctx.obj = _Selection(profile, profile_dir, profiles_dir)

    @profiles_app.command("create")
    def create(
        ctx: typer.Context,
        name: Annotated[str | None, typer.Argument()] = None,
        workspace: Path | None = None,
        executable: str = "claude",
        model: str = "haiku",
        auth: str = "native",
        api_key_env: str = "ANTHROPIC_API_KEY",
        source_directory: Path | None = None,
        setting_sources: str = "user,project",
        native_settings: Path | None = None,
        no_interview: bool = False,
        login: bool = False,
    ):
        """Preview and create a profile, optionally followed by native login."""
        selection: _Selection = ctx.obj
        try:
            if login and auth != "native":
                raise ValueError("--login requires --auth native")
            directory = selection.directory_for(name)
            interactive = not no_interview and sys.stdin.isatty() and sys.stdout.isatty()
            if interactive:
                answers = _interview(model, auth, setting_sources)
                if answers is None:
                    raise typer.Exit(0)
                model, auth, setting_sources = answers
            draft = Profile(
                directory,
                workspace or Path.cwd(),
                executable,
                model,
                tuple(source for source in setting_sources.split(",") if source),
                AuthSpec(auth, api_key_env, source_directory),
            )
            _json(_describe(draft))
            if interactive and not questionary.confirm("Create this profile?", default=True).ask():
                raise typer.Exit(0)
            if login and draft.auth.method != "native":
                raise ValueError("--login requires native authentication")
            saved = create_profile(
                directory,
                workspace=draft.workspace,
                executable=draft.executable,
                model=draft.model,
                setting_sources=draft.setting_sources,
                auth=draft.auth,
                native_settings=native_settings,
            )
            _warn(saved)
            if login:
                _run(login_auth(saved))
        except (LauncherError, ValueError, OSError) as error:
            console.print(str(error), style="red", markup=False)
            raise typer.Exit(1) from None

    @profiles_app.command("list")
    def list_command(ctx: typer.Context, json_output: Annotated[bool, typer.Option("--json")] = False):
        selected = list_profiles(ctx.obj.root)
        if json_output:
            _json([_describe(profile) for profile in selected])
            return
        table = Table("Profile", "Workspace", "Authentication", "Model")
        for profile in selected:
            table.add_row(profile.directory.name, str(profile.workspace), profile.auth.method, profile.model)
        Console().print(table)

    @profiles_app.command("show")
    def show(ctx: typer.Context):
        _json(_describe(ctx.obj.load()))

    @auth_app.command("login")
    def login_command(ctx: typer.Context):
        _run(login_auth(ctx.obj.load()))

    @auth_app.command("status")
    def auth_status_command(ctx: typer.Context):
        _json(asdict(_run(auth_status(ctx.obj.load()))))

    @application.command("launch")
    def launch_command(
        ctx: typer.Context,
        host: str = "0.0.0.0",
        port: int = 8765,
        all_profiles: bool = False,
        temp: bool = False,
        workspace: Path | None = None,
        executable: str = "claude",
        model: str = "haiku",
        auth: str = "reuse-login",
        record: Path | None = None,
        mitm: bool = False,
        capture_dir: Path | None = None,
        capture: bool = False,
        example_dir: Path | None = None,
    ):
        """Run the foreground manager; clients allocate and connect their workers."""
        selection: _Selection = ctx.obj
        if sum((temp, all_profiles, bool(selection.name or selection.directory))) != 1:
            raise typer.BadParameter("Select exactly one of --temp, --all-profiles, or a profile")
        if capture and not mitm:
            raise typer.BadParameter("--capture requires --mitm")
        scope = (
            temporary_profile(
                workspace=workspace or Path.cwd(), executable=executable, model=model, auth=AuthSpec(auth)
            )
            if temp
            else nullcontext(None)
        )
        with scope as temporary:
            selected = (
                (temporary,)
                if temporary is not None
                else list_profiles(selection.root)
                if all_profiles
                else (selection.load(),)
            )
            if not selected:
                raise typer.BadParameter("No profiles found; create a profile first")
            for profile in selected:
                _warn(profile)
            _run(
                _serve(
                    {profile.directory.name: profile for profile in selected},
                    host,
                    port,
                    record,
                    mitm,
                    capture_dir,
                    capture,
                    example_dir,
                )
            )

    @application.command("status")
    def status_command(endpoint: str = "http://127.0.0.1:8765"):
        """Inspect workers and observation health in a running manager."""
        _json(_request(endpoint, "/api/status"))

    @application.command("stop")
    def stop_command(worker_id: str, endpoint: str = "http://127.0.0.1:8765"):
        """Stop one manager-owned worker without affecting other profile clients."""
        from urllib.parse import quote

        _json(_request(endpoint, f"/api/workers/{quote(worker_id, safe='')}", method="DELETE"))

    async def saved_operation(profile: Profile, operation: str, *args, **kwargs):
        history = History(profile)
        try:
            return await getattr(history, operation)(*args, **kwargs)
        finally:
            await history.close()

    @sessions_app.command("list")
    def list_sessions(ctx: typer.Context):
        _json(_run(saved_operation(ctx.obj.load(), "list")))

    @sessions_app.command("read")
    def read_session(ctx: typer.Context, session_id: str):
        _json(_run(saved_operation(ctx.obj.load(), "read", session_id)))

    @sessions_app.command("rename")
    def rename_session(ctx: typer.Context, session_id: str, title: str):
        _json(_run(saved_operation(ctx.obj.load(), "rename", session_id, title)))

    @sessions_app.command("fork")
    def fork_session(
        ctx: typer.Context, session_id: str, title: str | None = None, up_to_message_id: str | None = None
    ):
        _json(_run(saved_operation(ctx.obj.load(), "fork", session_id, title=title, up_to_message_id=up_to_message_id)))

    return application


def _request(endpoint: str, path: str, *, method: str = "GET"):
    try:
        with urlopen(Request(endpoint.rstrip("/") + path, method=method), timeout=15) as response:
            return json.load(response)
    except OSError as error:
        console.print(f"Management request failed: {type(error).__name__}")
        raise typer.Exit(1) from None


app = create_app()

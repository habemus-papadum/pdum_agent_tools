"""Standalone and mountable Typer commands over the async launcher library."""

from __future__ import annotations

import asyncio
import json
import signal
import sys
import tomllib
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Annotated, Any

import typer

from .authentication import AuthSpec, inspect_auth, login_auth
from .config import read_config, resolve_executable
from .errors import LauncherError, ProfileError
from .federation import federation_from_settings
from .imports import ImportSelection, Selection, inventory_source
from .observation import JsonlRecorder, discover_processors, load_processor
from .profiles import (
    ProfileSpec,
    configure_api_key,
    default_profiles_directory,
    inspect_profile,
    list_profiles,
    resolve_profile,
    temporary_profile,
)
from .runtime import LaunchOptions, configure_profile_capture, launch, login_chatgpt, profile_status, stop_profile
from .workflow import ProfileEdit, load_profile_draft, prepare_edit, save_profile_edit


@dataclass
class _Selection:
    name: str | None
    directory: Path | None
    root: Path | None
    json_output: bool

    def path(self) -> Path:
        return resolve_profile(self.name, self.directory, self.root)


def _emit(value: Any) -> None:
    typer.echo(json.dumps(value, default=str, indent=2))


def _run(operation: Awaitable[Any]) -> Any:
    try:
        return asyncio.run(operation)
    except (LauncherError, OSError, ValueError) as error:
        typer.echo(f"Error: {error}", err=True)
        raise typer.Exit(1) from error


def _warn(info: Any) -> None:
    for warning in info.warnings:
        typer.echo(f"Warning: {warning}", err=True)


def _choices(values: list[str] | None) -> Selection:
    if values is None:
        return "all"
    if values == ["all"] or values == ["none"]:
        return values[0]
    return tuple(values)


def _auth_spec(method: str, env: str, base_url: str | None, settings: Path | None) -> AuthSpec:
    if method not in {"preserve", "chatgpt", "api-key", "aws-federation"}:
        raise ProfileError("--auth must be preserve, chatgpt, api-key, or aws-federation")
    if settings is not None and method != "aws-federation":
        raise ProfileError("--federation-settings requires --auth aws-federation")
    federation = federation_from_settings(tomllib.loads(settings.read_text())) if settings is not None else None
    return AuthSpec(method, env, base_url, federation)


async def _profile_edit(
    directory: Path,
    edit: ProfileEdit,
    *,
    source: Path | None = None,
    clean: bool = False,
    existing: bool = False,
    interactive: bool | None = None,
    json_output: bool = False,
    auth_only: bool = False,
    device_auth: bool = False,
) -> None:
    draft = await load_profile_draft(directory, source=source, clean=clean, existing=existing)
    use_interview = interactive if interactive is not None else sys.stdin.isatty() and not json_output
    if use_interview:
        if json_output:
            raise ProfileError("--interview cannot be combined with --json; use --no-interview")
        from .interview import interview

        selected = await interview(draft, auth_only=auth_only, initial=edit)
        if selected is None:
            typer.echo("Cancelled; profile unchanged.", err=True)
            raise typer.Exit(1)
        edit = selected
    prepared = await asyncio.to_thread(prepare_edit, draft, edit)
    info = await save_profile_edit(prepared)
    _warn(info)
    _emit(asdict(info))
    if edit.login_after:
        if json_output:
            typer.echo("Login runs interactively after saving; its output is not JSON.", err=True)
        status = await login_auth(directory, device_auth=device_auth)
        if status:
            typer.echo("Profile saved, but login did not complete. Retry with auth login.", err=True)
            raise typer.Exit(status)


def create_app(extensions: Sequence[Callable[[typer.Typer], None]] = ()) -> typer.Typer:
    """Create an independent, mountable CLI without starting any runtime.

    Parameters
    ----------
    extensions : sequence of callables
        Explicitly selected functions that register provider commands on this app.

    Returns
    -------
    typer.Typer
        Fresh command tree, suitable for ``parent.add_typer(...)``.
    """
    application = typer.Typer(
        help="Directory-based Codex app-server profiles and foreground launch.", no_args_is_help=True
    )
    profiles_app = typer.Typer(help="Create and inspect self-contained profiles.", no_args_is_help=True)
    auth_app = typer.Typer(help="Configure native upstream authentication.", no_args_is_help=True)
    application.add_typer(profiles_app, name="profile")
    application.add_typer(auth_app, name="auth")

    @application.callback()
    def configure(
        context: typer.Context,
        profile: Annotated[str | None, typer.Option("--profile")] = None,
        profile_dir: Annotated[Path | None, typer.Option("--profile-dir")] = None,
        profiles_dir: Annotated[Path | None, typer.Option("--profiles-dir")] = None,
        json_output: Annotated[bool, typer.Option("--json")] = False,
    ) -> None:
        if profile_dir is not None and (profile is not None or profiles_dir is not None):
            raise typer.BadParameter("--profile-dir is exclusive of --profile and --profiles-dir")
        context.obj = _Selection(profile, profile_dir, profiles_dir, json_output)

    @profiles_app.command("create")
    def create(
        context: typer.Context,
        name: Annotated[str | None, typer.Argument()] = None,
        executable: Annotated[Path | None, typer.Option()] = None,
        model: Annotated[str | None, typer.Option()] = None,
        from_profile_dir: Annotated[Path | None, typer.Option()] = None,
        from_codex_home: Annotated[Path | None, typer.Option()] = None,
        clean: Annotated[bool, typer.Option()] = False,
        copy_auth: Annotated[bool, typer.Option()] = False,
        interactive: Annotated[bool | None, typer.Option("--interview/--no-interview")] = None,
        marketplace: Annotated[list[str] | None, typer.Option(help="Repeat names, or all/none")] = None,
        plugin: Annotated[list[str] | None, typer.Option(help="Repeat plugin@marketplace, or all/none")] = None,
        mcp_server: Annotated[list[str] | None, typer.Option(help="Repeat names, or all/none")] = None,
        skill: Annotated[list[str] | None, typer.Option(help="Repeat inventory IDs, or all/none")] = None,
        auth: Annotated[str, typer.Option()] = "preserve",
        api_key_env: Annotated[str, typer.Option()] = "OPENAI_API_KEY",
        auth_base_url: Annotated[str | None, typer.Option()] = None,
        federation_settings: Annotated[Path | None, typer.Option(help="Nonsecret FederationSpec TOML")] = None,
        login: Annotated[bool, typer.Option()] = False,
        device_auth: Annotated[bool, typer.Option()] = False,
    ) -> None:
        selection = context.obj

        async def execute() -> None:
            if name is not None and (selection.name is not None or selection.directory is not None):
                raise ProfileError("Choose a positional name or a global profile selector, not both")
            path = resolve_profile(name or selection.name, selection.directory, selection.root)
            if from_profile_dir is not None and from_codex_home is not None:
                raise ProfileError("Choose --from-profile-dir or --from-codex-home, not both")
            if clean and copy_auth:
                raise ProfileError("--clean does not copy source credentials")
            edit = ProfileEdit(
                selection=ImportSelection(*map(_choices, (marketplace, plugin, mcp_server, skill))),
                executable=executable,
                model=model,
                copy_auth=copy_auth,
                auth=_auth_spec(auth, api_key_env, auth_base_url, federation_settings),
                login_after=login,
            )
            await _profile_edit(
                path,
                edit,
                source=from_profile_dir or from_codex_home,
                clean=clean,
                interactive=interactive,
                json_output=selection.json_output,
                device_auth=device_auth,
            )

        _run(execute())

    @profiles_app.command("configure")
    def configure_existing(
        context: typer.Context,
        executable: Annotated[Path | None, typer.Option()] = None,
        model: Annotated[str | None, typer.Option()] = None,
        interactive: Annotated[bool | None, typer.Option("--interview/--no-interview")] = None,
        marketplace: Annotated[list[str] | None, typer.Option()] = None,
        plugin: Annotated[list[str] | None, typer.Option()] = None,
        mcp_server: Annotated[list[str] | None, typer.Option()] = None,
        skill: Annotated[list[str] | None, typer.Option()] = None,
        auth: Annotated[str, typer.Option()] = "preserve",
        api_key_env: Annotated[str, typer.Option()] = "OPENAI_API_KEY",
        auth_base_url: Annotated[str | None, typer.Option()] = None,
        federation_settings: Annotated[Path | None, typer.Option()] = None,
        login: Annotated[bool, typer.Option()] = False,
        device_auth: Annotated[bool, typer.Option()] = False,
    ) -> None:
        async def execute() -> None:
            edit = ProfileEdit(
                selection=ImportSelection(*map(_choices, (marketplace, plugin, mcp_server, skill))),
                executable=executable,
                model=model,
                auth=_auth_spec(auth, api_key_env, auth_base_url, federation_settings),
                login_after=login,
            )
            await _profile_edit(
                context.obj.path(),
                edit,
                existing=True,
                interactive=interactive,
                json_output=context.obj.json_output,
                device_auth=device_auth,
            )

        _run(execute())

    @auth_app.command("configure")
    def configure_auth(
        context: typer.Context,
        method: Annotated[str, typer.Option("--method")] = "preserve",
        env: Annotated[str, typer.Option("--env")] = "OPENAI_API_KEY",
        base_url: Annotated[str | None, typer.Option()] = None,
        federation_settings: Annotated[Path | None, typer.Option()] = None,
        interactive: Annotated[bool | None, typer.Option("--interview/--no-interview")] = None,
        login: Annotated[bool, typer.Option()] = False,
        device_auth: Annotated[bool, typer.Option()] = False,
    ) -> None:
        async def execute() -> None:
            edit = ProfileEdit(
                auth=_auth_spec(method, env, base_url, federation_settings),
                login_after=login,
                import_assets=False,
            )
            await _profile_edit(
                context.obj.path(),
                edit,
                existing=True,
                interactive=interactive,
                json_output=context.obj.json_output,
                auth_only=True,
                device_auth=device_auth,
            )

        _run(execute())

    @auth_app.command("status")
    def auth_status(context: typer.Context) -> None:
        async def execute() -> None:
            draft = await load_profile_draft(context.obj.path(), existing=True)
            inspection = inspect_auth(draft.native_toml, draft.launcher_toml, draft.directory)
            _warn(inspection)
            _emit(
                {
                    "method": inspection.spec.method,
                    "summary": inspection.summary,
                    "auth_file_present": draft.inventory.auth_file is not None,
                    "authenticated": "not checked",
                }
            )

        _run(execute())

    @auth_app.command("login")
    def auth_login(
        context: typer.Context,
        device_auth: Annotated[bool, typer.Option()] = False,
    ) -> None:
        raise typer.Exit(_run(login_auth(context.obj.path(), device_auth=device_auth)))

    @profiles_app.command("list")
    def list_command(context: typer.Context) -> None:
        async def execute() -> None:
            profiles = await list_profiles(context.obj.root or default_profiles_directory())
            _emit([asdict(profile) for profile in profiles])

        _run(execute())

    @profiles_app.command("inventory")
    def inventory(source: Annotated[Path | None, typer.Option()] = None) -> None:
        async def execute() -> None:
            found = await asyncio.to_thread(inventory_source, source)
            _warn(found)
            _emit(
                {
                    name: [{"id": item.id, "label": item.label} for item in getattr(found, name)]
                    for name in ("marketplaces", "plugins", "mcp_servers", "skills")
                }
            )

        _run(execute())

    @profiles_app.command("show")
    def show(context: typer.Context) -> None:
        async def execute() -> None:
            _emit(asdict(await inspect_profile(context.obj.path())))

        _run(execute())

    @application.command("status")
    def status(context: typer.Context) -> None:
        async def execute() -> None:
            _emit(await profile_status(context.obj.path()))

        _run(execute())

    @application.command("stop")
    def stop(context: typer.Context) -> None:
        async def execute() -> None:
            _emit(await stop_profile(context.obj.path()))

        _run(execute())

    @auth_app.command("configure-api-key")
    def api_key(
        context: typer.Context,
        env: Annotated[str, typer.Option("--env")],
        base_url: Annotated[str | None, typer.Option()] = None,
    ) -> None:
        async def execute() -> None:
            await configure_api_key(context.obj.path(), env, base_url)
            _emit({"configured": True, "environment_variable": env})

        _run(execute())

    @auth_app.command("login-chatgpt")
    def login(
        context: typer.Context,
        device_auth: Annotated[bool, typer.Option()] = False,
    ) -> None:
        async def execute() -> int:
            return await login_chatgpt(context.obj.path(), device_auth=device_auth)

        raise typer.Exit(_run(execute()))

    @application.command("processors")
    def processors() -> None:
        _emit(discover_processors())

    @application.command("capture")
    def capture(
        context: typer.Context,
        state: Annotated[str, typer.Argument(help="on or off")],
        revision: Annotated[int | None, typer.Option()] = None,
    ) -> None:
        if state not in {"on", "off"}:
            raise typer.BadParameter("Capture state must be on or off")

        async def execute() -> None:
            _emit(await configure_profile_capture(context.obj.path(), state == "on", expected_revision=revision))

        _run(execute())

    @application.command("launch")
    def launch_command(
        context: typer.Context,
        temp: Annotated[bool, typer.Option()] = False,
        clean: Annotated[bool, typer.Option()] = False,
        keep_temp: Annotated[bool, typer.Option()] = False,
        no_auth_copy: Annotated[bool, typer.Option()] = False,
        from_profile_dir: Annotated[Path | None, typer.Option()] = None,
        model: Annotated[str | None, typer.Option()] = None,
        executable: Annotated[Path | None, typer.Option()] = None,
        host: Annotated[str | None, typer.Option()] = None,
        port: Annotated[int | None, typer.Option(min=0, max=65535)] = None,
        direct: Annotated[bool, typer.Option(help="Expose only the native private Unix endpoint.")] = False,
        inherit_environment: Annotated[bool, typer.Option()] = False,
        record: Annotated[Path | None, typer.Option(help="Record client relay messages to a new JSONL file.")] = None,
        processor: Annotated[list[str] | None, typer.Option(help="Installed processor name or module:factory.")] = None,
        mitm: Annotated[bool, typer.Option(help="Launch an optional upstream interception sidecar.")] = False,
        capture_dir: Annotated[Path | None, typer.Option(help="Parent directory for upstream capture runs.")] = None,
        capture: Annotated[bool, typer.Option(help="Start MITM recording immediately.")] = False,
        dry_run: Annotated[bool, typer.Option()] = False,
    ) -> None:
        selection = context.obj

        async def execute() -> None:
            if temp and (selection.name is not None or selection.directory is not None):
                raise ProfileError("--temp cannot select a persistent target profile")
            if not temp and any((clean, keep_temp, no_auth_copy, from_profile_dir is not None, model is not None)):
                raise ProfileError(
                    "Temporary creation options require --temp; edit persistent native config explicitly"
                )
            if direct and (record is not None or processor or host is not None or port is not None):
                raise ProfileError("Relay recording, processors and TCP options cannot be used with --direct")
            if temp and dry_run:
                raise ProfileError(
                    "--dry-run currently requires an existing profile and does not create temporary state"
                )
            if not mitm and (capture_dir is not None or capture):
                raise ProfileError("--capture-dir and --capture require --mitm")
            if capture and capture_dir is None:
                raise ProfileError("--capture requires --capture-dir")
            sidecar_config = None
            if mitm:
                try:
                    from pdum.mitm import SidecarConfig
                except ImportError as error:
                    raise ProfileError("Install habemus-papadum-codex-launcher[mitm] for --mitm") from error
                sidecar_config = SidecarConfig(capture_dir=capture_dir, recording=capture)
            chosen_processors = [load_processor(reference) for reference in processor or ()]
            if record is not None:
                chosen_processors.append(JsonlRecorder(record))
            options = LaunchOptions(
                executable=executable,
                relay=not direct,
                host=host,
                port=port,
                processors=tuple(chosen_processors),
                environment_mode="inherit" if inherit_environment else None,
                mitm_config=sidecar_config,
            )

            async def run_profile(path: Path) -> None:
                if dry_run:
                    config = await asyncio.to_thread(read_config, path)
                    _emit(
                        {
                            "profile": path,
                            "executable": resolve_executable(executable or config.executable, path),
                            "relay": not direct,
                            "host": host if host is not None else config.host,
                            "port": port if port is not None else config.port,
                            "environment_mode": options.environment_mode or config.environment_mode,
                            "environment_keys": sorted(config.environment),
                        }
                    )
                    return
                async with launch(path, options) as server:
                    _emit(await server.status())
                    await server.wait()

            if temp:
                specification = ProfileSpec(executable=executable, model=model, source=from_profile_dir)
                async with temporary_profile(
                    specification, clean=clean, copy_auth=not no_auth_copy, keep=keep_temp
                ) as info:
                    _warn(info)
                    typer.echo(f"Temporary profile: {info.directory}", err=True)
                    await run_profile(info.directory)
            else:
                await run_profile(selection.path())

        async def foreground() -> None:
            loop = asyncio.get_running_loop()
            task = asyncio.current_task()
            previous = signal.getsignal(signal.SIGTERM)
            loop.add_signal_handler(signal.SIGTERM, task.cancel)
            try:
                await execute()
            finally:
                loop.remove_signal_handler(signal.SIGTERM)
                signal.signal(signal.SIGTERM, previous)

        try:
            _run(foreground())
        except asyncio.CancelledError:
            raise typer.Exit(143) from None
        except KeyboardInterrupt:
            raise typer.Exit(130) from None

    for extension in extensions:
        extension(application)
    names = [command.name or command.callback.__name__.replace("_", "-") for command in application.registered_commands]
    names.extend(group.name for group in application.registered_groups)
    if len(names) != len(set(names)):
        raise ValueError("CLI extensions registered conflicting command names")
    return application


app = create_app()

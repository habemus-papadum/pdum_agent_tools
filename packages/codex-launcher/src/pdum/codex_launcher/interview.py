"""Optional interactive CLI workflow, kept separate from profile mutations."""

from __future__ import annotations

import asyncio
import difflib
import os
import tomllib
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

import click
import questionary
from rich.console import Console
from rich.syntax import Syntax

from .authentication import AuthSpec, inspect_auth
from .errors import ProfileError
from .federation import DEFAULT_AUDIENCE, FederationSpec
from .imports import ImportChoice, ImportSelection, Selection

if TYPE_CHECKING:
    from .workflow import ProfileDraft, ProfileEdit


class _Cancelled(Exception):
    pass


async def _ask(question) -> Any:
    result = await question.ask_async()
    if result is None:
        raise _Cancelled
    return result


async def _text(message: str, default: str = "", *, required: bool = False) -> str:
    validation = (lambda value: bool(value.strip()) or "A value is required") if required else None
    return (await _ask(questionary.text(message, default=default, validate=validation))).strip()


async def _category(label: str, choices: tuple[ImportChoice, ...], current: Selection) -> Selection:
    if not choices:
        return current
    default = current if isinstance(current, str) else "individual"
    mode = await _ask(
        questionary.select(
            f"Import {label} ({len(choices)} available)?",
            choices=[
                questionary.Choice("All", value="all"),
                questionary.Choice("None", value="none"),
                questionary.Choice("Choose individual entries", value="individual"),
            ],
            default=default,
        )
    )
    if mode != "individual":
        return mode
    selected = {choice.id for choice in choices} if current == "all" else set(current) if current != "none" else set()
    result = await _ask(
        questionary.checkbox(
            f"Select {label} (Space toggles, Enter accepts)",
            choices=[
                questionary.Choice(choice.label, value=choice.id, checked=choice.id in selected) for choice in choices
            ],
        )
    )
    return tuple(result)


async def _federation(current: FederationSpec | None, console: Console) -> FederationSpec:
    console.print(
        "AWS federation needs an existing OpenAI identity-provider/service-account mapping. "
        "The AWS credential context stays separate from the isolated Codex home."
    )
    region = await _text(
        "AWS region",
        current.region if current else os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1")),
        required=True,
    )
    profile = await _text(
        "AWS profile (blank uses the native credential chain)", current.aws_profile or "" if current else ""
    )
    identity_provider = await _text(
        "OpenAI identity-provider ID", current.identity_provider_id if current else "", required=True
    )
    service_account = await _text(
        "OpenAI service-account ID", current.service_account_id if current else "", required=True
    )
    audience = await _text("Audience", current.audience if current else DEFAULT_AUDIENCE, required=True)
    home = await _text(
        "AWS home (configuration and login caches)",
        str(current.aws_home or Path.home()) if current else str(Path.home()),
        required=True,
    )
    login_method = await _ask(
        questionary.select(
            "AWS login command",
            choices=[
                questionary.Choice("aws sso login", value="sso"),
                questionary.Choice("aws login", value="login"),
                questionary.Choice("No interactive login (credentials supplied externally)", value="none"),
            ],
            default=current.login_method if current else "sso",
        )
    )
    result = replace(
        current or FederationSpec(region, identity_provider, service_account),
        region=region,
        aws_profile=profile or None,
        identity_provider_id=identity_provider,
        service_account_id=service_account,
        audience=audience,
        aws_home=Path(home).expanduser().absolute(),
        login_method=login_method,
    )
    if not await _ask(questionary.confirm("Edit advanced AWS/helper settings?", default=False)):
        return result
    changes = {}
    for attribute, title in (
        ("aws_config_file", "AWS config file (blank uses the native default)"),
        ("aws_credentials_file", "AWS shared credentials file (blank uses the native default)"),
        ("aws_login_cache_directory", "AWS login cache directory (blank uses the native default)"),
    ):
        existing = getattr(result, attribute)
        value = await _text(title, str(existing) if existing else "")
        changes[attribute] = Path(value).expanduser().absolute() if value else None
    changes["aws_executable"] = await _text("AWS executable", result.aws_executable, required=True)
    changes["client_id"] = await _text("Optional OpenAI OAuth client ID", result.client_id or "") or None
    for attribute, title, cast in (
        ("refresh_interval_seconds", "Credential refresh interval in seconds", int),
        ("timeout_seconds", "AWS/exchange timeout in seconds", float),
    ):
        while True:
            value = await _text(title, str(getattr(result, attribute)), required=True)
            try:
                changes[attribute] = cast(value)
                if changes[attribute] > 0:
                    break
            except ValueError:
                pass
            console.print("Enter a positive number.", style="yellow")
    return replace(result, **changes)


async def _authentication(draft: ProfileDraft, initial: AuthSpec, console: Console) -> tuple[AuthSpec, str]:
    inspection_directory = draft.inventory.source_directory if draft.inventory.is_profile else draft.directory
    inspection = inspect_auth(draft.native_toml, draft.launcher_toml, inspection_directory)
    console.print(f"Current authentication: {inspection.summary}", markup=False)
    for warning in inspection.warnings:
        console.print(warning, style="yellow", markup=False)
    method = await _ask(
        questionary.select(
            "Authentication method",
            choices=[
                questionary.Choice("Preserve native authentication settings", value="preserve"),
                questionary.Choice("ChatGPT login", value="chatgpt"),
                questionary.Choice("API key from an environment variable", value="api-key"),
                questionary.Choice("AWS → OpenAI API workload federation", value="aws-federation"),
            ],
            default=initial.method,
        )
    )
    defaults = initial if initial.method == method else inspection.spec
    if method == "api-key":
        variable = await _text("API-key environment variable name (not the key)", defaults.api_key_env, required=True)
        endpoint = await _text("Responses API base URL (blank uses OpenAI)", defaults.base_url or "")
        return AuthSpec("api-key", api_key_env=variable, base_url=endpoint or None), method
    if method == "aws-federation":
        federation = await _federation(defaults.federation, console)
        endpoint = await _text("Responses API base URL (blank uses OpenAI)", defaults.base_url or "")
        return AuthSpec("aws-federation", base_url=endpoint or None, federation=federation), method
    return AuthSpec(method), inspection.spec.method if method == "preserve" else method


def _page(console: Console, content: str, language: str) -> None:
    with console.pager(styles=True):
        console.print(Syntax(content or "# No remaining settings\n", language, word_wrap=True))


def _diff(before_native: str, before_launcher: str, native: str, launcher: str) -> str:
    chunks = []
    for name, previous, current in (
        ("codex/config.toml", before_native, native),
        ("launcher.toml", before_launcher, launcher),
    ):
        chunks.extend(
            difflib.unified_diff(
                previous.splitlines(keepends=True),
                current.splitlines(keepends=True),
                fromfile=f"before/{name}",
                tofile=f"after/{name}",
            )
        )
    return "".join(chunks)


async def interview(
    draft: ProfileDraft, *, auth_only: bool = False, initial: ProfileEdit | None = None
) -> ProfileEdit | None:
    """Collect and preview profile edits without writing or performing login.

    Parameters
    ----------
    draft : ProfileDraft
        Native/source configuration snapshot and intended profile directory.
    auth_only : bool
        Ask only authentication questions and leave imported assets unchanged.
    initial : ProfileEdit or None
        CLI-supplied choices used as prompt defaults.

    Returns
    -------
    ProfileEdit or None
        Confirmed changes for the caller to publish, or None on cancellation.
    """
    from .workflow import ProfileEdit, prepare_edit, remaining_config

    console = Console()
    edit = initial or ProfileEdit()
    console.print("Configure profile" if draft.existing else "Create profile", style="bold")
    console.print(str(draft.directory), markup=False)
    console.print("Nothing is saved or authenticated until you confirm the final changes.")
    native = tomllib.loads(draft.native_toml)
    if native.get("profile"):
        console.print(
            f"Active native profile: {native['profile']}. This interview shows top-level settings. "
            "An explicit model or authentication choice clears that selector so your choices apply; "
            "the named profile tables remain available in the remaining TOML.",
            style="yellow",
            markup=False,
        )
    try:
        if not auth_only:
            console.print("Native importing is experimental. Unknown settings remain native TOML.", style="yellow")
            selected = {}
            for attribute, title in (
                ("marketplaces", "marketplaces"),
                ("plugins", "plugins"),
                ("mcp_servers", "MCP servers"),
                ("skills", "skills"),
            ):
                selected[attribute] = await _category(
                    title, getattr(draft.inventory, attribute), getattr(edit.selection, attribute)
                )
            launcher = tomllib.loads(draft.launcher_toml)
            model_default = edit.model or native.get("model", "")
            model = await _text("Model (blank preserves the native setting)", model_default)
            executable_default = str(edit.executable or launcher.get("executable", {}).get("path", "codex"))
            executable = await _text("Codex executable", executable_default, required=True)
            edit = replace(
                edit,
                selection=ImportSelection(**selected),
                model=model or None,
                executable=Path(executable) if executable != executable_default or edit.executable else None,
            )
        auth, effective_method = await _authentication(draft, edit.auth, console)
        copy_auth = edit.copy_auth
        if not draft.existing and draft.inventory.auth_file is not None and effective_method == "chatgpt":
            console.print(
                "Credential snapshots are convenient, but separate refresh owners can invalidate sessions.",
                style="yellow",
            )
            copy_auth = await _ask(
                questionary.confirm("Copy the source auth.json snapshot?", default=copy_auth if initial else True)
            )
        login_after = False
        if effective_method in {"chatgpt", "aws-federation"}:
            login_after = await _ask(
                questionary.confirm("Run the selected login flow after saving?", default=edit.login_after)
            )
        edit = replace(edit, auth=auth, copy_auth=copy_auth, login_after=login_after, import_assets=not auth_only)
        prepared = prepare_edit(draft, edit)
        if not auth_only:
            original = remaining_config(prepared)
            remainder = original
            while True:
                console.print("Remaining native TOML (structured interview settings are excluded):", style="bold")
                console.print(Syntax(remainder or "# No remaining settings\n", "toml", word_wrap=True))
                action = await _ask(
                    questionary.select(
                        "Remaining configuration",
                        choices=[
                            questionary.Choice("Accept all remaining TOML", value="accept"),
                            questionary.Choice("Read in pager", value="pager"),
                            questionary.Choice("Edit in $VISUAL / $EDITOR", value="edit"),
                            questionary.Choice("Cancel without saving", value="cancel"),
                        ],
                    )
                )
                if action == "cancel":
                    raise _Cancelled
                if action == "pager":
                    await asyncio.to_thread(_page, console, remainder, "toml")
                    continue
                if action == "edit":
                    result = await asyncio.to_thread(click.edit, remainder, extension=".toml", require_save=False)
                    if result is not None:
                        remainder = result
                    continue
                candidate = replace(edit, remaining_toml=remainder if remainder != original else edit.remaining_toml)
                try:
                    prepared = prepare_edit(draft, candidate)
                except (ProfileError, ValueError) as error:
                    console.print(f"Cannot accept that TOML: {error}", style="red", markup=False)
                    continue
                edit = candidate
                break
        for warning in prepared.warnings:
            console.print(warning, style="yellow", markup=False)
        diff = _diff(draft.native_toml, draft.launcher_toml, prepared.native_toml, prepared.launcher_toml)
        console.print("Configuration changes", style="bold")
        console.print(Syntax(diff or "No TOML changes.\n", "diff", word_wrap=True))
        if edit.copy_auth:
            console.print("After confirmation: copy the source credential snapshot.")
        if edit.login_after:
            console.print("After saving: run the selected authentication flow.")
        if await _ask(questionary.confirm("Save this profile configuration?", default=True)):
            return edit
    except _Cancelled:
        pass
    console.print("Cancelled; no profile changes were saved.")
    return None

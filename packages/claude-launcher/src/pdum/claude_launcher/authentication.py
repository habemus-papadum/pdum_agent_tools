"""Explicit host authentication and native login in a selected configuration root."""

from __future__ import annotations

import asyncio
import getpass
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .errors import AuthenticationError, ProfileError

if TYPE_CHECKING:
    from .profiles import Profile


@dataclass(frozen=True)
class AuthSpec:
    """Credential references, never credential values.

    Parameters
    ----------
    method : str
        ``native`` uses the profile's own login, ``api-key`` references a host
        environment variable, and ``reuse-login`` borrows an existing login's
        access token without copying or refreshing its credential store.
    api_key_env : str
        Host environment variable to resolve at launch for ``api-key``.
    source_directory : Path or None
        Native Claude configuration directory containing ``.credentials.json``.
        For ``reuse-login``, None selects the ordinary macOS Keychain entry or
        the ordinary file-backed login. Custom Keychain service names are not
        inferred from private Claude implementation details.
    """

    method: str = "native"
    api_key_env: str = "ANTHROPIC_API_KEY"
    source_directory: Path | None = None

    def __post_init__(self) -> None:
        if self.method not in {"native", "api-key", "reuse-login"}:
            raise ProfileError("Authentication method must be native, api-key, or reuse-login")
        if not isinstance(self.api_key_env, str) or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", self.api_key_env) is None:
            raise ProfileError("The API key reference must be an environment variable name")
        if self.source_directory is not None:
            if self.method != "reuse-login":
                raise ProfileError("An authentication source directory applies only to reuse-login")
            object.__setattr__(self, "source_directory", Path(self.source_directory).expanduser().resolve())


@dataclass(frozen=True)
class AuthStatus:
    """Non-secret fields from the selected native ``auth status`` command."""

    logged_in: bool
    method: str | None
    provider: str | None
    exit_code: int
    warnings: tuple[str, ...] = ()


def auth_warnings(specification: AuthSpec) -> tuple[str, ...]:
    """Return concise operational caveats without inspecting credentials.

    Parameters
    ----------
    specification : AuthSpec
        Authentication selection for the profile.

    Returns
    -------
    tuple of str
        Warnings suitable for host-side profile and authentication status.
    """
    if specification.method == "reuse-login":
        return ("Reusing an existing login access token; refresh is not managed and the source is never modified.",)
    return ()


async def _wait_for_exit(process: asyncio.subprocess.Process, timeout: float) -> None:
    # Process.wait() can keep waiting after PID exit when an escaped descendant
    # inherits a captured pipe. Poll the child watcher's result instead of EOF.
    deadline = asyncio.get_running_loop().time() + timeout
    while process.returncode is None and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.02)


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        await _wait_for_exit(process, 1)
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        await _wait_for_exit(process, 1)
    if process.returncode is None:
        raise AuthenticationError("An owned native authentication process did not exit after termination")
    # asyncio offers no public close operation for Process's captured read
    # streams. Close only our transport handles after the owned PID has exited;
    # never signal an unknown descendant or a reused process/group ID.
    process._transport.close()


async def _spawn_process(*command: str, **options: Any) -> asyncio.subprocess.Process:
    spawning = asyncio.create_task(asyncio.create_subprocess_exec(*command, **options))
    try:
        return await asyncio.shield(spawning)
    except asyncio.CancelledError:
        # Creation can finish after cancellation reaches the caller. Retain the
        # handle and finish bounded cleanup before propagating cancellation.
        async def reap() -> None:
            process = await spawning
            await _stop_process(process)

        cleanup = asyncio.create_task(reap())
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                continue
        cleanup.result()
        raise


async def _keychain_credentials() -> bytes | None:
    try:
        process = await _spawn_process(
            "/usr/bin/security",
            "find-generic-password",
            "-a",
            getpass.getuser(),
            "-w",
            "-s",
            "Claude Code-credentials",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        raise AuthenticationError("The selected macOS Claude login could not be read") from None
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=5)
    except TimeoutError:
        await _stop_process(process)
        raise AuthenticationError("Reading the selected macOS Claude login timed out") from None
    except BaseException:
        await _stop_process(process)
        raise
    return output if process.returncode == 0 else None


async def _borrow_token(specification: AuthSpec) -> str:
    data: bytes | None = None
    if specification.source_directory is None and sys.platform == "darwin":
        data = await _keychain_credentials()
    if data is None:
        source = specification.source_directory or (Path.home() / ".claude")
        try:
            data = await asyncio.to_thread((source / ".credentials.json").read_bytes)
        except OSError:
            raise AuthenticationError(
                "The selected existing login is unavailable; use native login in the target profile "
                "or select a file-backed Claude credential directory"
            ) from None
    try:
        credential = json.loads(data)
        token = credential["claudeAiOauth"]["accessToken"]
        if not isinstance(token, str) or not token.strip() or "\x00" in token:
            raise ValueError
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise AuthenticationError("The selected existing login has no usable Claude account access token") from None
    return token


async def build_environment(profile: Profile, *, authenticate: bool = True) -> dict[str, str]:
    """Build a child-local environment for the profile and selected credentials.

    Parameters
    ----------
    profile : Profile
        Isolated configuration, workspace, and authentication references.
    authenticate : bool
        Resolve explicitly selected credentials when True. False skips secret
        lookup and injection, as needed by history helpers. The profile's native
        credential store remains available to a native CLI using this root;
        credential-free native probes must therefore use a fresh profile.

    Returns
    -------
    dict of str to str
        A new environment dictionary. The parent environment is never changed.
        Credential values can be present; do not serialize this dictionary.
    """
    profile.validate_paths()
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("ANTHROPIC_", "CLAUDE_", "CLAUDECODE")) and key != profile.auth.api_key_env
    }
    environment.update(
        CLAUDE_CONFIG_DIR=str(profile.config_directory),
        ANTHROPIC_CONFIG_DIR=str(profile.anthropic_directory),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
        DISABLE_AUTOUPDATER="1",
    )
    if authenticate and profile.auth.method == "api-key":
        value = os.environ.get(profile.auth.api_key_env)
        if not value or not value.strip() or "\x00" in value:
            raise AuthenticationError(f"Set the host environment variable {profile.auth.api_key_env} before launching")
        environment["ANTHROPIC_API_KEY"] = value
    elif authenticate and profile.auth.method == "reuse-login":
        environment["CLAUDE_CODE_OAUTH_TOKEN"] = await _borrow_token(profile.auth)
    return environment


def _auth_command(profile: Profile, operation: str) -> list[str]:
    from .profiles import resolve_executable

    return [
        str(resolve_executable(profile.executable)),
        "--setting-sources",
        ",".join(profile.setting_sources),
        "auth",
        operation,
    ]


async def auth_status(profile: Profile, *, timeout: float = 15) -> AuthStatus:
    """Read native authentication status without returning account identifiers.

    Parameters
    ----------
    profile : Profile
        Profile whose selected authentication should be inspected.
    timeout : float
        Maximum seconds to wait for the native status process.

    Returns
    -------
    AuthStatus
        Authentication presence and source; this does not prove an inference
        request or token refresh will succeed.
    """
    environment = await build_environment(profile)
    try:
        process = await _spawn_process(
            *_auth_command(profile, "status"),
            "--json",
            cwd=profile.workspace,
            env=environment,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        raise AuthenticationError("Could not start native Claude authentication status") from None
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        await _stop_process(process)
        raise AuthenticationError("Native Claude authentication status timed out") from None
    except BaseException:
        await _stop_process(process)
        raise
    try:
        value = json.loads(output)
        if not isinstance(value, dict) or not isinstance(value.get("loggedIn"), bool):
            raise ValueError
        method = value.get("authMethod")
        provider = value.get("apiProvider")
        if method is not None and not isinstance(method, str):
            raise ValueError
        if provider is not None and not isinstance(provider, str):
            raise ValueError
    except (ValueError, UnicodeDecodeError):
        raise AuthenticationError("Native Claude authentication status returned an unsupported response") from None
    return AuthStatus(value["loggedIn"], method, provider, process.returncode or 0, auth_warnings(profile.auth))


async def login_auth(profile: Profile) -> int:
    """Run Claude account login in the host terminal for a native profile.

    Parameters
    ----------
    profile : Profile
        Profile using ``native`` authentication. Its configuration root selects
        its own native credential store; browser interaction belongs to Claude.

    Returns
    -------
    int
        Zero after a successful native login. Console keyless sign-in is not
        exposed by this initial flow because its storage differs from claude.ai.
    """
    if profile.auth.method != "native":
        raise AuthenticationError("Native login requires a profile using the native authentication method")
    environment = await build_environment(profile, authenticate=False)
    try:
        process = await _spawn_process(
            *_auth_command(profile, "login"),
            "--claudeai",
            cwd=profile.workspace,
            env=environment,
        )
    except OSError:
        raise AuthenticationError("Could not start native Claude login") from None
    try:
        result = await process.wait()
    except BaseException:
        await _stop_process(process)
        raise
    if result != 0:
        raise AuthenticationError(f"Native Claude login exited with status {result}")
    return result

"""Optional AWS-to-OpenAI API workload identity credential helper."""

from __future__ import annotations

import asyncio
import json
import math
import os
import signal
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any, Literal

import psutil
import typer

from .errors import ProfileError

TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"
DEFAULT_AUDIENCE = "https://api.openai.com/v1"


@dataclass(frozen=True)
class FederationSpec:
    """Nonsecret inputs for an AWS credential context and OpenAI mapping.

    Parameters
    ----------
    region : str
        Regional STS endpoint used to mint the subject token.
    identity_provider_id : str
        Existing OpenAI API identity-provider registration.
    service_account_id : str
        Existing OpenAI API service-account mapping.
    aws_profile : str or None
        Native AWS profile; None uses the native credential chain.
    aws_home : Path or None
        Home used only by AWS subprocesses, including their login caches.
    """

    region: str
    identity_provider_id: str
    service_account_id: str
    aws_profile: str | None = None
    audience: str = DEFAULT_AUDIENCE
    aws_home: Path | None = None
    aws_config_file: Path | None = None
    aws_credentials_file: Path | None = None
    aws_login_cache_directory: Path | None = None
    aws_executable: str = "aws"
    client_id: str | None = None
    refresh_interval_seconds: int = 240
    timeout_seconds: float = 30
    login_method: Literal["sso", "login", "none"] = "sso"


@dataclass(frozen=True, repr=False)
class FederatedToken:
    """An exchanged bearer and its lifetime; representation never exposes it."""

    access_token: str
    expires_in: float


def validate_federation(spec: FederationSpec) -> None:
    """Validate nonsecret helper settings without resolving any credentials."""
    for name in ("region", "identity_provider_id", "service_account_id", "audience", "aws_executable"):
        value = getattr(spec, name)
        if not isinstance(value, str) or not value.strip() or "\0" in value:
            raise ProfileError(f"Federation {name} must be a nonempty string")
    for name in ("aws_profile", "client_id"):
        value = getattr(spec, name)
        if value is not None and (not isinstance(value, str) or not value.strip() or "\0" in value):
            raise ProfileError(f"Federation {name} must be a nonempty string when supplied")
    for name in ("aws_home", "aws_config_file", "aws_credentials_file", "aws_login_cache_directory"):
        value = getattr(spec, name)
        if value is not None and not Path(value).is_absolute():
            raise ProfileError(f"Federation {name} must be an absolute path")
    interval = spec.refresh_interval_seconds
    if isinstance(interval, bool) or not isinstance(interval, int) or interval <= 0:
        raise ProfileError("Federation refresh_interval_seconds must be a positive integer")
    timeout = spec.timeout_seconds
    if isinstance(timeout, bool) or not isinstance(timeout, int | float) or not math.isfinite(timeout) or timeout <= 0:
        raise ProfileError("Federation timeout_seconds must be a positive finite number")
    if spec.login_method not in {"sso", "login", "none"}:
        raise ProfileError("Federation login_method must be sso, login, or none")


def federation_settings(spec: FederationSpec) -> dict[str, Any]:
    """Serialize helper settings, retaining no access tokens or AWS credentials."""
    validate_federation(spec)
    result = {}
    for attribute in fields(spec):
        value = getattr(spec, attribute.name)
        if value is not None:
            result[attribute.name] = os.fspath(value) if isinstance(value, Path) else value
    result.setdefault("aws_home", str(Path.home().absolute()))
    return result


def federation_from_settings(settings: Mapping[str, Any]) -> FederationSpec:
    """Read helper settings from launcher metadata without contacting AWS."""
    if not isinstance(settings, Mapping):
        raise ProfileError("Federation settings must be a table")
    unknown = set(settings) - {attribute.name for attribute in fields(FederationSpec)}
    if unknown:
        raise ProfileError(f"Unknown federation settings: {', '.join(sorted(unknown))}")
    values = dict(settings)
    for name in ("aws_home", "aws_config_file", "aws_credentials_file", "aws_login_cache_directory"):
        if name in values:
            if not isinstance(values[name], str):
                raise ProfileError(f"Federation {name} must be a path string")
            values[name] = Path(values[name])
    try:
        spec = FederationSpec(**values)
    except TypeError as error:
        raise ProfileError("Federation requires region, identity_provider_id, and service_account_id") from error
    validate_federation(spec)
    return spec


def aws_environment(spec: FederationSpec, parent: Mapping[str, str] | None = None) -> dict[str, str]:
    """Build the AWS-only environment without changing Codex or the caller.

    Parameters
    ----------
    spec : FederationSpec
        Explicit AWS configuration and cache context.
    parent : Mapping or None
        Environment to copy; None uses this helper process's environment.

    Returns
    -------
    dict
        Environment for an AWS CLI child process.
    """
    validate_federation(spec)
    environment = dict(os.environ if parent is None else parent)
    environment["AWS_PAGER"] = ""
    environment["AWS_CLI_AUTO_PROMPT"] = "off"
    environment["AWS_REGION"] = spec.region
    environment["AWS_DEFAULT_REGION"] = spec.region
    if spec.aws_home is not None:
        environment["HOME"] = str(spec.aws_home)
    overrides = {
        "AWS_CONFIG_FILE": spec.aws_config_file,
        "AWS_SHARED_CREDENTIALS_FILE": spec.aws_credentials_file,
        "AWS_LOGIN_CACHE_DIRECTORY": spec.aws_login_cache_directory,
    }
    for key, value in overrides.items():
        if value is not None:
            environment[key] = str(value)
    if spec.aws_profile is not None:
        environment["AWS_PROFILE"] = spec.aws_profile
        environment.pop("AWS_DEFAULT_PROFILE", None)
    return environment


async def _stop_process(process: asyncio.subprocess.Process, *, own_group: bool) -> None:
    if process.returncode is not None:
        return
    children = []
    if not own_group:
        try:
            children = psutil.Process(process.pid).children(recursive=True)
        except psutil.NoSuchProcess:
            pass
        for child in reversed(children):
            try:
                child.terminate()
            except psutil.NoSuchProcess:
                pass
    try:
        if own_group:
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except TimeoutError:
        try:
            if own_group:
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        await process.wait()
    if children:
        _, alive = await asyncio.to_thread(psutil.wait_procs, children, timeout=3)
        for child in alive:
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass


async def _run_aws(
    spec: FederationSpec,
    arguments: list[str],
    *,
    interactive: bool = False,
    lease_descriptor: int | None = None,
    on_spawn: Callable[[asyncio.subprocess.Process, list[str]], Awaitable[None]] | None = None,
) -> bytes:
    command = [spec.aws_executable, *arguments]
    if spec.aws_profile is not None:
        command.extend(["--profile", spec.aws_profile])
    command.extend(["--region", spec.region, "--no-cli-pager"])
    if not interactive:
        timeout = str(max(1, math.ceil(spec.timeout_seconds)))
        command.extend(["--cli-connect-timeout", timeout, "--cli-read-timeout", timeout])
    pending = asyncio.create_task(
        asyncio.create_subprocess_exec(
            *command,
            env=aws_environment(spec),
            stdin=None if interactive else asyncio.subprocess.DEVNULL,
            stdout=None if interactive else asyncio.subprocess.PIPE,
            stderr=None if interactive else asyncio.subprocess.PIPE,
            start_new_session=interactive,
            pass_fds=() if lease_descriptor is None else (lease_descriptor,),
        )
    )
    cancelled = False
    try:
        process = await asyncio.shield(pending)
    except asyncio.CancelledError:
        try:
            process = await pending
        except OSError:
            raise asyncio.CancelledError from None
        cancelled = True
    except OSError as error:
        raise ProfileError("Could not start the configured AWS CLI executable") from error
    try:
        if on_spawn is not None:
            await on_spawn(process, command)
        if cancelled:
            raise asyncio.CancelledError
        if interactive:
            await process.wait()
            stdout = b""
        else:
            stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=spec.timeout_seconds)
    except TimeoutError as error:
        await _stop_process(process, own_group=interactive)
        raise ProfileError("AWS credential operation timed out; run the profile's login action if needed") from error
    except BaseException:
        await _stop_process(process, own_group=interactive)
        raise
    if process.returncode:
        raise ProfileError(
            f"AWS credential operation failed (exit {process.returncode}); check the AWS profile and login state"
        )
    return stdout


async def aws_login(
    spec: FederationSpec,
    *,
    _lease_descriptor: int | None = None,
    _on_spawn: Callable[[asyncio.subprocess.Process, list[str]], Awaitable[None]] | None = None,
) -> None:
    """Run the explicitly selected native AWS login flow in its credential context.

    Parameters
    ----------
    spec : FederationSpec
        Settings whose login_method selects ``aws sso login`` or ``aws login``.
        The latter is distinct from IAM Identity Center SSO.
    """
    validate_federation(spec)
    if spec.login_method == "none":
        raise ProfileError("This AWS credential context has no interactive login action configured")
    arguments = ["sso", "login"] if spec.login_method == "sso" else ["login"]
    await _run_aws(spec, arguments, interactive=True, lease_descriptor=_lease_descriptor, on_spawn=_on_spawn)


async def mint_token(spec: FederationSpec) -> FederatedToken:
    """Mint and exchange fresh credentials; never read or write a bearer cache.

    Parameters
    ----------
    spec : FederationSpec
        Nonsecret AWS and OpenAI federation settings.

    Returns
    -------
    FederatedToken
        Bearer token whose lifetime exceeds Codex's refresh cadence and margin.
    """
    validate_federation(spec)
    try:
        import httpx
    except ImportError as error:
        raise ProfileError("Install habemus-papadum-codex-launcher[federation] for AWS federation") from error
    stdout = await _run_aws(
        spec,
        [
            "sts",
            "get-web-identity-token",
            "--audience",
            spec.audience,
            "--signing-algorithm",
            "ES384",
            "--duration-seconds",
            "300",
            "--output",
            "json",
        ],
    )
    try:
        subject = json.loads(stdout)["WebIdentityToken"]
        if not isinstance(subject, str) or not subject.strip():
            raise ValueError
    except (ValueError, KeyError, TypeError) as error:
        raise ProfileError("AWS did not return a nonempty WebIdentityToken") from error
    payload = {
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
        "subject_token": subject,
        "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
        "identity_provider_id": spec.identity_provider_id,
        "service_account_id": spec.service_account_id,
    }
    if spec.client_id is not None:
        payload["client_id"] = spec.client_id
    try:
        async with httpx.AsyncClient(timeout=spec.timeout_seconds, follow_redirects=False) as client:
            response = await client.post(TOKEN_ENDPOINT, json=payload)
    except httpx.HTTPError as error:
        raise ProfileError("OpenAI federation exchange failed at the HTTP transport") from error
    if response.status_code != 200:
        raise ProfileError(
            f"OpenAI federation exchange failed (HTTP {response.status_code}); check the provider mapping"
        )
    try:
        result = response.json()
        token = result["access_token"]
        lifetime = result["expires_in"]
        if not isinstance(token, str) or not token.strip():
            raise ValueError
        if isinstance(lifetime, bool) or not isinstance(lifetime, int | float) or not math.isfinite(lifetime):
            raise ValueError
    except (ValueError, KeyError, TypeError) as error:
        raise ProfileError("OpenAI federation returned an invalid access token or expiry") from error
    if lifetime <= spec.refresh_interval_seconds + 30:
        raise ProfileError(
            "Federated token lifetime is too short; reduce refresh_interval_seconds below expiry minus 30s"
        )
    return FederatedToken(token, lifetime)


def read_federation(directory: Path) -> FederationSpec:
    """Load this profile's saved helper settings without loading authentication files."""
    import tomllib

    try:
        metadata = tomllib.loads((directory / "launcher.toml").read_text())
        authentication = metadata["authentication"]
        if authentication.get("method") != "aws-federation":
            raise KeyError
        return federation_from_settings(authentication["federation"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ProfileError("Profile does not contain valid AWS federation settings") from error


def create_app() -> typer.Typer:
    """Create the token-only helper CLI without performing any authentication."""
    application = typer.Typer(add_completion=False)

    @application.command()
    def token(profile_dir: Path = typer.Option(..., "--profile-dir")) -> None:
        try:
            spec = read_federation(profile_dir)
            result = asyncio.run(mint_token(spec))
        except ProfileError as error:
            typer.echo(str(error), err=True)
            raise typer.Exit(1) from None
        typer.echo(result.access_token)

    return application


app = create_app()

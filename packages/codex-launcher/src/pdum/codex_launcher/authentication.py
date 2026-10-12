"""Pure native authentication configuration and explicit profile login actions."""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import psutil
import tomlkit

from .config import atomic_write, complete_file_operation
from .errors import ProfileError
from .federation import FederationSpec, aws_login, federation_from_settings, federation_settings

AuthMethod = Literal["preserve", "chatgpt", "api-key", "aws-federation"]


@dataclass(frozen=True)
class AuthSpec:
    """Requested authentication configuration, separate from credential acquisition.

    Parameters
    ----------
    method : str
        Preserve, ChatGPT login, environment API key, or AWS API federation.
    api_key_env : str
        Environment variable name, never the API key itself.
    base_url : str or None
        Explicit Responses API endpoint for the generated provider.
    federation : FederationSpec or None
        Required only for AWS federation.
    """

    method: AuthMethod = "preserve"
    api_key_env: str = "OPENAI_API_KEY"
    base_url: str | None = None
    federation: FederationSpec | None = None


@dataclass(frozen=True)
class AuthInspection:
    """A nonsecret native-first description suitable for interview defaults."""

    spec: AuthSpec
    summary: str
    warnings: tuple[str, ...] = ()


def _documents(native_toml: str, launcher_toml: str):
    try:
        native = tomlkit.parse(native_toml)
        launcher = tomlkit.parse(launcher_toml)
    except ValueError as error:
        raise ProfileError("Authentication configuration requires valid TOML") from error
    for document, key in ((native, "model_providers"), (launcher, "authentication"), (launcher, "environment")):
        if key in document and not isinstance(document[key], dict):
            raise ProfileError(f"Authentication configuration requires [{key}] to be a table")
    return native, launcher


def _auth_ownership(native, launcher) -> dict:
    metadata = launcher.get("authentication", {})
    if metadata or native.get("model_provider") != "pdum_api":
        return metadata
    provider = native.get("model_providers", {}).get("pdum_api", {})
    required = {"name", "env_key", "wire_api", "requires_openai_auth"}
    if not isinstance(provider, dict) or not required <= set(provider) <= required | {"base_url"}:
        return metadata
    variable = provider.get("env_key")
    if (
        provider.get("name") != "Profile API key"
        or provider.get("wire_api") != "responses"
        or provider.get("requires_openai_auth") is not False
        or not isinstance(variable, str)
        or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", variable) is None
        or variable not in launcher.get("environment", {}).get("inherit_keys", [])
        or ("base_url" in provider and not isinstance(provider["base_url"], str))
    ):
        return metadata
    return {"method": "api-key", "owned_provider": "pdum_api", "owned_inherit_keys": [variable]}


def inspect_auth(native_toml: str, launcher_toml: str, profile_dir: Path) -> AuthInspection:
    """Infer authentication from the selected native provider without reading secrets.

    Parameters
    ----------
    native_toml : str
        Native Codex configuration text.
    launcher_toml : str
        Launcher metadata text.
    profile_dir : Path
        Destination profile; used only to check generated helper references.

    Returns
    -------
    AuthInspection
        Interview defaults and warnings; credential presence is not authenticated state.
    """
    native, launcher = _documents(native_toml, launcher_toml)
    selected = native.get("model_provider", "openai")
    provider = native.get("model_providers", {}).get(selected, {})
    if not isinstance(provider, dict):
        return AuthInspection(AuthSpec(), "Unrecognized native provider configuration; preserve it")
    metadata = launcher.get("authentication", {})
    warnings = []
    if native.get("profile"):
        return AuthInspection(
            AuthSpec(),
            "A native named profile is selected; preserve its authentication unless explicitly changed",
            ("Explicit authentication clears the active native profile selector, not the named profile tables",),
        )
    if selected == "openai" and not provider:
        warnings.append("Configuration alone cannot distinguish an existing ChatGPT login from a stored API credential")
        return AuthInspection(
            AuthSpec("chatgpt"), "Native OpenAI authentication; credentials are not inspected", tuple(warnings)
        )
    if provider.get("env_key") and not provider.get("auth"):
        variable = provider["env_key"]
        if isinstance(variable, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", variable):
            return AuthInspection(AuthSpec("api-key", variable, provider.get("base_url")), f"API key from {variable}")
    auth = provider.get("auth", {})
    if (
        metadata.get("method") == "aws-federation"
        and metadata.get("owned_provider") == selected
        and isinstance(auth, dict)
        and "pdum.codex_launcher._federation_helper" in auth.get("args", [])
    ):
        try:
            federation = federation_from_settings(metadata["federation"])
        except (KeyError, ProfileError):
            warnings.append("The selected native helper's launcher federation settings are incomplete")
        else:
            arguments = auth.get("args", [])
            expected = ["-m", "pdum.codex_launcher._federation_helper", "--profile-dir", str(profile_dir.absolute())]
            consistent = (
                arguments == expected
                and auth.get("command") == sys.executable
                and auth.get("refresh_interval_ms") == federation.refresh_interval_seconds * 1000
                and not provider.get("env_key")
                and not provider.get("experimental_bearer_token")
                and not provider.get("requires_openai_auth")
            )
            if consistent:
                return AuthInspection(
                    AuthSpec("aws-federation", base_url=provider.get("base_url"), federation=federation),
                    "AWS workload federation via the selected native credential helper",
                )
            warnings.append("The native helper differs from saved settings; preserve or explicitly reconfigure it")
    return AuthInspection(
        AuthSpec(), "Custom native authentication; preserve it unless explicitly changed", tuple(warnings)
    )


def auth_handled_paths(native_toml: str, launcher_toml: str, spec: AuthSpec) -> tuple[tuple[str, ...], ...]:
    """Return the exact native paths an explicit interview selection replaces.

    Parameters
    ----------
    native_toml : str
        Existing native configuration.
    launcher_toml : str
        Existing launcher ownership metadata.
    spec : AuthSpec
        Interview authentication choice; preserve handles no paths.

    Returns
    -------
    tuple
        Native TOML key paths suitable for separating the residual editor view.
    """
    if spec.method == "preserve":
        return ()
    native, launcher = _documents(native_toml, launcher_toml)
    paths = [("model_provider",), ("forced_login_method",), ("profile",)]
    if spec.method == "chatgpt":
        paths.append(("cli_auth_credentials_store",))
        paths.append(("model_providers", "openai"))
    owned = _auth_ownership(native, launcher).get("owned_provider")
    if isinstance(owned, str) and owned in native.get("model_providers", {}):
        paths.append(("model_providers", owned))
    return tuple(paths)


def _provider_name(native, metadata, preferred: str) -> str:
    providers = native.setdefault("model_providers", {})
    previous = metadata.get("owned_provider")
    if isinstance(previous, str) and previous in providers:
        return previous
    candidate = preferred
    counter = 2
    while candidate in providers:
        candidate = f"{preferred}_{counter}"
        counter += 1
    return candidate


def apply_auth(native_toml: str, launcher_toml: str, spec: AuthSpec, profile_dir: Path) -> tuple[str, str]:
    """Apply authentication settings without I/O, preserving unrelated native configuration.

    Parameters
    ----------
    native_toml : str
        Existing Codex TOML.
    launcher_toml : str
        Existing launcher TOML.
    spec : AuthSpec
        Explicit method selection; preserve returns both original strings unchanged.
    profile_dir : Path
        Final profile directory, embedded in the native credential helper command.

    Returns
    -------
    tuple[str, str]
        Native and launcher TOML to publish inside the caller's profile transaction.
    """
    if spec.method == "preserve":
        return native_toml, launcher_toml
    if spec.method not in {"chatgpt", "api-key", "aws-federation"}:
        raise ProfileError("Authentication method must be preserve, chatgpt, api-key, or aws-federation")
    if spec.method == "api-key" and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", spec.api_key_env) is None:
        raise ProfileError("API authentication requires an environment variable name, not a token")
    if spec.base_url is not None and (
        not isinstance(spec.base_url, str) or not spec.base_url.startswith(("https://", "http://"))
    ):
        raise ProfileError("Authentication base_url must be an HTTP or HTTPS endpoint")
    native, launcher = _documents(native_toml, launcher_toml)
    previous = _auth_ownership(native, launcher)
    environment = launcher.setdefault("environment", {})
    inherited = list(environment.get("inherit_keys", []))
    previous_keys = previous.get("owned_inherit_keys", [])
    if not isinstance(previous_keys, list) or any(not isinstance(key, str) for key in previous_keys):
        raise ProfileError("Authentication owned_inherit_keys must be a list of names")
    inherited = [key for key in inherited if key not in previous_keys]
    metadata = {"method": spec.method}
    native.pop("profile", None)
    if spec.method == "chatgpt":
        if native.get("model_providers", {}).get("openai"):
            raise ProfileError(
                "A custom [model_providers.openai] overrides native ChatGPT authentication; "
                "rename or remove that table before selecting ChatGPT"
            )
        native["model_provider"] = "openai"
        native["cli_auth_credentials_store"] = "file"
        previous_provider = previous.get("owned_provider")
        providers = native.get("model_providers", {})
        if isinstance(previous_provider, str) and previous_provider in providers:
            del providers[previous_provider]
        native.pop("forced_login_method", None)
    else:
        preferred = "pdum_api" if spec.method == "api-key" else "pdum_aws_federation"
        provider_name = _provider_name(native, previous, preferred)
        providers = native["model_providers"]
        provider = dict(providers.get(provider_name, {}))
        for key in ("auth", "env_key", "experimental_bearer_token", "env_key_instructions"):
            provider.pop(key, None)
        provider.update(
            {
                "name": "Profile API key" if spec.method == "api-key" else "Profile AWS federation",
                "base_url": spec.base_url or "https://api.openai.com/v1",
                "wire_api": "responses",
                "requires_openai_auth": False,
                "supports_websockets": True,
            }
        )
        if spec.method == "api-key":
            provider["env_key"] = spec.api_key_env
            if spec.api_key_env not in inherited:
                inherited.append(spec.api_key_env)
                metadata["owned_inherit_keys"] = [spec.api_key_env]
        else:
            if spec.federation is None:
                raise ProfileError("AWS federation requires federation settings")
            metadata["federation"] = federation_settings(spec.federation)
            provider["auth"] = {
                "command": sys.executable,
                "args": ["-m", "pdum.codex_launcher._federation_helper", "--profile-dir", str(profile_dir.absolute())],
                "cwd": str(profile_dir.absolute()),
                "timeout_ms": int((spec.federation.timeout_seconds * 2 + 5) * 1000),
                "refresh_interval_ms": spec.federation.refresh_interval_seconds * 1000,
            }
        native["model_providers"][provider_name] = provider
        native["model_provider"] = provider_name
        metadata["owned_provider"] = provider_name
        native.pop("forced_login_method", None)
    environment["inherit_keys"] = inherited
    launcher["authentication"] = metadata
    return tomlkit.dumps(native), tomlkit.dumps(launcher)


async def login_auth(directory: Path, *, device_auth: bool = False) -> int:
    """Run an explicit saved-profile login; API keys have no interactive login.

    Parameters
    ----------
    directory : Path
        Existing stopped profile whose saved native configuration is inspected.
    device_auth : bool
        Use Codex's device-auth flow when the selected method is ChatGPT.

    Returns
    -------
    int
        Zero after AWS login succeeds, or the native ChatGPT login exit code.
    """
    from .runtime import _identity, _Lease, login_chatgpt

    lease = _Lease(directory)
    lease.acquire()
    path = lease.directory
    record = {}
    process = None

    async def publish() -> None:
        await complete_file_operation(lambda: atomic_write(path / "runtime/owner.json", json.dumps(record)))

    async def spawned(child: asyncio.subprocess.Process, arguments: list[str]) -> None:
        nonlocal process
        process = child
        record["server"] = _identity(child.pid)
        record["executable"] = arguments[0]
        record["arguments"] = arguments[1:]
        try:
            observed = psutil.Process(child.pid)
            record["process_command"] = observed.cmdline()
            record["process_executable"] = observed.exe()
        except psutil.NoSuchProcess:
            pass
        record["state"] = "authenticating"
        await publish()

    try:
        native, launcher = await asyncio.to_thread(
            lambda: ((path / "codex/config.toml").read_text(), (path / "launcher.toml").read_text())
        )
        inspection = inspect_auth(native, launcher, path)
        if inspection.spec.method == "aws-federation":
            record = {
                "run_id": uuid.uuid4().hex,
                "operation": "login",
                "authentication_method": "aws-federation",
                "profile": str(path),
                "state": "starting",
                "owner": _identity(os.getpid()),
                "started_at": time.time(),
            }
            await publish()
            await aws_login(inspection.spec.federation, _lease_descriptor=lease.descriptor, _on_spawn=spawned)
            return 0
        if inspection.spec.method != "chatgpt":
            raise ProfileError("The selected authentication method has no managed login action")
    finally:
        try:
            if record:
                record.update(state="closed", stopped_at=time.time())
                if process is not None:
                    record["returncode"] = process.returncode
                await publish()
        finally:
            lease.close()
    return await login_chatgpt(directory, device_auth=device_auth)

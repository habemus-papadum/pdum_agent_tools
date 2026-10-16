"""Small launcher-owned configuration, separate from native Codex TOML."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
import tomllib
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

import tomlkit

from .errors import ProfileError
from .layout import launcher_toml, legacy_layout

_Result = TypeVar("_Result")

SCHEMA_VERSION = 2
"""Current ``launcher.toml`` schema; version 1 described the retired wrapper layout."""


async def complete_file_operation(operation: Callable[[], _Result]) -> _Result:
    """Finish an off-loop file mutation before propagating caller cancellation."""
    pending = asyncio.create_task(asyncio.to_thread(operation))
    try:
        return await asyncio.shield(pending)
    except asyncio.CancelledError:
        await pending
        raise


@dataclass(frozen=True)
class LauncherConfig:
    """Resolved launcher metadata; native Codex options are not modeled here.

    Parameters
    ----------
    executable : Path
        Codex executable used by launch and login.
    environment_mode : str
        ``clean`` passes a small baseline to the child; ``inherit`` passes the parent environment.
    isolate : bool
        Give the child its own ``HOME``, XDG roots, ``TMPDIR`` and working directory inside
        the launcher subdirectory. A bare Codex home defaults to False so the server behaves
        like the user's own CLI; managed profiles default to True.
    managed : bool
        Whether ``launcher.toml`` exists. Bare homes use the defaults above.
    """

    executable: Path
    environment_mode: str = "clean"
    environment: dict[str, str] = field(default_factory=dict)
    inherit_keys: tuple[str, ...] = ()
    host: str = "0.0.0.0"
    port: int = 0
    startup_timeout: float = 30
    shutdown_timeout: float = 10
    isolate: bool = True
    managed: bool = True


def atomic_write(path: Path, content: str | bytes) -> None:
    """Replace a file atomically with private permissions.

    Parameters
    ----------
    path : Path
        Destination within an already created directory.
    content : str or bytes
        Complete replacement contents.
    """
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content.encode() if isinstance(content, str) else content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def resolve_executable(value: str | Path | None, base: Path | None = None) -> Path:
    """Resolve a requested executable without invoking a shell.

    Parameters
    ----------
    value : str or Path or None
        Executable path/name; None selects ``codex`` from PATH.
    base : Path or None
        Base for an explicitly relative path containing a separator.

    Returns
    -------
    Path
        Absolute executable path.
    """
    candidate = os.fspath(value) if value is not None else "codex"
    if "/" in candidate:
        path = Path(candidate).expanduser()
        if not path.is_absolute():
            path = (base or Path.cwd()) / path
    else:
        found = shutil.which(candidate)
        if found is None:
            raise ProfileError(f"Executable not found on PATH: {candidate}")
        path = Path(found)
    path = path.absolute()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ProfileError(f"Not an executable file: {path}")
    return path


def bare_home_config(executable: str | Path | None = None) -> LauncherConfig:
    """Return the configuration used for a Codex home without launcher metadata.

    Parameters
    ----------
    executable : str or Path or None
        Explicit executable; None selects ``codex`` from PATH, like the user's own CLI.

    Returns
    -------
    LauncherConfig
        Inherited environment, no isolation, all-interface relay defaults.
    """
    return LauncherConfig(resolve_executable(executable), "inherit", isolate=False, managed=False)


def read_config(directory: Path, executable: str | Path | None = None) -> LauncherConfig:
    """Read and validate launcher metadata, or derive bare-home defaults.

    Parameters
    ----------
    directory : Path
        Existing profile directory, which is a Codex home.
    executable : str or Path or None
        Executable override, required to resolve a bare home without ``codex`` on PATH.

    Returns
    -------
    LauncherConfig
        Validated launcher settings.
    """
    if legacy_layout(directory):
        raise ProfileError(
            f"Legacy wrapper layout: {directory}. Move codex/* into the profile root and "
            "launcher.toml into .pdum/; profiles are Codex homes now."
        )
    metadata = launcher_toml(directory)
    if not metadata.is_file():
        if not directory.is_dir():
            raise ProfileError(f"Profile does not exist: {directory}")
        return bare_home_config(executable)
    try:
        data = tomllib.loads(metadata.read_text())
    except (OSError, ValueError) as error:
        raise ProfileError(f"Cannot read launcher metadata: {metadata}") from error
    allowed = {"schema_version", "executable", "environment", "launch", "authentication"}
    if set(data) - allowed:
        raise ProfileError(f"Unknown launcher metadata fields: {', '.join(sorted(set(data) - allowed))}")
    if data.get("schema_version") != SCHEMA_VERSION:
        raise ProfileError(f"launcher.toml requires schema_version = {SCHEMA_VERSION}")
    if not isinstance(data.get("authentication", {}), dict):
        raise ProfileError("Invalid [authentication] launcher metadata")
    executable_section = data.get("executable", {})
    environment = data.get("environment", {})
    launch = data.get("launch", {})
    sections = [
        (executable_section, {"path"}, "executable"),
        (environment, {"mode", "isolate", "values", "inherit_keys"}, "environment"),
        (launch, {"bind", "port", "startup_timeout_seconds", "shutdown_timeout_seconds"}, "launch"),
    ]
    for section, keys, name in sections:
        if not isinstance(section, dict) or set(section) - keys:
            raise ProfileError(f"Invalid [{name}] launcher metadata")
    executable_path = executable_section.get("path")
    if not isinstance(executable_path, str) or not executable_path:
        raise ProfileError("[executable].path must be a nonempty string")
    path = Path(executable_path).expanduser()
    if not path.is_absolute():
        path = directory / path
    mode = environment.get("mode", "clean")
    isolate = environment.get("isolate", True)
    values = environment.get("values", {})
    inherited = environment.get("inherit_keys", [])
    if mode not in {"clean", "inherit"}:
        raise ProfileError("Environment mode must be clean or inherit")
    if not isinstance(isolate, bool):
        raise ProfileError("Environment isolate must be a boolean")
    if not isinstance(values, dict) or any(not isinstance(value, str) for value in values.values()):
        raise ProfileError("Environment values must be strings")
    if not isinstance(inherited, list) or any(not isinstance(key, str) for key in inherited):
        raise ProfileError("Environment inherit_keys must be a list of names")
    host = launch.get("bind", "0.0.0.0")
    port = launch.get("port", 0)
    if not isinstance(host, str) or not host:
        raise ProfileError("Launch bind must be a nonempty address")
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise ProfileError("Launch port must be in 0..65535")
    timeouts = [launch.get("startup_timeout_seconds", 30), launch.get("shutdown_timeout_seconds", 10)]
    if any(isinstance(value, bool) or not isinstance(value, int | float) or value <= 0 for value in timeouts):
        raise ProfileError("Launch timeouts must be positive numbers")
    if executable is not None:
        path = resolve_executable(executable, directory)
    return LauncherConfig(path, mode, values, tuple(inherited), host, port, *timeouts, isolate, True)


def edit_native_config(directory: Path, changes: dict[str, Any]) -> None:
    """Apply explicit top-level changes while preserving unrelated native TOML.

    Parameters
    ----------
    directory : Path
        Profile directory (Codex home), whose caller holds the mutation lock.
    changes : dict
        Native top-level keys to replace.
    """
    path = directory / "config.toml"
    document = tomlkit.parse(path.read_text()) if path.exists() else tomlkit.document()
    for key, value in changes.items():
        document[key] = value
    atomic_write(path, tomlkit.dumps(document))


_OVERRIDE_KEY = re.compile(r"[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*")


def native_override(key: str, value: Any, *, raw: bool = False) -> str:
    """Render one ``-c key=value`` argument for the native CLI.

    Parameters
    ----------
    key : str
        Dotted native configuration path, validated but not interpreted.
    value : Any
        A string, boolean or number rendered as a TOML value, or, with ``raw``,
        TOML text passed through verbatim the way ``codex -c`` accepts it.
    raw : bool
        Treat ``value`` as already-rendered TOML text.

    Returns
    -------
    str
        ``key=value`` suitable for ``codex app-server -c``.
    """
    if not isinstance(key, str) or _OVERRIDE_KEY.fullmatch(key) is None:
        raise ProfileError(f"Invalid native configuration key: {key!r}")
    if raw:
        if not isinstance(value, str) or not value.strip():
            raise ProfileError(f"Override for {key} must be nonempty TOML text")
        return f"{key}={value}"
    if isinstance(value, bool | int | float | str):
        return f"{key}={tomlkit.item(value).as_string().strip()}"
    raise ProfileError(f"Unsupported override value for {key}: {type(value).__name__}")

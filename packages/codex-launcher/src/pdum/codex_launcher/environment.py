"""Predictable process-local environment construction."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from .config import LauncherConfig
from .errors import ProfileError


def build_environment(
    directory: Path,
    config: LauncherConfig,
    overrides: Mapping[str, str] | None = None,
    mode: str | None = None,
    parent: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Build an environment without changing the caller's process state.

    Parameters
    ----------
    directory : Path
        Profile directory containing isolated homes.
    config : LauncherConfig
        Saved environment settings.
    overrides : Mapping or None
        Explicit values for this invocation.
    mode : str or None
        ``clean`` or ``inherit``; None uses the saved setting.
    parent : Mapping or None
        Source environment; None reads the current process.

    Returns
    -------
    dict
        Environment suitable for ``asyncio.create_subprocess_exec``.
    """
    source = dict(os.environ if parent is None else parent)
    selection = mode or config.environment_mode
    if selection not in {"clean", "inherit"}:
        raise ProfileError("Environment mode must be clean or inherit")
    baseline = {"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "SYSTEMROOT"}
    environment = source.copy() if selection == "inherit" else {key: source[key] for key in baseline if key in source}
    environment.setdefault("PATH", os.defpath)
    for key in config.inherit_keys:
        if key not in source:
            raise ProfileError(f"Required environment variable is missing: {key}")
        environment[key] = source[key]
    values = dict(config.environment)
    values.update(overrides or {})
    home = directory / "home"
    owned = {
        "HOME": str(home),
        "CODEX_HOME": str(directory / "codex"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "TMPDIR": str(directory / "runtime" / "tmp"),
    }
    for key, value in values.items():
        if not isinstance(key, str) or not isinstance(value, str) or "\0" in key + value or "=" in key:
            raise ProfileError("Environment names and values must be valid strings")
        if key in owned and value != owned[key]:
            raise ProfileError(f"Environment value conflicts with the profile-owned {key}")
    environment.update(values)
    environment.update(owned)
    return environment

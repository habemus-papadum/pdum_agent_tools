"""The per-machine description of what to ingest and where to publish it.

One YAML file lists sources (Codex homes, Claude directories, or every profile of a launcher) and
targets (local DuckDB files, MotherDuck databases). ``pdum-history sync`` reads it so one command
covers every agent on the machine. The default location is the user configuration directory,
overridable with ``--config`` or ``PDUM_AGENT_HISTORY_CONFIG``.

.. code-block:: yaml

    window_days: 183
    blobs: true
    sources:
      - agent: codex
        home: ~/.codex
      - agent: codex
        profiles: all            # every Codex launcher profile on this machine
      - agent: claude
        dir: ~/.claude
      - agent: claude
        profiles: all            # every Claude launcher profile's claude/ directory
    targets:
      - name: local
        duckdb: ~/history/agents.duckdb
      - name: cloud
        motherduck: agent_history   # md:agent_history, token from MOTHERDUCK_TOKEN
        token_env: MOTHERDUCK_BROWSER_TOKEN
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import platformdirs
import yaml

from .base import DEFAULT_WINDOW_DAYS
from .targets import Target

CONFIG_ENV = "PDUM_AGENT_HISTORY_CONFIG"
AGENTS = ("codex", "claude")


class ConfigError(ValueError):
    """The configuration file is missing or malformed."""


@dataclass(frozen=True)
class Source:
    """One directory to read.

    Parameters
    ----------
    agent : str
        ``codex`` or ``claude``.
    root : Path
        The Codex home or Claude configuration directory.
    label : str
        Where it came from, for output: ``home``, ``dir`` or ``profile:<name>``.
    """

    agent: str
    root: Path
    label: str


@dataclass
class Config:
    """Parsed configuration."""

    sources: list[Source]
    targets: list[Target]
    window_days: int | None = DEFAULT_WINDOW_DAYS
    blobs: bool = True
    path: Path | None = None
    notes: list[str] = field(default_factory=list)


def default_config_path() -> Path:
    """Return ``$PDUM_AGENT_HISTORY_CONFIG`` or ``history.yaml`` in the user configuration directory."""
    override = os.environ.get(CONFIG_ENV)
    if override:
        return Path(override).expanduser()
    return platformdirs.user_config_path("pdum-agent-history", appauthor=False) / "history.yaml"


def profiles_root(agent: str) -> Path:
    """Return the launcher's default profiles directory for an agent."""
    return platformdirs.user_data_path(f"pdum-{agent}", appauthor=False) / "profiles"


def profile_roots(agent: str, root: Path) -> list[tuple[str, Path]]:
    """List ``(name, directory)`` for every launcher profile under ``root``.

    A Codex profile directory is itself the Codex home. A Claude profile keeps its native
    configuration in a ``claude/`` subdirectory.
    """
    if not root.is_dir():
        return []
    found: list[tuple[str, Path]] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        directory = entry / "claude" if agent == "claude" else entry
        if directory.is_dir():
            found.append((entry.name, directory))
    return found


def load(path: Path | None = None) -> Config:
    """Read and validate the configuration file.

    Parameters
    ----------
    path : Path or None
        File to read; defaults to :func:`default_config_path`.

    Raises
    ------
    ConfigError
        When the file is missing, not a mapping, or names an unknown agent or an empty target.
    """
    location = path or default_config_path()
    if not location.is_file():
        raise ConfigError(f"no configuration at {location}; write one (see `pdum-history sync --example`)")
    try:
        data = yaml.safe_load(location.read_text()) or {}
    except yaml.YAMLError as error:
        raise ConfigError(f"{location}: {error}") from error
    if not isinstance(data, dict):
        raise ConfigError(f"{location}: expected a mapping at the top level")
    config = Config(sources=[], targets=[], path=location)
    window = data.get("window_days", DEFAULT_WINDOW_DAYS)
    config.window_days = None if window in (None, 0, "all") else int(window)
    config.blobs = bool(data.get("blobs", True))
    for index, entry in enumerate(data.get("sources") or []):
        config.sources.extend(_sources(entry, index, config.notes))
    for index, entry in enumerate(data.get("targets") or []):
        config.targets.append(_target(entry, index))
    if not config.sources:
        raise ConfigError(f"{location}: no sources")
    if not config.targets:
        raise ConfigError(f"{location}: no targets")
    return config


def _sources(entry: Any, index: int, notes: list[str]) -> list[Source]:
    if not isinstance(entry, dict):
        raise ConfigError(f"sources[{index}]: expected a mapping")
    agent = entry.get("agent")
    if agent not in AGENTS:
        raise ConfigError(f"sources[{index}]: agent must be one of {AGENTS}")
    if "profiles" in entry:
        value = entry["profiles"]
        root = profiles_root(agent) if value in (True, "all", None) else Path(str(value)).expanduser()
        found = profile_roots(agent, root)
        if not found:
            notes.append(f"no {agent} profiles under {root}")
        return [Source(agent, directory.resolve(), f"profile:{name}") for name, directory in found]
    key = "home" if agent == "codex" else "dir"
    value = entry.get(key) or entry.get("path")
    if not value:
        raise ConfigError(f"sources[{index}]: a {agent} source needs `{key}` or `profiles`")
    directory = Path(str(value)).expanduser()
    if not directory.is_dir():
        notes.append(f"{agent} source {directory} does not exist")
        return []
    return [Source(agent, directory.resolve(), key)]


def _target(entry: Any, index: int) -> Target:
    if not isinstance(entry, dict):
        raise ConfigError(f"targets[{index}]: expected a mapping")
    name = str(entry.get("name") or "")
    if entry.get("motherduck"):
        database = str(entry["motherduck"])
        spec = database if database.startswith("md:") else f"md:{database}"
        return Target(spec, name or "motherduck", entry.get("token_env"))
    if entry.get("duckdb"):
        return Target(str(Path(str(entry["duckdb"])).expanduser()), name or "local")
    raise ConfigError(f"targets[{index}]: needs `duckdb: <path>` or `motherduck: <database>`")


EXAMPLE = """# pdum-history sync configuration: what this machine ingests and where it publishes.
window_days: 183
blobs: true
sources:
  - agent: codex
    home: ~/.codex
  - agent: codex
    profiles: all
  - agent: claude
    dir: ~/.claude
  - agent: claude
    profiles: all
targets:
  - name: local
    duckdb: ~/history/agents.duckdb
  # - name: cloud
  #   motherduck: agent_history
  #   token_env: MOTHERDUCK_TOKEN
"""

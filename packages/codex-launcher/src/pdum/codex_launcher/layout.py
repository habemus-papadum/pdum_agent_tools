"""Profile directories are Codex homes; launcher state lives in one dotted subdirectory."""

from __future__ import annotations

import os
from pathlib import Path

LAUNCHER_DIR = ".pdum"
"""Name of the launcher-owned subdirectory inside every profile (Codex home)."""

ISOLATED_HOME_DIRECTORIES = (
    "home/.config",
    "home/.cache",
    "home/.local/share",
    "home/.local/state",
    "work",
    "runtime/tmp",
    "runtime/runs",
)
"""Launcher-owned directories created under ``LAUNCHER_DIR`` for a managed profile."""


def default_codex_home() -> Path:
    """Return the Codex home the user's own CLI would use, without creating it.

    Returns
    -------
    Path
        ``$CODEX_HOME`` when set, otherwise ``~/.codex``, resolved.
    """
    return Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()


def launcher_dir(profile: Path) -> Path:
    """Return the launcher-owned subdirectory of a profile."""
    return profile / LAUNCHER_DIR


def launcher_toml(profile: Path) -> Path:
    """Return the launcher metadata file of a profile; it may not exist for a bare home."""
    return profile / LAUNCHER_DIR / "launcher.toml"


def isolated_home(profile: Path) -> Path:
    """Return the isolated ``HOME`` root used when a profile isolates its environment."""
    return profile / LAUNCHER_DIR / "home"


def work_dir(profile: Path) -> Path:
    """Return the neutral working directory used when a profile isolates its environment."""
    return profile / LAUNCHER_DIR / "work"


def runtime_dir(profile: Path) -> Path:
    """Return the runtime directory holding run records, logs and the mutation lock."""
    return profile / LAUNCHER_DIR / "runtime"


def runs_dir(profile: Path) -> Path:
    """Return the directory containing one subdirectory per launcher run."""
    return profile / LAUNCHER_DIR / "runtime" / "runs"


def is_managed_profile(profile: Path) -> bool:
    """Return whether launcher metadata exists; a bare Codex home is still launchable."""
    return launcher_toml(profile).is_file()


def legacy_layout(profile: Path) -> bool:
    """Detect the retired wrapper layout with ``launcher.toml`` beside a ``codex/`` home."""
    return (profile / "launcher.toml").is_file() and (profile / "codex").is_dir()

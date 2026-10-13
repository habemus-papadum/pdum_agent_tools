"""Directory profiles that allow independent concurrent Claude workers."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import platformdirs

from .authentication import AuthSpec
from .errors import ProfileError


@dataclass(frozen=True)
class Profile:
    """Host-side launch choices, separate from native Claude settings."""

    directory: Path
    workspace: Path
    executable: str = "claude"
    model: str = "haiku"
    setting_sources: tuple[str, ...] = ("user", "project")
    auth: AuthSpec = AuthSpec()

    def __post_init__(self) -> None:
        object.__setattr__(self, "directory", Path(self.directory).expanduser().resolve())
        object.__setattr__(self, "workspace", Path(self.workspace).expanduser().resolve())
        object.__setattr__(self, "setting_sources", tuple(self.setting_sources))
        if not isinstance(self.executable, str) or not self.executable.strip() or "\x00" in self.executable:
            raise ProfileError("A nonempty Claude executable path or command is required")
        if "/" in self.executable or "\\" in self.executable or self.executable.startswith("~"):
            object.__setattr__(self, "executable", str(Path(self.executable).expanduser().resolve()))
        if not isinstance(self.model, str) or not self.model.strip() or "\x00" in self.model:
            raise ProfileError("A nonempty Claude model is required")
        if any(source not in {"user", "project", "local"} for source in self.setting_sources):
            raise ProfileError("Setting sources must be user, project, or local")
        if len(set(self.setting_sources)) != len(self.setting_sources):
            raise ProfileError("Setting sources must not contain duplicates")
        if not isinstance(self.auth, AuthSpec):
            raise ProfileError("Profile authentication must be an AuthSpec")

    @property
    def config_directory(self) -> Path:
        """Return the native CLAUDE_CONFIG_DIR."""
        return self.directory / "claude"

    @property
    def anthropic_directory(self) -> Path:
        """Return an isolated root for native Anthropic provider profiles."""
        return self.directory / "anthropic"

    def validate_paths(self) -> None:
        """Reject missing state or redirected credential/settings roots."""
        if not self.directory.is_dir():
            raise ProfileError(f"Profile directory does not exist: {self.directory}")
        if not self.workspace.is_dir():
            raise ProfileError(f"Workspace directory does not exist: {self.workspace}")
        for directory in (self.config_directory, self.anthropic_directory):
            if directory.is_symlink() or not directory.is_dir():
                raise ProfileError(f"Profile configuration root must be an ordinary directory: {directory}")


def default_profiles_directory() -> Path:
    """Return the platform-specific root for named profiles.

    Returns
    -------
    Path
        Default root used by CLI profile selection.
    """
    return platformdirs.user_data_path("pdum-claude", appauthor=False) / "profiles"


def resolve_profile(name: str | None = None, directory: Path | None = None, root: Path | None = None) -> Path:
    """Resolve mutually exclusive named and directory profile selectors.

    Parameters
    ----------
    name : str or None
        Profile name under the selected root.
    directory : Path or None
        Explicit profile directory, exclusive of name and root.
    root : Path or None
        Root for named profiles, defaulting to the platform data directory.

    Returns
    -------
    Path
        Canonical profile directory without creating it.
    """
    if directory is not None:
        if name is not None or root is not None:
            raise ProfileError("--profile-dir cannot be combined with --profile or --profiles-dir")
        return directory.expanduser().resolve()
    if name is None or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name) is None:
        raise ProfileError("Select a profile name of 1–64 letters, digits, dots, underscores or hyphens")
    return ((root or default_profiles_directory()).expanduser() / name).resolve()


def resolve_executable(executable: str) -> Path:
    """Resolve a native executable without invoking a shell.

    Parameters
    ----------
    executable : str
        Command on PATH or an explicit executable path.

    Returns
    -------
    Path
        Canonical executable path.
    """
    candidate = Path(executable).expanduser()
    if candidate.is_absolute() or "/" in executable or "\\" in executable:
        resolved = candidate.resolve()
    else:
        found = shutil.which(executable)
        if found is None:
            raise ProfileError(f"Claude executable was not found on PATH: {executable}")
        resolved = Path(found).resolve()
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise ProfileError(f"Claude executable is not an executable file: {resolved}")
    return resolved


def create_profile(
    directory: Path,
    *,
    workspace: Path,
    executable: str = "claude",
    model: str = "haiku",
    setting_sources: tuple[str, ...] = ("user", "project"),
    auth: AuthSpec = AuthSpec(),
    native_settings: Path | None = None,
) -> Profile:
    """Create a new profile without launching Claude or reading credentials.

    Parameters
    ----------
    directory : Path
        New profile directory; existing paths are never overwritten.
    workspace : Path
        Existing working directory shared by the profile's workers.
    executable : str
        Native Claude command or executable path.
    model : str
        Default native model selection.
    setting_sources : tuple of str
        Native settings scopes, including an empty tuple to disable them.
    auth : AuthSpec
        Credential references only; resolution happens at launch.
    native_settings : Path or None
        Optional native settings.json copied byte-for-byte. Other developer
        configuration, agents, history, and credentials are not copied.

    Returns
    -------
    Profile
        Created profile. No exclusive profile lease is acquired.
    """
    profile = Profile(directory, workspace, executable, model, setting_sources, auth)
    if not profile.workspace.is_dir():
        raise ProfileError(f"Workspace directory does not exist: {profile.workspace}")
    if profile.directory == profile.workspace or profile.directory in profile.workspace.parents:
        raise ProfileError("Create the profile outside its workspace to avoid state/path collisions")
    if directory.expanduser().is_symlink() or profile.directory.exists():
        raise ProfileError(f"Profile already exists: {profile.directory}")
    native_content = b'{\n  "permissions": {"defaultMode": "bypassPermissions"},\n  "sandbox": {"enabled": false}\n}\n'
    if native_settings is not None:
        try:
            native_content = native_settings.expanduser().read_bytes()
            if not isinstance(json.loads(native_content), dict):
                raise ValueError
        except (OSError, ValueError, UnicodeDecodeError):
            raise ProfileError("The native settings source must be a readable JSON object") from None
    metadata = {
        "schema_version": 1,
        "workspace": str(profile.workspace),
        "executable": profile.executable,
        "model": profile.model,
        "setting_sources": list(profile.setting_sources),
        "authentication": {
            "method": auth.method,
            "api_key_env": auth.api_key_env,
            "source_directory": str(auth.source_directory) if auth.source_directory else None,
        },
    }
    profile.directory.parent.mkdir(parents=True, exist_ok=True)
    try:
        profile.directory.mkdir(mode=0o700)
    except FileExistsError:
        raise ProfileError(f"Profile already exists: {profile.directory}") from None
    try:
        for root in (profile.config_directory, profile.anthropic_directory):
            root.mkdir(mode=0o700)
        for destination, content in (
            (profile.directory / "profile.json", (json.dumps(metadata, indent=2) + "\n").encode()),
            (profile.config_directory / "settings.json", native_content),
        ):
            with destination.open("xb") as stream:
                stream.write(content)
            destination.chmod(0o600)
    except BaseException:
        shutil.rmtree(profile.directory)
        raise
    return profile


def load_profile(directory: Path) -> Profile:
    """Load launcher metadata without parsing or rewriting native settings.

    Parameters
    ----------
    directory : Path
        Existing profile directory.

    Returns
    -------
    Profile
        Validated launch metadata and paths, containing no resolved credentials.
    """
    directory = directory.expanduser().resolve()
    try:
        value = json.loads((directory / "profile.json").read_text())
        if not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["schema_version"] != 1:
            raise ValueError
        authentication = value["authentication"]
        if not isinstance(authentication, dict):
            raise ValueError
        source = authentication.get("source_directory")
        if source is not None and (not isinstance(source, str) or not Path(source).is_absolute()):
            raise ValueError
        workspace = value["workspace"]
        if not isinstance(workspace, str) or not Path(workspace).is_absolute():
            raise ValueError
        sources = value["setting_sources"]
        if not isinstance(sources, list) or any(not isinstance(item, str) for item in sources):
            raise ValueError
        profile = Profile(
            directory,
            Path(workspace),
            value["executable"],
            value["model"],
            tuple(sources),
            AuthSpec(authentication["method"], authentication.get("api_key_env", "ANTHROPIC_API_KEY"), source),
        )
        profile.validate_paths()
        return profile
    except (OSError, ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise ProfileError(f"Profile metadata is missing or malformed: {directory}") from None


def list_profiles(root: Path | None = None) -> tuple[Profile, ...]:
    """List profiles under a named-profile root without inspecting credentials.

    Parameters
    ----------
    root : Path or None
        Named-profile root, defaulting to the platform data directory.

    Returns
    -------
    tuple of Profile
        Profiles sorted by directory name. Malformed profiles produce a useful
        error rather than silently disappearing from the listing.
    """
    selected = (root or default_profiles_directory()).expanduser().resolve()
    if not selected.exists():
        return ()
    return tuple(load_profile(child) for child in sorted(selected.iterdir()) if (child / "profile.json").is_file())


@contextmanager
def temporary_profile(
    *,
    workspace: Path,
    executable: str = "claude",
    model: str = "haiku",
    setting_sources: tuple[str, ...] = ("user", "project"),
    auth: AuthSpec = AuthSpec(),
) -> Iterator[Profile]:
    """Own a temporary profile directory, removing it when its caller exits.

    Parameters
    ----------
    workspace : Path
        Existing workspace. This directory is never removed by cleanup.
    executable : str
        Native Claude command or path.
    model : str
        Default native model.
    setting_sources : tuple of str
        Native settings scope selection.
    auth : AuthSpec
        Authentication references. Temporary borrowed credentials are not copied.

    Yields
    ------
    Profile
        Temporary profile. The caller must stop its workers before leaving the
        context. Do not use native login in a temporary profile: deleting files
        does not remove a credential that Claude saved in the macOS Keychain.
    """
    with tempfile.TemporaryDirectory(prefix="pdum-claude-") as root:
        yield create_profile(
            Path(root) / "profile",
            workspace=workspace,
            executable=executable,
            model=model,
            setting_sources=setting_sources,
            auth=auth,
        )

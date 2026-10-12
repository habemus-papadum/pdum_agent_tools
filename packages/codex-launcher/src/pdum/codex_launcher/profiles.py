"""Directory-based profiles and convenient isolated temporary work."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
import tomllib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

import platformdirs
import tomlkit

from .config import atomic_write, complete_file_operation, edit_native_config, read_config, resolve_executable
from .errors import ProfileError


@dataclass(frozen=True)
class ProfileSpec:
    """Inputs for a new profile, without a second native configuration schema."""

    executable: str | Path | None = None
    model: str | None = None
    source: Path | None = None
    copy_auth: bool = False
    auth_source: Path | None = None
    copy_skills: bool = True
    environment: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ProfileInfo:
    """Non-secret profile summary and warning data."""

    directory: Path
    executable: Path | None = None
    auth_file_present: bool = False
    warnings: tuple[str, ...] = ()
    error: str | None = None


def default_profiles_directory() -> Path:
    """Return the platform-specific CLI profile root.

    Returns
    -------
    Path
        Root used only by name-based CLI selection.
    """
    return platformdirs.user_data_path("pdum-codex", appauthor=False) / "profiles"


def resolve_profile(name: str | None = None, directory: Path | None = None, root: Path | None = None) -> Path:
    """Resolve exclusive CLI selectors without creating a profile.

    Parameters
    ----------
    name : str or None
        Profile name under the selected root.
    directory : Path or None
        Exact profile directory, exclusive of name and root.
    root : Path or None
        Root for named profiles.

    Returns
    -------
    Path
        Canonical profile path.
    """
    if directory is not None:
        if name is not None or root is not None:
            raise ProfileError("--profile-dir cannot be combined with --profile or --profiles-dir")
        return directory.expanduser().resolve()
    if name is None:
        raise ProfileError("Select --profile NAME or --profile-dir PATH")
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name) is None:
        raise ProfileError("Profile names must be 1–64 letters, digits, dots, underscores or hyphens")
    return ((root or default_profiles_directory()).expanduser() / name).resolve()


def _copy_skills(
    source: Path, destination: Path, warnings: list[str], ancestors: frozenset[Path] = frozenset()
) -> None:
    try:
        resolved = source.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ProfileError(f"Cannot resolve skill entry: {source}") from error
    if resolved in ancestors:
        raise ProfileError(f"Cyclic skills path: {source}")
    if source.is_symlink():
        warnings.append(f"Materialized skill symlink: {source.name}; the source is not modified.")
    if resolved.is_dir():
        destination.mkdir(mode=0o700)
        for child in sorted(resolved.iterdir()):
            _copy_skills(child, destination / child.name, warnings, ancestors | {resolved})
    elif resolved.is_file():
        shutil.copy2(resolved, destination)
        destination.chmod(0o600 | (resolved.stat().st_mode & 0o111))
    else:
        raise ProfileError(f"Unsupported skills entry: {source}")


def _create(directory: Path, specification: ProfileSpec) -> ProfileInfo:
    directory = directory.expanduser().resolve()
    if directory.exists():
        raise ProfileError(f"Profile already exists: {directory}")
    source = specification.source.expanduser().resolve() if specification.source else None
    source_config = read_config(source) if source else None
    executable = resolve_executable(specification.executable or (source_config.executable if source_config else None))
    directory.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{directory.name}.creating-", dir=directory.parent))
    warnings: list[str] = []
    try:
        for relative in (
            "codex",
            "home/.config",
            "home/.cache",
            "home/.local/share",
            "home/.local/state",
            "work",
            "runtime/tmp",
            "runtime/runs",
        ):
            (staging / relative).mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = tomlkit.parse((source / "launcher.toml").read_text()) if source else tomlkit.document()
        metadata["schema_version"] = 1
        metadata["executable"] = {"path": str(executable)}
        if specification.environment:
            environment = metadata.setdefault("environment", {})
            saved = dict(environment.get("values", {}))
            saved.update(specification.environment)
            environment["values"] = saved
        atomic_write(staging / "launcher.toml", tomlkit.dumps(metadata))
        native_source = source / "codex" / "config.toml" if source else None
        if native_source and native_source.exists():
            atomic_write(staging / "codex" / "config.toml", native_source.read_bytes())
            warnings.append("Copied native config unchanged; it may contain credentials and shared external paths.")
        else:
            edit_native_config(
                staging,
                {
                    "sandbox_mode": "danger-full-access",
                    "approval_policy": "never",
                    "cli_auth_credentials_store": "file",
                },
            )
        if specification.model is not None:
            edit_native_config(staging, {"model": specification.model})
        if source and specification.copy_skills and (source / "codex" / "skills").exists():
            _copy_skills(source / "codex" / "skills", staging / "codex" / "skills", warnings)
        auth_source = specification.auth_source
        if specification.copy_auth and auth_source is None and source:
            auth_source = source / "codex" / "auth.json"
        if specification.copy_auth and auth_source is not None:
            auth_source = auth_source.expanduser()
            if auth_source.is_dir():
                auth_source /= "auth.json"
            if auth_source.is_symlink():
                raise ProfileError("Auth snapshot source must be a regular file, not a symlink")
            if auth_source.is_file():
                atomic_write(staging / "codex" / "auth.json", auth_source.read_bytes())
                warnings.append(
                    "Copied auth.json; separate refresh owners can invalidate either session. No source writes occur."
                )
            else:
                warnings.append("No auth.json was available to copy; configure native auth or log in to this profile.")
        try:
            staging.rename(directory)
        except OSError as error:
            raise ProfileError(f"Cannot publish profile; target may already exist: {directory}") from error
        return ProfileInfo(directory, executable, (directory / "codex" / "auth.json").exists(), tuple(warnings))
    finally:
        if staging.exists():
            shutil.rmtree(staging)


async def create_profile(directory: Path, specification: ProfileSpec | None = None) -> ProfileInfo:
    """Create a complete profile atomically without copying sessions or runtime state.

    Parameters
    ----------
    directory : Path
        New profile directory; existing destinations are errors.
    specification : ProfileSpec or None
        Creation and copying choices.

    Returns
    -------
    ProfileInfo
        Created directory and non-blocking warnings.
    """
    creation = asyncio.create_task(asyncio.to_thread(_create, directory, specification or ProfileSpec()))
    try:
        return await asyncio.shield(creation)
    except asyncio.CancelledError:
        await creation
        raise


async def inspect_profile(directory: Path) -> ProfileInfo:
    """Read profile metadata without refreshing credentials or changing state.

    Parameters
    ----------
    directory : Path
        Existing profile directory.

    Returns
    -------
    ProfileInfo
        Non-secret profile information.
    """
    path = directory.expanduser().resolve()
    config = await asyncio.to_thread(read_config, path)
    return ProfileInfo(path, config.executable, (path / "codex" / "auth.json").exists())


async def list_profiles(root: Path) -> list[ProfileInfo]:
    """List profile summaries, retaining individual malformed-profile errors.

    Parameters
    ----------
    root : Path
        Directory containing named profiles.

    Returns
    -------
    list of ProfileInfo
        Sorted summaries; unrelated directories are ignored.
    """
    directories = await asyncio.to_thread(lambda: sorted(root.expanduser().glob("*/launcher.toml")))
    result = []
    for metadata in directories:
        try:
            result.append(await inspect_profile(metadata.parent))
        except ProfileError as error:
            result.append(ProfileInfo(metadata.parent, error=str(error)))
    return result


@asynccontextmanager
async def temporary_profile(
    specification: ProfileSpec | None = None,
    *,
    clean: bool = False,
    copy_auth: bool = True,
    keep: bool = False,
    parent: Path | None = None,
) -> AsyncIterator[ProfileInfo]:
    """Create temporary profile state and remove it after its managed processes stop.

    Parameters
    ----------
    specification : ProfileSpec or None
        Optional source/model/executable choices.
    clean : bool
        Do not borrow current authentication; conflicts with source or auth choices.
    copy_auth : bool
        Conveniently snapshot available source/current file-backed auth.
    keep : bool
        Retain the temporary directory after the context exits.
    parent : Path or None
        Optional existing parent for temporary directories.

    Yields
    ------
    ProfileInfo
        Created profile and credential-reuse warnings.
    """
    from dataclasses import replace

    from .runtime import dispose_profile

    selected = specification or ProfileSpec()
    if clean and (selected.source is not None or selected.auth_source is not None or selected.copy_auth):
        raise ProfileError("Clean temporary profiles cannot also copy settings or borrow authentication")
    auth_source = selected.auth_source
    if not clean and copy_auth and auth_source is None and selected.source is None:
        auth_source = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "auth.json"
    selected = replace(selected, copy_auth=not clean and copy_auth, auth_source=auth_source)
    container = Path(tempfile.mkdtemp(prefix="pdum-codex-", dir=parent))
    directory = container / "profile"
    primary_error = None
    try:
        info = await create_profile(directory, selected)
        yield info
    except BaseException as error:
        primary_error = error
        raise
    finally:
        if not keep:
            try:
                if directory.exists():
                    await dispose_profile(directory)
                await complete_file_operation(container.rmdir)
            except BaseException as cleanup_error:
                if primary_error is None:
                    raise
                primary_error.add_note(f"Temporary profile cleanup failed; inspect {directory}: {cleanup_error}")


async def configure_api_key(directory: Path, environment_variable: str, base_url: str | None = None) -> None:
    """Configure a native Responses provider using an environment reference.

    Parameters
    ----------
    directory : Path
        Stopped profile directory.
    environment_variable : str
        Parent environment name inherited at launch; never a literal token.
    base_url : str or None
        Optional native provider endpoint.
    """
    from .authentication import AuthSpec
    from .workflow import ProfileEdit, load_profile_draft, prepare_edit, save_profile_edit

    draft = await load_profile_draft(directory, existing=True)
    edit = ProfileEdit(auth=AuthSpec("api-key", environment_variable, base_url), import_assets=False)
    await save_profile_edit(prepare_edit(draft, edit))


async def native_config(directory: Path) -> dict:
    """Read native TOML for deliberate inspection, without schema interpretation.

    Parameters
    ----------
    directory : Path
        Existing profile directory.

    Returns
    -------
    dict
        Native values, which can include credentials; do not routinely log them.
    """
    return await asyncio.to_thread(lambda: tomllib.loads((directory / "codex" / "config.toml").read_text()))

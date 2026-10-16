"""Prepare and publish profile edits without writing during the interview."""

from __future__ import annotations

import asyncio
import copy
import shutil
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path

import tomlkit

from .authentication import AuthSpec, apply_auth, auth_handled_paths, inspect_auth
from .config import SCHEMA_VERSION, atomic_write, complete_file_operation, read_config, resolve_executable
from .errors import ProfileError
from .imports import (
    ImportPlan,
    ImportSelection,
    SourceInventory,
    apply_import_assets,
    build_import_plan,
    empty_inventory,
    inventory_source,
)
from .layout import LAUNCHER_DIR, launcher_toml
from .profiles import ProfileInfo, create_launcher_directories

LAUNCHER_METADATA = Path(f"{LAUNCHER_DIR}/launcher.toml")


@dataclass(frozen=True)
class ProfileDraft:
    """Read-only source and destination snapshots for a profile edit.

    ``managed`` is False when editing a bare Codex home that has no launcher metadata
    yet; saving then adopts it with environment isolation off, preserving native behavior.
    """

    directory: Path
    inventory: SourceInventory
    existing: bool
    native_toml: str
    launcher_toml: str
    managed: bool = True


def default_launcher_toml(*, adopt_bare_home: bool = False) -> str:
    """Return launcher metadata text for a new profile or an adopted bare home."""
    if adopt_bare_home:
        return f'schema_version = {SCHEMA_VERSION}\n\n[environment]\nmode = "inherit"\nisolate = false\n'
    return f"schema_version = {SCHEMA_VERSION}\n"


@dataclass(frozen=True)
class ProfileEdit:
    """Interview or library choices; None preserves the corresponding source value."""

    selection: ImportSelection = field(default_factory=ImportSelection)
    model: str | None = None
    executable: Path | None = None
    auth: AuthSpec = field(default_factory=AuthSpec)
    copy_auth: bool = False
    remaining_toml: str | None = None
    login_after: bool = False
    import_assets: bool = True


@dataclass(frozen=True)
class PreparedEdit:
    """Validated proposed text and an asset plan, not yet published."""

    draft: ProfileDraft
    edit: ProfileEdit
    native_toml: str
    launcher_toml: str
    plan: ImportPlan
    handled_paths: tuple[tuple[str, ...], ...]
    warnings: tuple[str, ...]


def _load(directory: Path, source: Path | None, clean: bool, existing: bool) -> ProfileDraft:
    directory = directory.expanduser().resolve()
    managed = True
    if existing:
        if source is not None or clean:
            raise ProfileError("Configure starts from the selected profile, not an import source or --clean")
        managed = read_config(directory).managed
        inventory = inventory_source(directory)
    else:
        if directory.exists():
            raise ProfileError(f"Profile destination already exists: {directory}")
        if clean and source is not None:
            raise ProfileError("Choose an import source or --clean, not both")
        inventory = empty_inventory() if clean else inventory_source(source)
    native = inventory.native_toml
    if not native.strip() and not existing:
        native = 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\ncli_auth_credentials_store = "file"\n'
    launcher = inventory.launcher_toml or default_launcher_toml(adopt_bare_home=existing and not managed)
    return ProfileDraft(directory, inventory, existing, native, launcher, managed)


async def load_profile_draft(
    directory: Path, *, source: Path | None = None, clean: bool = False, existing: bool = False
) -> ProfileDraft:
    """Read an existing profile or prepare creation from a native home.

    Parameters
    ----------
    directory : Path
        Exact destination profile directory.
    source : Path or None
        Native home or managed profile. New profiles default to the ordinary native home.
    clean : bool
        Start fresh rather than importing a source; creation only.
    existing : bool
        Edit this profile, using its current configuration as the baseline.

    Returns
    -------
    ProfileDraft
        No destination files are created or modified.
    """
    return await asyncio.to_thread(_load, directory, source, clean, existing)


def _lookup(document, path: tuple[str, ...]):
    current = document
    for key in path:
        if not isinstance(current, Mapping) or key not in current:
            return False, None
        current = current[key]
    return True, current


def _remove(document, path: tuple[str, ...]) -> None:
    parent = document
    ancestors = []
    for key in path[:-1]:
        if not isinstance(parent.get(key), Mapping):
            return
        ancestors.append((parent, key))
        parent = parent[key]
    parent.pop(path[-1], None)
    for ancestor, key in reversed(ancestors):
        if not ancestor[key]:
            del ancestor[key]


def _insert(document, path: tuple[str, ...], value) -> None:
    parent = document
    for key in path[:-1]:
        if key in parent and not isinstance(parent[key], Mapping):
            raise ProfileError(f"Edited TOML conflicts with represented setting: {'.'.join(path)}")
        parent = parent.setdefault(key, tomlkit.table())
    parent[path[-1]] = copy.deepcopy(value)


def remaining_config(prepared: PreparedEdit) -> str:
    """Return native TOML not represented by the selected interview controls."""
    document = tomlkit.parse(prepared.native_toml)
    for path in prepared.handled_paths:
        _remove(document, path)
    return tomlkit.dumps(document)


def prepare_edit(draft: ProfileDraft, edit: ProfileEdit | None = None) -> PreparedEdit:
    """Calculate a profile edit without persisting it or acquiring credentials.

    Parameters
    ----------
    draft : ProfileDraft
        Immutable source/destination snapshot.
    edit : ProfileEdit or None
        Selections and optional edited remainder. Represented keys cannot be reintroduced there.

    Returns
    -------
    PreparedEdit
        Proposed native settings, launcher metadata and copies to perform on save.
    """
    edit = edit or ProfileEdit()
    inventory = replace(draft.inventory, native_toml=draft.native_toml)
    plan = (
        build_import_plan(inventory, edit.selection, draft.directory)
        if edit.import_assets
        else ImportPlan(draft.native_toml, (), (), (), ())
    )
    native = tomlkit.parse(plan.native_toml)
    launcher = tomlkit.parse(draft.launcher_toml)
    executable = edit.executable or launcher.get("executable", {}).get("path")
    executable_base = draft.inventory.source_directory if edit.executable is None else None
    launcher["schema_version"] = SCHEMA_VERSION
    launcher["executable"] = {"path": str(resolve_executable(executable, base=executable_base))}
    paths = list(plan.handled_paths)
    warnings = list(plan.warnings)
    auth = edit.auth
    if not draft.existing and draft.inventory.is_profile and auth.method == "preserve":
        inspection = inspect_auth(draft.native_toml, draft.launcher_toml, draft.inventory.source_directory)
        warnings.extend(inspection.warnings)
        if inspection.spec.method == "aws-federation":
            auth = inspection.spec
            warnings.append("Rebased the launcher-owned federation helper to the new profile directory.")
    if edit.model is not None:
        if not edit.model.strip():
            raise ProfileError("Model must be nonempty when supplied")
        native["model"] = edit.model
        paths.append(("model",))
    if edit.model is not None or auth.method != "preserve":
        paths.append(("profile",))
        if native.pop("profile", None) is not None:
            warnings.append(
                "Cleared the active native profile selector so explicit choices apply; named tables remain."
            )
    paths.extend(auth_handled_paths(tomlkit.dumps(native), tomlkit.dumps(launcher), auth))
    native_text, launcher_text = apply_auth(tomlkit.dumps(native), tomlkit.dumps(launcher), auth, draft.directory)
    native = tomlkit.parse(native_text)
    if auth.method != "preserve":
        current = tomlkit.parse(launcher_text).get("authentication", {}).get("owned_provider")
        if current is not None:
            paths.append(("model_providers", current))
    handled = tuple(dict.fromkeys(paths))
    if edit.remaining_toml is not None:
        try:
            remainder = tomlkit.parse(edit.remaining_toml)
        except ValueError as error:
            raise ProfileError(f"Edited native TOML is invalid: {error}") from error
        for path in handled:
            for depth in range(1, len(path)):
                exists, parent = _lookup(remainder, path[:depth])
                if exists and not isinstance(parent, Mapping):
                    raise ProfileError(f"Edited TOML conflicts with represented setting: {'.'.join(path)}")
            present, _ = _lookup(remainder, path)
            if present:
                raise ProfileError(
                    f"Edit only the remaining TOML; {'.'.join(path)} is already represented in the interview"
                )
        for path in handled:
            present, value = _lookup(native, path)
            if present:
                _insert(remainder, path, value)
        native = remainder
    if edit.copy_auth:
        if draft.existing:
            raise ProfileError("Credential snapshots are a creation action; use auth login to update this profile")
        if draft.inventory.auth_file is None:
            warnings.append("No file-backed auth.json is available to copy; log in after creation if needed.")
        else:
            warnings.append(
                "Copying auth.json; independent refresh owners may invalidate either session. Source is unchanged."
            )
    return PreparedEdit(draft, edit, tomlkit.dumps(native), launcher_text, plan, handled, tuple(warnings))


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _save(prepared: PreparedEdit) -> ProfileInfo:
    draft = prepared.draft
    directory = draft.directory
    if draft.existing:
        native_path = directory / "config.toml"
        metadata_path = launcher_toml(directory)
        current_native = native_path.read_text() if native_path.is_file() else ""
        current_launcher = metadata_path.read_text() if metadata_path.is_file() else draft.launcher_toml
        if current_native != draft.native_toml or current_launcher != draft.launcher_toml:
            raise ProfileError("Profile changed since this interview started; reopen it before saving")
    elif directory.exists():
        raise ProfileError(f"Profile destination already exists: {directory}")
    for source, _ in prepared.plan.assets:
        if directory.parent.is_relative_to(source.resolve()):
            raise ProfileError(f"Profile staging would be inside a selected source asset: {source}")
    directory.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{directory.name}.editing-", dir=directory.parent))
    backup = staging / ".previous"
    retain_recovery = False
    try:
        create_launcher_directories(staging)
        atomic_write(launcher_toml(staging), prepared.launcher_toml)
        atomic_write(staging / "config.toml", prepared.native_toml)
        config = read_config(staging)
        apply_import_assets(prepared.plan, staging)
        if prepared.edit.copy_auth and draft.inventory.auth_file is not None:
            source = draft.inventory.auth_file
            if source.is_symlink() or not source.is_file():
                raise ProfileError("Auth snapshot source must be a regular file")
            atomic_write(staging / "auth.json", source.read_bytes())
        if not draft.existing:
            if directory.exists():
                raise ProfileError(f"Profile destination already exists: {directory}")
            staging.rename(directory)
        else:
            changed = []
            replacements = (*prepared.plan.replacement_roots, Path("config.toml"), LAUNCHER_METADATA)
            for relative in replacements:
                if not (directory / relative).parent.resolve().is_relative_to(directory):
                    raise ProfileError(f"Profile path redirects writes outside its directory: {relative}")
            try:
                for relative in replacements:
                    target = directory / relative
                    original = backup / relative
                    replacement = staging / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists() or target.is_symlink():
                        original.parent.mkdir(parents=True, exist_ok=True)
                        target.rename(original)
                    changed.append(relative)
                    if replacement.exists():
                        replacement.rename(target)
            except BaseException as error:
                failures = []
                for relative in reversed(changed):
                    try:
                        target = directory / relative
                        original = backup / relative
                        _remove_path(target)
                        if original.exists() or original.is_symlink():
                            original.rename(target)
                    except OSError as rollback_error:
                        failures.append(f"{relative}: {rollback_error}")
                if failures:
                    retain_recovery = True
                    raise ProfileError(
                        f"Profile update and rollback failed; originals retained in {backup}. " + "; ".join(failures)
                    ) from error
                raise
        return ProfileInfo(
            directory,
            config.executable,
            (directory / "auth.json").exists(),
            prepared.warnings,
            isolate=config.isolate,
        )
    finally:
        if staging.exists() and not retain_recovery:
            shutil.rmtree(staging)


async def save_profile_edit(prepared: PreparedEdit) -> ProfileInfo:
    """Publish an edit under the profile mutation lock, rolling back ordinary write failures.

    Parameters
    ----------
    prepared : PreparedEdit
        Edit returned by prepare_edit; login is a separate explicit action.

    Returns
    -------
    ProfileInfo
        Saved profile and nonfatal import/credential warnings. Multi-file updates
        roll back exceptions, but are not a power-loss-atomic filesystem transaction.
        Running app-servers are not stopped; Codex reads configuration per thread.
    """
    from .runtime import mutation_lock

    if prepared.draft.existing:
        async with mutation_lock(prepared.draft.directory):
            return await complete_file_operation(lambda: _save(prepared))
    return await complete_file_operation(lambda: _save(prepared))

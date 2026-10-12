"""Experimental, read-only discovery and selective copying of native Codex state."""

from __future__ import annotations

import os
import re
import shutil
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import tomlkit

from .errors import ProfileError

Selection = Literal["all", "none"] | tuple[str, ...]
HANDLED_PATHS = (("marketplaces",), ("plugins",), ("mcp_servers",), ("skills", "config"))


@dataclass(frozen=True)
class ImportChoice:
    """One selectable native entry, identified independently of its display label."""

    id: str
    label: str
    source_path: Path | None = None
    destination: Path | None = None
    rule_indexes: tuple[int, ...] = ()


@dataclass(frozen=True)
class SourceInventory:
    """Native source contents without login, process launch or source mutation."""

    source_directory: Path
    codex_home: Path
    is_profile: bool
    native_toml: str
    launcher_toml: str | None
    auth_file: Path | None
    marketplaces: tuple[ImportChoice, ...]
    plugins: tuple[ImportChoice, ...]
    mcp_servers: tuple[ImportChoice, ...]
    skills: tuple[ImportChoice, ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class ImportSelection:
    """Select every, no, or explicitly named entries from each inventory category."""

    marketplaces: Selection = "all"
    plugins: Selection = "all"
    mcp_servers: Selection = "all"
    skills: Selection = "all"


@dataclass(frozen=True)
class ImportPlan:
    """Filtered native TOML and source-to-profile-relative asset copies."""

    native_toml: str
    assets: tuple[tuple[Path, Path], ...]
    warnings: tuple[str, ...]
    handled_paths: tuple[tuple[str, ...], ...] = HANDLED_PATHS
    replacement_roots: tuple[Path, ...] = (
        Path("codex/skills"),
        Path("home/.agents/skills"),
        Path("codex/plugins/cache"),
        Path("codex/.tmp/marketplaces"),
    )


def default_native_home() -> Path:
    """Return the ordinary native Codex home, without creating it."""
    return Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()


def empty_inventory() -> SourceInventory:
    """Return a clean source with no configuration or assets to import."""
    return SourceInventory(Path("/"), Path("/"), False, "", None, None, (), (), (), ())


def _read(path: Path) -> str:
    try:
        return path.read_text() if path.exists() else ""
    except OSError as error:
        raise ProfileError(f"Cannot read import source: {path}") from error


def _document(content: str):
    try:
        return tomlkit.parse(content)
    except ValueError as error:
        raise ProfileError("Import source has invalid native TOML") from error


def _table(document: Mapping, key: str) -> Mapping:
    value = document.get(key, {})
    if not isinstance(value, Mapping):
        raise ProfileError(f"Cannot selectively import unsupported [{key}] value; expected a table")
    return value


def _segment(value: str) -> bool:
    return value not in {".", ".."} and re.fullmatch(r"[A-Za-z0-9._+-]+", value) is not None


def _source_path(value: str, home: Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else home / path


def _skill_name(path: Path) -> str:
    try:
        content = (path / "SKILL.md").read_text()
    except (OSError, UnicodeError):
        return path.name
    if content.startswith("---"):
        header = content.split("---", 2)[1]
        match = re.search(r"^name:\s*([^\n]+)", header, re.MULTILINE)
        if match:
            return match.group(1).strip().strip("\"'")
    return path.name


def _skill_directories(root: Path, warnings: list[str], ancestors: frozenset[Path] = frozenset()):
    try:
        resolved = root.resolve(strict=True)
        if resolved in ancestors:
            warnings.append(f"Skipped cyclic skill directory: {root}")
            return
        if not resolved.is_dir():
            return
        if (resolved / "SKILL.md").is_file():
            yield root
            return
        for child in sorted(resolved.iterdir()):
            if child.is_dir():
                yield from _skill_directories(root / child.name, warnings, ancestors | {resolved})
    except (OSError, RuntimeError) as error:
        warnings.append(f"Cannot inspect skill directory {root}: {type(error).__name__}")


def _skills(document: Mapping, home: Path, user_root: Path | None, warnings: list[str]) -> tuple[ImportChoice, ...]:
    choices: list[ImportChoice] = []
    roots = [("codex", home / "skills", Path("codex/skills"))]
    if user_root is not None:
        roots.append(("user", user_root, Path("home/.agents/skills")))
    for prefix, root, destination in roots:
        if not root.exists():
            continue
        for skill in _skill_directories(root, warnings):
            relative = skill.relative_to(root)
            choices.append(
                ImportChoice(
                    f"{prefix}:{relative.as_posix()}", f"{_skill_name(skill)} ({prefix})", skill, destination / relative
                )
            )
    config = _table(document, "skills").get("config", [])
    if not isinstance(config, list):
        raise ProfileError("Unsupported skills.config format; expected an array")
    for index, rule in enumerate(config):
        if not isinstance(rule, Mapping):
            raise ProfileError("Unsupported skills.config entry; expected a table")
        path = _source_path(rule["path"], home) if isinstance(rule.get("path"), str) else None
        root = path.parent if path is not None and path.name == "SKILL.md" else path
        matching = [
            position
            for position, choice in enumerate(choices)
            if (root is not None and choice.source_path is not None and root.resolve() == choice.source_path.resolve())
            or (root is None and choice.source_path is not None and rule.get("name") == _skill_name(choice.source_path))
        ]
        for position in matching:
            previous = choices[position]
            choices[position] = ImportChoice(
                previous.id, previous.label, previous.source_path, previous.destination, (*previous.rule_indexes, index)
            )
        if matching:
            continue
        if root is not None and (root / "SKILL.md").is_file():
            destination = Path("codex/skills/imported") / f"{index}-{root.name}"
            choices.append(
                ImportChoice(f"config:{index}", f"{_skill_name(root)} (configured path)", root, destination, (index,))
            )
        else:
            selector = rule.get("name", rule.get("path", f"entry {index}"))
            choices.append(
                ImportChoice(f"config:{index}", f"{selector} (configuration rule only)", rule_indexes=(index,))
            )
            warnings.append(f"Skill rule {index} has no discovered asset; it may refer to bundled or plugin skills.")
    return tuple(choices)


def inventory_source(source: Path | None = None) -> SourceInventory:
    """Inspect a native home or launcher profile without starting Codex.

    Parameters
    ----------
    source : Path or None
        Native CODEX_HOME or managed profile directory. None selects the user's
        default native home, including skills from their ordinary ~/.agents.

    Returns
    -------
    SourceInventory
        Selectable entries, untouched TOML and non-fatal discovery warnings.
    """
    directory = source.expanduser().resolve() if source is not None else default_native_home()
    if directory.exists() and not directory.is_dir():
        raise ProfileError(f"Import source is not a directory: {directory}")
    is_profile = (directory / "launcher.toml").is_file()
    home = directory / "codex" if is_profile else directory
    content = _read(home / "config.toml")
    document = _document(content)
    warnings = [
        "Experimental native importer: configuration and cache layouts may change across Codex versions.",
        "Only this home config and selected assets are imported; "
        "project/system layers, sessions and plugin data are not.",
    ]
    markets = []
    for name, config in _table(document, "marketplaces").items():
        if not _segment(name) or not isinstance(config, Mapping):
            warnings.append(f"Unsupported marketplace entry {name!r}; cannot copy its assets automatically.")
            markets.append(ImportChoice(name, f"{name} (unsupported entry)"))
            continue
        path = home / ".tmp/marketplaces" / name
        if config.get("source_type") == "local" and isinstance(config.get("source"), str):
            path = _source_path(config["source"], home)
        markets.append(ImportChoice(name, name, path, Path("codex/.tmp/marketplaces") / name))
    configured_plugins = _table(document, "plugins")
    plugin_ids = set(configured_plugins) - {"_default"}
    cache = home / "plugins/cache"
    if cache.is_dir():
        for marketplace in sorted(cache.iterdir()):
            if marketplace.is_dir() and _segment(marketplace.name):
                for plugin in sorted(marketplace.iterdir()):
                    if plugin.is_dir() and _segment(plugin.name):
                        plugin_ids.add(f"{plugin.name}@{marketplace.name}")
    plugins = []
    for identifier in sorted(plugin_ids):
        parts = identifier.split("@")
        if len(parts) != 2 or not all(_segment(part) for part in parts):
            warnings.append(f"Unsupported plugin identifier {identifier!r}; cannot copy its assets automatically.")
            plugins.append(ImportChoice(identifier, f"{identifier} (unsupported identifier)"))
            continue
        name, marketplace = parts
        path = cache / marketplace / name
        label = identifier if path.is_dir() else f"{identifier} (not installed locally)"
        plugins.append(ImportChoice(identifier, label, path, Path("codex/plugins/cache") / marketplace / name))
    user_root = directory / "home/.agents/skills" if is_profile else None
    if not is_profile and directory == default_native_home():
        user_root = Path.home() / ".agents/skills"
    mcp = tuple(ImportChoice(name, name) for name in _table(document, "mcp_servers"))
    skills = _skills(document, home, user_root, warnings)
    if "profiles" in document:
        warnings.append("Named native [profiles] remain in the TOML remainder; inspect them for overriding settings.")
    return SourceInventory(
        directory,
        home,
        is_profile,
        content,
        _read(directory / "launcher.toml") if is_profile else None,
        home / "auth.json" if (home / "auth.json").is_file() else None,
        tuple(markets),
        tuple(plugins),
        mcp,
        skills,
        tuple(warnings),
    )


def _selected(choices: tuple[ImportChoice, ...], selection: Selection, category: str) -> set[str]:
    available = {choice.id for choice in choices}
    if selection == "all":
        return available
    if selection == "none":
        return set()
    if isinstance(selection, str):
        raise ProfileError(f"Invalid {category} selection: expected all, none or a tuple of identifiers")
    selected = set(selection)
    if selected - available:
        raise ProfileError(f"Unknown {category} selections: {', '.join(sorted(selected - available))}")
    return selected


def _prune(document, key: str, selected: set[str]) -> None:
    if key not in document:
        return
    for name in tuple(document[key]):
        if name not in selected:
            del document[key][name]


def build_import_plan(inventory: SourceInventory, selection: ImportSelection, destination: Path) -> ImportPlan:
    """Filter native settings and prepare profile-local copies without writing.

    Parameters
    ----------
    inventory : SourceInventory
        Read-only inventory of the source profile/home.
    selection : ImportSelection
        All, none or individual identifiers for each supported category.
    destination : Path
        Final profile directory, used to rebase copied local path references.

    Returns
    -------
    ImportPlan
        Native TOML, profile-relative asset copies and explicit limitations.
    """
    destination = destination.expanduser().resolve()
    document = _document(inventory.native_toml)
    warnings = list(inventory.warnings)
    selected_markets = _selected(inventory.marketplaces, selection.marketplaces, "marketplaces")
    selected_plugins = _selected(inventory.plugins, selection.plugins, "plugins")
    selected_mcp = _selected(inventory.mcp_servers, selection.mcp_servers, "MCP servers")
    selected_skills = _selected(inventory.skills, selection.skills, "skills")
    assets: list[tuple[Path, Path]] = []

    def asset(choice: ImportChoice) -> bool:
        if choice.source_path is None or choice.destination is None:
            return False
        if not choice.source_path.exists():
            warnings.append(
                f"Selected asset is unavailable: {choice.id}; configuration is retained but import is incomplete."
            )
            return False
        pair = (choice.source_path, choice.destination)
        if pair not in assets:
            assets.append(pair)
        return True

    known_markets = {choice.id for choice in inventory.marketplaces}
    for choice in inventory.plugins:
        if choice.id not in selected_plugins:
            continue
        asset(choice)
        parts = choice.id.split("@")
        if len(parts) == 2:
            marketplace = parts[1]
            if marketplace in known_markets:
                if marketplace not in selected_markets:
                    warnings.append(f"Included marketplace {marketplace} required by selected plugin {choice.id}.")
                selected_markets.add(marketplace)
            else:
                warnings.append(f"No configured marketplace metadata for {choice.id}; copied installed assets only.")
    _prune(document, "marketplaces", selected_markets)
    _prune(document, "plugins", selected_plugins | {"_default"})
    _prune(document, "mcp_servers", selected_mcp)
    if selection.plugins != "all":
        original_plugins = _table(_document(inventory.native_toml), "plugins")
        original_default = _table(original_plugins, "_default").get("enabled", True)
        plugins = document.setdefault("plugins", tomlkit.table())
        plugins.setdefault("_default", tomlkit.table())["enabled"] = False
        for identifier in selected_plugins:
            selected_config = plugins.setdefault(identifier, tomlkit.table())
            if isinstance(selected_config, Mapping):
                selected_config.setdefault("enabled", original_default)
            else:
                warnings.append(f"Unsupported configuration for selected plugin {identifier!r}; inspect native TOML.")
    for choice in inventory.marketplaces:
        if choice.id not in selected_markets:
            continue
        copied = asset(choice)
        config = document["marketplaces"][choice.id]
        if copied and isinstance(config, Mapping) and config.get("source_type") == "local":
            config["source"] = str(destination / choice.destination)
    for choice in inventory.plugins:
        if choice.id in selected_plugins and choice.id not in document.get("plugins", {}):
            document.setdefault("plugins", tomlkit.table())[choice.id] = tomlkit.table()
    selected_rules: set[int] = set()
    for choice in inventory.skills:
        if choice.id in selected_skills:
            asset(choice)
            selected_rules.update(choice.rule_indexes)
    skill_table = document.get("skills", {})
    if "config" in skill_table:
        rules = skill_table["config"]
        for index, rule in enumerate(rules):
            if index not in selected_rules:
                continue
            item = rule
            if isinstance(item.get("path"), str):
                original = _source_path(item["path"], inventory.codex_home)
                for source, relative in sorted(assets, key=lambda pair: len(pair[0].parts), reverse=True):
                    try:
                        suffix = original.resolve().relative_to(source.resolve())
                    except ValueError:
                        continue
                    item["path"] = str(destination / relative / suffix)
                    break
                else:
                    warnings.append(f"Skill rule {index} retains an external path; its asset was not copied.")
        for index in range(len(rules) - 1, -1, -1):
            if index not in selected_rules:
                del rules[index]
    if selected_mcp:
        warnings.append(
            "MCP definitions are copied verbatim; executables, OAuth state and external files are not imported."
        )
    if assets:
        warnings.append(
            "Selected assets are materialized copies; embedded absolute paths inside asset files are not rewritten."
        )
    return ImportPlan(tomlkit.dumps(document), tuple(assets), tuple(warnings))


def _copy_asset(source: Path, destination: Path, ancestors: frozenset[Path] = frozenset()) -> None:
    try:
        resolved = source.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ProfileError(f"Cannot resolve selected import asset: {source}") from error
    if resolved in ancestors:
        raise ProfileError(f"Cyclic import asset: {source}")
    if resolved.is_dir():
        destination.mkdir(mode=0o700)
        for child in sorted(resolved.iterdir()):
            _copy_asset(child, destination / child.name, ancestors | {resolved})
    elif resolved.is_file():
        shutil.copy2(resolved, destination)
        destination.chmod(0o600 | (resolved.stat().st_mode & 0o111))
    else:
        raise ProfileError(f"Unsupported import asset: {source}")


def apply_import_assets(plan: ImportPlan, staging_directory: Path) -> None:
    """Materialize selected assets into staging without replacing existing entries.

    Parameters
    ----------
    plan : ImportPlan
        Previously inspected copies; source files are never modified.
    staging_directory : Path
        Caller-owned staging profile. Publication/rollback belongs to the caller.
    """
    staging = staging_directory.resolve()
    for source, relative in plan.assets:
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ProfileError(f"Invalid import destination: {relative}")
        target = staging / relative
        if not target.resolve().is_relative_to(staging):
            raise ProfileError(f"Import destination leaves staging profile: {relative}")
        if target.exists() or target.is_symlink():
            raise ProfileError(f"Import asset destination already exists: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            _copy_asset(source, target)
        except OSError as error:
            raise ProfileError(f"Cannot copy import asset: {source}") from error

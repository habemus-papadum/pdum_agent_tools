"""Explicit, owned user-systemd integration for recovery and finalization."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import uuid
from collections.abc import Sequence
from pathlib import Path


class SupportConflictError(RuntimeError):
    """An existing integration file or active run prevents the requested change."""


def _digest(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def _quote(value: str) -> str:
    if any(character in value for character in ("\n", "\r", "\0")):
        raise ValueError("Systemd command paths cannot contain newlines or NUL")
    value = value.replace("%", "%%")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _layout(root: Path, unit_dir: Path | None, python_executable: str | Path | None) -> dict:
    resolved = root.expanduser().resolve()
    prefix = "pdum-hostfork-" + _digest(str(resolved))[:16]
    directory = (
        Path(unit_dir).expanduser().absolute()
        if unit_dir is not None
        else Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "systemd" / "user"
    )
    # Keep the virtualenv spelling: resolving its Python symlink loses that venv.
    executable = str(Path(python_executable or sys.executable).expanduser().absolute())
    base = " ".join(_quote(value) for value in (executable, "-m", "pdum.hostfork", "--root", str(resolved)))
    reaper, timer, finalizer = prefix + "-reaper.service", prefix + "-reaper.timer", prefix + "-finalize@.service"
    files = {
        reaper: (
            "[Unit]\nDescription=Hostfork recovery and retention\n[Service]\nType=oneshot\n"
            f'ExecStart=:{base} "reap"\n'
            "TimeoutStartSec=120s\nTimeoutStopSec=5s\nKillMode=control-group\n"
        ),
        timer: (
            "[Unit]\nDescription=Hostfork periodic recovery\n"
            "[Timer]\nOnStartupSec=30s\nOnUnitInactiveSec=60s\nAccuracySec=5s\n"
            f"Unit={reaper}\n[Install]\nWantedBy=timers.target\n"
        ),
        finalizer: (
            "[Unit]\nDescription=Hostfork bounded finalization\n[Service]\nType=oneshot\n"
            f'ExecStart=:{base} "finalize" "%i"\n'
            "TimeoutStartSec=120s\nTimeoutStopSec=5s\nKillMode=control-group\n"
        ),
    }
    return {
        "schema_version": 1,
        "generator_version": 1,
        "root": str(resolved),
        "unit_dir": str(directory),
        "python_executable": executable,
        "prefix": prefix,
        "timer": timer,
        "reaper": reaper,
        "finalizer": finalizer,
        "manifest": str(directory / (prefix + ".json")),
        "files": files,
    }


def _manifest(layout: dict) -> dict | None:
    path = Path(layout["manifest"])
    if path.is_symlink():
        raise SupportConflictError(f"Support manifest is a symlink: {path}")
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise SupportConflictError(f"Cannot read support ownership manifest: {path}") from exc
    if (
        not isinstance(value, dict)
        or value.get("schema_version") != 1
        or value.get("root") != layout["root"]
        or value.get("unit_dir") != layout["unit_dir"]
        or value.get("prefix") != layout["prefix"]
        or not isinstance(value.get("files"), dict)
        or set(value["files"]) != set(layout["files"])
        or not all(
            isinstance(record, dict)
            and isinstance(record.get("accepted_hashes"), list)
            and all(isinstance(item, str) for item in record["accepted_hashes"])
            for record in value["files"].values()
        )
    ):
        raise SupportConflictError(f"Support manifest ownership or schema does not match: {path}")
    return value


def _inspect(layout: dict, manifest: dict | None) -> tuple[list[str], list[dict]]:
    conflicts, actions = [], []
    for name, wanted in layout["files"].items():
        path = Path(layout["unit_dir"]) / name
        if path.is_symlink():
            conflicts.append(f"Unit path is a symlink: {path}")
            continue
        if path.exists():
            try:
                existing = _digest(path.read_text())
            except (OSError, UnicodeError) as exc:
                conflicts.append(f"Cannot inspect unit file {path}: {exc}")
                continue
            permitted = manifest["files"][name].get("accepted_hashes", []) if manifest else []
            if existing not in permitted:
                conflicts.append(f"Unit file is unowned or was edited: {path}")
                continue
            action = "unchanged" if existing == _digest(wanted) else "replace_owned"
        else:
            action = "create"
        actions.append({"path": str(path), "action": action, "content": wanted, "sha256": _digest(wanted)})
    return conflicts, actions


def _atomic(path: Path, content: str) -> None:
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        if os.name == "posix":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


async def _manager(*arguments: str, check: bool = True) -> dict:
    process = await asyncio.create_subprocess_exec(
        "systemctl",
        "--user",
        *arguments,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 15)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    result = {
        "returncode": process.returncode,
        "stdout": stdout.decode(errors="replace").strip(),
        "stderr": stderr.decode(errors="replace").strip(),
    }
    if check and process.returncode:
        raise RuntimeError(f"User manager operation failed ({' '.join(arguments)}): {result['stderr']}")
    return result


async def plan(
    root: Path,
    *,
    unit_dir: Path | None = None,
    python_executable: str | Path | None = None,
    manage_manager: bool | None = None,
) -> dict:
    """Describe integration changes without creating files or changing services.

    Parameters
    ----------
    root
        Store whose recovery units will be managed.
    unit_dir
        User unit directory override. Overrides default to file-only operation.
    python_executable
        Stable Python interpreter with Hostfork installed.
    manage_manager
        Override whether install/uninstall also operate the user manager.

    Returns
    -------
    dict
        Exact unit content, ownership conflicts, intended changes and removal policy.
    """
    layout = _layout(root, unit_dir, python_executable)
    manifest = _manifest(layout)
    conflicts, actions = _inspect(layout, manifest)
    return {
        **layout,
        "files": actions,
        "conflicts": conflicts,
        "manage_manager": unit_dir is None if manage_manager is None else manage_manager,
        "installed": bool(
            manifest
            and manifest.get("state") == "installed"
            and not conflicts
            and all(action["action"] == "unchanged" for action in actions)
        ),
        "installation_state": manifest.get("state") if manifest else "absent",
        "installed_python_executable": manifest.get("python_executable") if manifest else None,
        "installed_interpreter_exists": (
            Path(manifest["python_executable"]).is_file() if manifest and manifest.get("python_executable") else None
        ),
        "removal_policy": "Remove only matching owned integration files; retain store data and report active runs",
    }


async def install(
    root: Path,
    *,
    unit_dir: Path | None = None,
    python_executable: str | Path | None = None,
    manage_manager: bool | None = None,
) -> dict:
    """Install owned units and optionally enable their user timer.

    Parameters
    ----------
    root, unit_dir, python_executable, manage_manager
        Same meanings as plan. Installation never changes sysctls, lingering,
        device formats or the system manager.

    Returns
    -------
    dict
        Resulting plan and files changed by this invocation.
    """
    prepared = await plan(root, unit_dir=unit_dir, python_executable=python_executable, manage_manager=manage_manager)
    if prepared["conflicts"]:
        raise SupportConflictError("; ".join(prepared["conflicts"]))
    Path(prepared["unit_dir"]).mkdir(parents=True, exist_ok=True)
    layout = _layout(root, unit_dir, python_executable)
    previous = _manifest(layout)
    manifest = {key: value for key, value in layout.items() if key != "files"}
    manifest.update(state="installing", files={})
    for action in prepared["files"]:
        name = Path(action["path"]).name
        accepted = [action["sha256"]]
        if previous:
            accepted.extend(previous["files"][name].get("accepted_hashes", []))
        manifest["files"][name] = {"accepted_hashes": sorted(set(accepted))}
    manifest_path = Path(layout["manifest"])
    # Intent precedes mutations, so a stopped installation remains resumable.
    _atomic(manifest_path, json.dumps(manifest, indent=2) + "\n")
    changed = []
    try:
        for action in prepared["files"]:
            if action["action"] != "unchanged":
                _atomic(Path(action["path"]), action["content"])
                changed.append(action["path"])
        if prepared["manage_manager"]:
            await _manager("daemon-reload")
            for name in (prepared["reaper"], prepared["finalizer"].replace("@.", "@verification.")):
                loaded = await _manager("show", "--property=LoadState", "--value", name)
                if loaded["stdout"] != "loaded":
                    raise RuntimeError(f"Installed unit did not load: {name}: {loaded['stdout']}")
            await _manager("enable", "--now", prepared["timer"])
            await _manager("is-active", "--quiet", prepared["timer"])
        manifest["state"] = "installed"
        manifest["files"] = {
            Path(action["path"]).name: {"accepted_hashes": [action["sha256"]]} for action in prepared["files"]
        }
        _atomic(manifest_path, json.dumps(manifest, indent=2) + "\n")
    except BaseException as exc:
        manifest.update(state="incomplete", error=f"{type(exc).__name__}: {exc}")
        _atomic(manifest_path, json.dumps(manifest, indent=2) + "\n")
        raise
    result = await plan(root, unit_dir=unit_dir, python_executable=python_executable, manage_manager=manage_manager)
    result["changed_files"] = changed
    return result


async def status(
    root: Path,
    *,
    unit_dir: Path | None = None,
    python_executable: str | Path | None = None,
    manage_manager: bool | None = None,
) -> dict:
    """Inspect owned integration files and optionally query the user timer.

    Parameters
    ----------
    root, unit_dir, python_executable, manage_manager
        Same meanings as plan.

    Returns
    -------
    dict
        File ownership state and manager observation, without modifications.
    """
    result = await plan(root, unit_dir=unit_dir, python_executable=python_executable, manage_manager=manage_manager)
    if result["manage_manager"]:
        try:
            result["timer_status"] = await _manager("is-active", result["timer"], check=False)
        except (OSError, TimeoutError) as exc:
            result["timer_status"] = {"error": str(exc)}
    return result


async def uninstall(
    root: Path,
    *,
    unit_dir: Path | None = None,
    python_executable: str | Path | None = None,
    manage_manager: bool | None = None,
    active_runs: Sequence[str] = (),
    force: bool = False,
) -> dict:
    """Remove matching integration while preserving data and edited files.

    Parameters
    ----------
    root, unit_dir, python_executable, manage_manager
        Same meanings as plan.
    active_runs
        Active run IDs supplied by the caller's store inventory.
    force
        Allow removing integration despite active runs. Does not authorize
        deletion of edited or unowned files.

    Returns
    -------
    dict
        Removed integration files and retained data location.
    """
    prepared = await plan(root, unit_dir=unit_dir, python_executable=python_executable, manage_manager=manage_manager)
    if active_runs and not force:
        raise SupportConflictError(f"Active runs still rely on recovery integration: {', '.join(active_runs)}")
    if prepared["conflicts"]:
        raise SupportConflictError("; ".join(prepared["conflicts"]))
    if not Path(prepared["manifest"]).exists():
        return {"removed_files": [], "root_retained": prepared["root"], "active_runs": list(active_runs)}
    if prepared["manage_manager"]:
        await _manager("disable", "--now", prepared["timer"])
        await _manager("stop", prepared["reaper"], prepared["prefix"] + "-finalize@*.service")
    removed = []
    for action in prepared["files"]:
        path = Path(action["path"])
        if path.exists():
            path.unlink()
            removed.append(str(path))
    Path(prepared["manifest"]).unlink()
    if prepared["manage_manager"]:
        await _manager("daemon-reload")
    return {"removed_files": removed, "root_retained": prepared["root"], "active_runs": list(active_runs)}

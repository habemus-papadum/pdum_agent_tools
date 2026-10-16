"""Read-only inspection of a Codex home: processes, launcher runs, locks and databases.

Codex coordinates concurrent processes in one home itself. This module shows
that coordination instead of enforcing one of our own: which app-servers touch
the home, which of them the launcher started, what the shared daemon reports,
which threads have live writers and how the SQLite state looks. Nothing here
starts, stops or modifies anything; the only network activity is an optional
``initialize`` probe of the daemon's control socket, which is how Codex's own
CLI checks that daemon.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import time
import tomllib
from pathlib import Path
from typing import Any

import psutil
from websockets.asyncio.client import unix_connect

from .errors import ProfileError
from .layout import is_managed_profile, legacy_layout
from .runtime import _annotate, _read_runs

DAEMON_DIR = "app-server-daemon"
CONTROL_SOCKET = Path("app-server-control/app-server-control.sock")
WRITER_LOCKS = "thread-writer-locks"
_RELEASE_VERSION = re.compile(r"/releases/(?P<version>[^/]+?)-(?:aarch64|x86_64|arm64)")
_EXTENSION_VERSION = re.compile(r"/\.vscode/extensions/openai\.chatgpt-(?P<version>[0-9.]+)-")
_FEATURE_FLAGS = ("daemon_auto_start", "local_thread_store_compression", "background_paginated_rollout_migration")


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _listen(cmdline: list[str]) -> str | None:
    for index, argument in enumerate(cmdline):
        if argument == "--listen" and index + 1 < len(cmdline):
            return cmdline[index + 1]
        if argument.startswith("--listen="):
            return argument.partition("=")[2]
    return None


def _kind(cmdline: list[str], name: str) -> str:
    if "code-mode-host" in name:
        return "code-mode-host"
    tail = cmdline[1:]
    if "pid-update-loop" in tail:
        return "daemon-updater"
    if "app-server" in tail:
        return "app-server"
    for argument in tail:
        if not argument.startswith("-"):
            return argument
    return "tui" if cmdline else "other"


def _origin(pid: int, exe: str | None, run_by_pid: dict[int, str], daemon_pids: set[int]) -> tuple[str, str | None]:
    if pid in run_by_pid:
        return "launcher", run_by_pid[pid]
    if pid in daemon_pids:
        return "daemon", None
    if exe and "/.vscode/extensions/" in exe:
        return "vscode", None
    if exe and f"/packages/{DAEMON_DIR}/" in exe:
        return "managed-install", None
    if exe and "/packages/standalone/" in exe:
        return "cli", None
    return "foreign", None


def _processes(home: Path, run_by_pid: dict[int, str], daemon_pids: set[int], warnings: list[str]) -> list[dict]:
    prefix = str(home) + os.sep
    own_uid = os.getuid()
    default_home = Path(os.environ.get("HOME", str(Path.home()))) / ".codex"
    found: list[dict[str, Any]] = []
    for process in psutil.process_iter(["pid", "ppid", "name", "exe", "cmdline", "create_time"], ad_value=None):
        info = process.info
        try:
            if process.status() == psutil.STATUS_ZOMBIE:
                continue
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        name = info["name"] or ""
        cmdline = info["cmdline"] or []
        exe = info["exe"]
        try:
            held = sorted({item.path[len(prefix) :] for item in process.open_files() if item.path.startswith(prefix)})
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            held = []
        codex_like = "codex" in name or (bool(cmdline) and Path(cmdline[0]).name.startswith("codex"))
        if not codex_like and not held:
            continue
        home_of = None
        if codex_like:
            try:
                environment = process.environ()
                configured = environment.get("CODEX_HOME")
                home_of = (
                    Path(configured) if configured else Path(environment.get("HOME", default_home.parent)) / ".codex"
                )
                home_of = home_of.expanduser().resolve()
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
                if not held:
                    warnings.append(f"Cannot read the environment of codex process {info['pid']}; its home is unknown")
            if home_of is not None and home_of != home and not held:
                continue
        origin, run_id = _origin(info["pid"], exe, run_by_pid, daemon_pids)
        version = None
        if exe:
            if match := _RELEASE_VERSION.search(exe):
                version = match.group("version")
            elif match := _EXTENSION_VERSION.search(exe):
                version = f"extension {match.group('version')}"
        try:
            uid = process.uids().real
            cwd = process.cwd()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            uid, cwd = None, None
        found.append(
            {
                "pid": info["pid"],
                "parent_pid": info["ppid"],
                "name": name,
                "kind": _kind(cmdline, name),
                "origin": origin,
                "run_id": run_id,
                "exe": exe,
                "version": version,
                "listen": _listen(cmdline),
                "cwd": cwd,
                "same_user": uid == own_uid if uid is not None else None,
                "started_at": info["create_time"],
                "codex_home": str(home_of) if home_of else None,
                "open_files": held,
            }
        )
    found.sort(key=lambda item: item["pid"])
    return found


def _writer_locks(home: Path, holders: dict[str, list[int]]) -> list[dict[str, Any]]:
    directory = home / WRITER_LOCKS
    if not directory.is_dir():
        return []
    locks = []
    for entry in sorted(directory.glob("*.lock")):
        if entry.name.startswith("."):
            continue
        try:
            modified = entry.stat().st_mtime
        except OSError:
            continue
        relative = f"{WRITER_LOCKS}/{entry.name}"
        locks.append({"thread_id": entry.stem, "modified_at": modified, "holders": holders.get(relative, [])})
    return locks


def _databases(home: Path, holders: dict[str, list[int]]) -> list[dict[str, Any]]:
    databases = []
    for path in sorted(home.glob("*.sqlite")):
        report: dict[str, Any] = {"name": path.name}
        try:
            report["bytes"] = path.stat().st_size
            report["modified_at"] = path.stat().st_mtime
        except OSError as error:
            report["error"] = str(error)
            databases.append(report)
            continue
        wal = path.with_name(path.name + "-wal")
        shm = path.with_name(path.name + "-shm")
        report["wal_bytes"] = wal.stat().st_size if wal.exists() else 0
        report["shm_present"] = shm.exists()
        report["holders"] = sorted(
            {pid for suffix in ("", "-wal", "-shm") for pid in holders.get(path.name + suffix, [])}
        )
        started = time.perf_counter()
        try:
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.5)
            try:
                connection.execute("select 1").fetchone()
                report["probe_ms"] = round((time.perf_counter() - started) * 1000, 2)
                row = connection.execute(
                    "select count(*), max(version) from _sqlx_migrations where success = 1"
                ).fetchone()
                latest = connection.execute(
                    "select description from _sqlx_migrations order by version desc limit 1"
                ).fetchone()
                report["migrations"] = {
                    "applied": row[0],
                    "latest": row[1],
                    "description": latest[0] if latest else None,
                }
            finally:
                connection.close()
        except sqlite3.Error as error:
            report["probe_ms"] = round((time.perf_counter() - started) * 1000, 2)
            report["error"] = str(error)
        databases.append(report)
    return databases


def _activity(home: Path, window_seconds: float) -> dict[str, Any]:
    candidates = sorted(home.glob("logs_*.sqlite"))
    if not candidates:
        return {"available": False}
    path = candidates[-1]
    since = int(time.time() - window_seconds)
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.5)
        try:
            rows = connection.execute(
                "select process_uuid, count(*), count(distinct thread_id), min(ts), max(ts) from logs "
                "where ts > ? group by process_uuid order by max(ts) desc limit 50",
                (since,),
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.Error as error:
        return {"available": False, "source": path.name, "error": str(error)}
    return {
        "available": True,
        "source": path.name,
        "window_seconds": window_seconds,
        "processes": [
            {"process": row[0], "log_rows": row[1], "threads": row[2], "first_at": row[3], "last_at": row[4]}
            for row in rows
        ],
    }


def _features(home: Path) -> dict[str, Any]:
    path = home / "config.toml"
    try:
        document = tomllib.loads(path.read_text()) if path.is_file() else {}
    except (OSError, ValueError) as error:
        return {"error": str(error)}
    features = document.get("features", {})
    if not isinstance(features, dict):
        return {"error": "features is not a table"}
    return {"configured": {name: features.get(name) for name in _FEATURE_FLAGS}, "note": "absent means binary default"}


def _daemon(home: Path) -> dict[str, Any]:
    directory = home / DAEMON_DIR
    socket_link = home / CONTROL_SOCKET
    report: dict[str, Any] = {
        "pid_record": _read_json(directory / "daemon.pid"),
        "updater_record": _read_json(directory / "daemon-updater.pid"),
        "settings": _read_json(directory / "settings.json"),
        "control_socket": str(socket_link) if socket_link.exists() or socket_link.is_symlink() else None,
        "socket_target": None,
        "recovery_file_present": (directory / "loaded-threads.json").is_file(),
    }
    if report["control_socket"]:
        try:
            report["socket_target"] = str(socket_link.resolve())
        except OSError:
            pass
    return report


def _scan(directory: Path, activity_window: float) -> dict[str, Any]:
    home = directory.expanduser().resolve()
    if legacy_layout(home):
        raise ProfileError(f"Legacy wrapper layout: {home}; profiles are Codex homes now")
    if not home.is_dir():
        raise ProfileError(f"Codex home does not exist: {home}")
    warnings: list[str] = []
    runs = [_annotate(record) for record in _read_runs(home)]
    run_by_pid = {run["server"]["pid"]: run["run_id"] for run in runs if run["server_alive"] and run.get("server")}
    daemon = _daemon(home)
    daemon_pids = {
        record["pid"]
        for record in (daemon["pid_record"], daemon["updater_record"])
        if record and isinstance(record.get("pid"), int)
    }
    processes = _processes(home, run_by_pid, daemon_pids, warnings)
    holders: dict[str, list[int]] = {}
    for process in processes:
        for relative in process["open_files"]:
            holders.setdefault(relative, []).append(process["pid"])
    pid_record = daemon["pid_record"] or {}
    daemon["alive"] = any(
        process["pid"] == pid_record.get("pid") and process["kind"] == "app-server" for process in processes
    )
    return {
        "home": str(home),
        "managed": is_managed_profile(home),
        "inspected_at": time.time(),
        "processes": processes,
        "process_summary": {
            "total": len(processes),
            "app_servers": sum(process["kind"] == "app-server" for process in processes),
            "launcher": sum(process["origin"] == "launcher" for process in processes),
            "foreign": sum(process["origin"] != "launcher" for process in processes),
        },
        "runs": runs,
        "live_runs": [run["run_id"] for run in runs if run["live"]],
        "daemon": daemon,
        "thread_writer_locks": _writer_locks(home, holders),
        "databases": _databases(home, holders),
        "activity": _activity(home, activity_window),
        "features": _features(home),
        "warnings": warnings,
    }


async def probe_app_server(socket_path: str, timeout: float = 3) -> dict[str, Any]:
    """Send ``initialize`` to a Unix-socket app-server and return its reply.

    Parameters
    ----------
    socket_path : str
        Filesystem path of the WebSocket-over-Unix control socket.
    timeout : float
        Overall probe deadline in seconds.

    Returns
    -------
    dict
        The native ``initialize`` result, which identifies the server version.
    """
    async with asyncio.timeout(timeout):
        async with unix_connect(socket_path, open_timeout=timeout, max_size=None) as websocket:
            await websocket.send(
                json.dumps(
                    {
                        "id": "pdum-inspect",
                        "method": "initialize",
                        "params": {"clientInfo": {"name": "pdum-codex-inspect", "version": "0.0.0"}},
                    }
                )
            )
            while True:
                response = json.loads(await websocket.recv())
                if response.get("id") == "pdum-inspect":
                    if "error" in response:
                        raise OSError(f"initialize rejected: {response['error']}")
                    await websocket.send(json.dumps({"method": "initialized"}))
                    return response.get("result", {})


async def inspect_home(directory: Path, *, probe_daemon: bool = True, activity_window: float = 86400) -> dict[str, Any]:
    """Report everything using a Codex home without starting, stopping or modifying anything.

    Parameters
    ----------
    directory : Path
        A profile directory or any Codex home, such as the user's own.
    probe_daemon : bool
        Connect to the shared daemon's control socket, when present, to read its version.
    activity_window : float
        Seconds of native log history summarized per process.

    Returns
    -------
    dict
        Processes touching the home with kind, origin and version; launcher run records
        with liveness; daemon identity and settings; per-thread writer locks and their
        holders; SQLite sizes, WAL sizes, holders, read-open latency and applied
        migrations; recent per-process log activity; configured feature flags; warnings.
        SQLite exposes no contention counter, so the database fields are proxies.
    """
    report = await asyncio.to_thread(_scan, directory, activity_window)
    daemon = report["daemon"]
    if probe_daemon and daemon.get("socket_target"):
        try:
            daemon["server_info"] = await probe_app_server(daemon["socket_target"])
            daemon["reachable"] = True
        except (OSError, ValueError, TimeoutError) as error:
            daemon["reachable"] = False
            daemon["probe_error"] = str(error) or type(error).__name__
    return report

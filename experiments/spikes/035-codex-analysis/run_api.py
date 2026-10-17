"""Run the API ingester against a snapshot profile the launcher starts, or read-only against the daemon.

Snapshot mode creates a launcher profile under the artifact directory, clones the ordinary
home's ``sessions/`` and ``archived_sessions/`` into it (APFS clone, no databases copied),
launches ``codex app-server`` through ``pdum.codex_launcher`` with analytics and feedback
off, waits for the catalogue backfill, ingests, then stops the server and removes the clone.
The ordinary home is never written. Daemon mode connects to the managed daemon's control
socket and issues only read RPCs for a bounded number of threads.

    uv run --project .. --with duckdb==1.5.6 --with pyarrow==26.0.0 python spikes/035-codex-analysis/run_api.py \
        --out artifacts/035-codex-analysis/<run> --snapshot --daemon --daemon-threads 40
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from pdum.codex_launcher import LaunchOptions, ProfileSpec, create_profile, default_codex_home, inspect_home, launch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest_api  # noqa: E402
import ingest_fs  # noqa: E402


def thread_count(state_db: Path) -> int | None:
    if not state_db.exists():
        return None
    try:
        connection = sqlite3.connect(str(state_db), timeout=2)
        connection.execute("PRAGMA query_only = 1")
        count = connection.execute("select count(*) from threads").fetchone()[0]
        connection.close()
        return int(count)
    except sqlite3.Error:
        return None


async def wait_for_backfill(profile: Path, *, expected: int, timeout: float) -> dict[str, Any]:
    state_db = profile / "state_5.sqlite"
    started = time.perf_counter()
    last: int | None = None
    stable_since = started
    history: list[tuple[float, int | None]] = []
    while time.perf_counter() - started < timeout:
        count = thread_count(state_db)
        history.append((round(time.perf_counter() - started, 1), count))
        if count != last:
            last = count
            stable_since = time.perf_counter()
        elif count is not None and (count >= expected or time.perf_counter() - stable_since > 8):
            break
        await asyncio.sleep(1)
    return {
        "seconds": round(time.perf_counter() - started, 1),
        "threads": last,
        "expected": expected,
        "samples": history[-12:],
    }


async def snapshot(args: argparse.Namespace, out: Path) -> dict[str, Any]:
    home = default_codex_home()
    codex = Path(args.codex).expanduser().resolve() if args.codex else Path(shutil.which("codex") or "")
    if not codex.is_file():
        raise SystemExit("codex executable not found; pass --codex")
    profile = out / "snapshot-profile"
    if profile.exists():
        shutil.rmtree(profile)
    info = await create_profile(profile, ProfileSpec(executable=codex, copy_skills=False))
    clone_started = time.perf_counter()
    files = 0
    for name in ("sessions", "archived_sessions"):
        source = home / name
        if source.is_dir():
            subprocess.run(["cp", "-Rc", str(source), str(profile / name)], check=True)
            files += sum(1 for _ in (profile / name).rglob("rollout-*.jsonl"))
    clone_seconds = round(time.perf_counter() - clone_started, 2)
    version = subprocess.run([str(codex), "--version"], capture_output=True, text=True, check=False).stdout.strip()
    result: dict[str, Any] = {
        "profile": str(profile),
        "codex": str(codex),
        "version": version,
        "clone_seconds": clone_seconds,
        "rollout_files": files,
        "warnings": list(info.warnings),
        "history": args.history,
    }
    if args.history == "backup":
        # A fresh home catalogues paginated rollouts but never materializes their SQLite
        # history, so the read RPCs list nothing. Copy the projection consistently with the
        # SQLite backup API, which only reads the source.
        backup_started = time.perf_counter()
        source_db, how = ingest_fs.open_sqlite(home / "thread_history_1.sqlite")
        target_db = sqlite3.connect(str(profile / "thread_history_1.sqlite"))
        source_db.backup(target_db)
        target_db.close()
        source_db.close()
        result["history_backup"] = {
            "seconds": round(time.perf_counter() - backup_started, 2),
            "open": how,
            "bytes": (profile / "thread_history_1.sqlite").stat().st_size,
        }
    options = LaunchOptions(
        executable=codex,
        relay=False,
        environment_mode="clean",
        config_overrides={"analytics.enabled": "false", "feedback.enabled": "false"},
        startup_timeout=120,
    )
    launch_started = time.perf_counter()
    async with launch(profile, options) as server:
        result["launch_seconds"] = round(time.perf_counter() - launch_started, 2)
        result["endpoint"] = server.backend_endpoint
        result["backfill"] = await wait_for_backfill(profile, expected=files, timeout=args.backfill_timeout)
        label = "snapshot" if args.history == "backup" else f"snapshot-{args.history}"
        result["ingest"] = await ingest_api.ingest(
            server.backend_endpoint,
            out,
            label=label,
            max_threads=args.snapshot_threads,
            sample=args.sample,
            concurrency=args.concurrency,
            materialize=args.history == "resume",
        )
        if args.concurrency_sweep:
            sweep = []
            for level in (1, 4, 8):
                summary = await ingest_api.ingest(
                    server.backend_endpoint,
                    out,
                    label=f"{label}-c{level}",
                    max_threads=40,
                    sample=0,
                    search=None,
                    concurrency=level,
                    keep_calls=False,
                )
                sweep.append(
                    {
                        "concurrency": level,
                        "wall_seconds": summary["wall_seconds"],
                        "rpc_calls": summary["rpc_calls"],
                        "methods": summary["methods"],
                    }
                )
            result["concurrency_sweep"] = sweep
    if not args.keep:
        shutil.rmtree(profile, ignore_errors=True)
        result["profile_removed"] = True
    return result


async def daemon(args: argparse.Namespace, out: Path) -> dict[str, Any]:
    report = await inspect_home(default_codex_home(), probe_daemon=False)
    socket = (report.get("daemon") or {}).get("socket_target")
    if not socket:
        return {"error": "daemon control socket not found"}
    result: dict[str, Any] = {"socket": socket, "daemon": {k: report["daemon"].get(k) for k in ("pid_record", "alive")}}
    result["ingest"] = await ingest_api.ingest(
        f"unix://{socket}",
        out,
        label="daemon",
        max_threads=args.daemon_threads,
        sample=min(args.sample, 2),
        concurrency=args.concurrency,
    )
    return result


async def main_async(args: argparse.Namespace) -> None:
    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    results: dict[str, Any] = {}
    if args.snapshot:
        results["snapshot"] = await snapshot(args, out)
    if args.daemon:
        results["daemon"] = await daemon(args, out)
    suffix = f"-{args.history}" if args.snapshot and args.history != "backup" else ""
    (out / f"run_api{suffix}.json").write_text(json.dumps(results, indent=2, default=str) + "\n")
    brief = {}
    for label, result in results.items():
        ingest = result.get("ingest") or {}
        brief[label] = {
            "wall_seconds": ingest.get("wall_seconds"),
            "rpc_calls": ingest.get("rpc_calls"),
            "tables": ingest.get("tables"),
            "methods": ingest.get("methods"),
            "errors": len(ingest.get("errors") or []),
            "search": ingest.get("search"),
            "backfill": result.get("backfill"),
            "history_backup": result.get("history_backup"),
            "launch_seconds": result.get("launch_seconds"),
            "clone_seconds": result.get("clone_seconds"),
            "version": result.get("version"),
            "samples": ingest.get("samples"),
            "concurrency_sweep": result.get("concurrency_sweep"),
        }
    print(json.dumps(brief, indent=2, default=str))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--snapshot", action="store_true")
    parser.add_argument("--daemon", action="store_true")
    parser.add_argument("--codex", help="explicit codex executable for the snapshot server")
    parser.add_argument("--snapshot-threads", type=int)
    parser.add_argument("--daemon-threads", type=int, default=40)
    parser.add_argument("--sample", type=int, default=5)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--concurrency-sweep", action="store_true")
    parser.add_argument("--backfill-timeout", type=float, default=300)
    parser.add_argument(
        "--history",
        choices=("backup", "resume", "none"),
        default="backup",
        help="how the snapshot gets its SQLite history projection",
    )
    parser.add_argument("--keep", action="store_true", help="keep the snapshot profile")
    args = parser.parse_args()
    os.umask(0o077)
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()

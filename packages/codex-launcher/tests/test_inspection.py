"""Home inspection against a synthetic Codex home and, when installed, real app-servers."""

import json
import os
import shutil
import sqlite3
import sys
import time
import uuid
from pathlib import Path

import psutil
import pytest
from pdum.codex_launcher import LaunchOptions, ProfileSpec, create_profile, inspect_home, launch
from pdum.codex_launcher.errors import ProfileError

CODEX = shutil.which("codex")


def _migrations_db(path: Path, applied: int) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "create table _sqlx_migrations (version bigint primary key, description text not null, "
            "installed_on timestamp not null default current_timestamp, success boolean not null, "
            "checksum blob not null, execution_time bigint not null)"
        )
        for version in range(1, applied + 1):
            connection.execute(
                "insert into _sqlx_migrations values (?, ?, current_timestamp, 1, x'00', 0)",
                (version, f"migration {version}"),
            )
        connection.commit()
    finally:
        connection.close()


def _logs_db(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "create table logs (id integer primary key autoincrement, ts integer not null, ts_nanos integer not null, "
            "level text not null, target text not null, feedback_log_body text, module_path text, file text, "
            "line integer, thread_id text, process_uuid text, estimated_bytes integer not null default 0)"
        )
        now = int(time.time())
        rows = [(now - 10, 0, "INFO", "t", None, None, None, None, "thread-a", f"pid:{os.getpid()}", 0)]
        rows.append((now - 5, 0, "INFO", "t", None, None, None, None, "thread-b", f"pid:{os.getpid()}", 0))
        rows.append((now - 90000, 0, "INFO", "t", None, None, None, None, None, "pid:1", 0))
        connection.executemany(
            "insert into logs (ts, ts_nanos, level, target, feedback_log_body, module_path, file, line, "
            "thread_id, process_uuid, estimated_bytes) values (?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        connection.commit()
    finally:
        connection.close()


async def test_inspection_reports_foreign_holders_locks_databases_and_activity(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.toml").write_text("[features]\nlocal_thread_store_compression = false\n")
    _migrations_db(home / "state_5.sqlite", 3)
    _logs_db(home / "logs_2.sqlite")
    locks = home / "thread-writer-locks"
    locks.mkdir()
    (locks / ".coordination.lock").write_text("")
    thread_id = str(uuid.uuid4())
    daemon_dir = home / "app-server-daemon"
    daemon_dir.mkdir()
    (daemon_dir / "daemon.pid").write_text(json.dumps({"pid": os.getpid(), "processStartTime": "now"}))
    (daemon_dir / "settings.json").write_text(json.dumps({"remoteControlEnabled": False}))
    with (locks / f"{thread_id}.lock").open("w") as held:
        held.write("")
        held.flush()
        report = await inspect_home(home, probe_daemon=False, activity_window=3600)
    assert report["home"] == str(home.resolve())
    assert report["managed"] is False
    me = next(process for process in report["processes"] if process["pid"] == os.getpid())
    assert me["origin"] == "daemon"
    assert me["same_user"] is True
    assert f"thread-writer-locks/{thread_id}.lock" in me["open_files"]
    assert report["process_summary"]["foreign"] >= 1
    (lock,) = report["thread_writer_locks"]
    assert lock["thread_id"] == thread_id
    assert lock["holders"] == [os.getpid()]
    databases = {database["name"]: database for database in report["databases"]}
    assert databases["state_5.sqlite"]["migrations"] == {"applied": 3, "latest": 3, "description": "migration 3"}
    assert databases["state_5.sqlite"]["probe_ms"] >= 0
    assert databases["state_5.sqlite"]["wal_bytes"] == 0
    activity = report["activity"]
    assert activity["available"] and activity["source"] == "logs_2.sqlite"
    assert activity["processes"] == [
        {
            "process": f"pid:{os.getpid()}",
            "log_rows": 2,
            "threads": 2,
            "first_at": activity["processes"][0]["first_at"],
            "last_at": activity["processes"][0]["last_at"],
        }
    ]
    assert report["features"]["configured"]["local_thread_store_compression"] is False
    assert report["features"]["configured"]["daemon_auto_start"] is None
    assert report["daemon"]["pid_record"]["pid"] == os.getpid()
    assert report["daemon"]["settings"] == {"remoteControlEnabled": False}
    assert report["daemon"]["control_socket"] is None
    assert report["daemon"]["alive"] is False
    assert report["runs"] == [] and report["live_runs"] == []


async def test_inspection_rejects_missing_or_legacy_homes(tmp_path):
    with pytest.raises(ProfileError, match="does not exist"):
        await inspect_home(tmp_path / "missing")
    legacy = tmp_path / "legacy"
    (legacy / "codex").mkdir(parents=True)
    (legacy / "launcher.toml").write_text("schema_version = 1\n")
    with pytest.raises(ProfileError, match="Legacy wrapper layout"):
        await inspect_home(legacy)


async def test_inspection_classifies_launcher_runs_without_native_binary(tmp_path):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=sys.executable))
    run_directory = profile / ".pdum/runtime/runs/fixture"
    run_directory.mkdir(parents=True)
    me = {"pid": os.getpid(), "uid": os.getuid(), "create_time": psutil.Process().create_time()}
    (run_directory / "owner.json").write_text(
        json.dumps({"run_id": "fixture", "state": "ready", "server": me, "started_at": time.time()})
    )
    with (profile / "sessions.jsonl").open("w") as held:
        held.write("")
        held.flush()
        report = await inspect_home(profile, probe_daemon=False)
    assert report["managed"] is True
    assert report["live_runs"] == ["fixture"]
    process = next(item for item in report["processes"] if item["pid"] == os.getpid())
    assert process["origin"] == "launcher" and process["run_id"] == "fixture"
    assert report["process_summary"]["launcher"] == 1


@pytest.mark.codex
@pytest.mark.skipif(CODEX is None, reason="Native Codex executable is not installed")
async def test_inspection_sees_two_launched_servers_in_one_profile(tmp_path):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=CODEX))
    async with (
        launch(profile, LaunchOptions(relay=False)) as first,
        launch(profile, LaunchOptions(relay=False)) as second,
    ):
        report = await inspect_home(profile, probe_daemon=False)
        servers = {process["pid"]: process for process in report["processes"] if process["kind"] == "app-server"}
        assert {first.pid, second.pid} <= set(servers)
        assert servers[first.pid]["origin"] == "launcher" and servers[first.pid]["run_id"] == first.run_id
        assert servers[second.pid]["run_id"] == second.run_id
        assert servers[first.pid]["listen"] == first.backend_endpoint
        assert servers[first.pid]["codex_home"] == str(profile.resolve())
        assert sorted(report["live_runs"]) == sorted([first.run_id, second.run_id])
        assert report["process_summary"]["launcher"] >= 2

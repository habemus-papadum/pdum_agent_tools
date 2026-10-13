"""Durable ownership transactions and inspectable per-environment evidence."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import sqlite3
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

from .errors import EnvironmentClosed, OwnershipConflict

SCHEMA_VERSION = 1
IDENTIFIER = re.compile(r"^[a-f0-9]{32}$")


def identifier(value: str) -> str:
    """Validate an opaque environment/allocation identity before path use."""
    if not IDENTIFIER.fullmatch(value):
        raise ValueError(f"Invalid Hostfork identity: {value!r}")
    return value


def dump(value: object) -> str:
    return json.dumps(value, sort_keys=True, allow_nan=False)


def atomic_json(path: Path, value: object) -> None:
    """Persist a diagnostic file atomically, using an exclusive temporary file."""
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("x") as stream:
            stream.write(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        if os.name == "posix":
            fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def path_identity(path: Path) -> dict:
    """Read directory identity without treating a replacement symlink as owned."""
    stat = path.lstat()
    if path.is_symlink():
        raise OwnershipConflict(f"Unexpected symlink: {path}")
    return {"device": stat.st_dev, "inode": stat.st_ino}


class Store:
    """One local registry; construction and reads do not initialize it.

    Parameters
    ----------
    root
        Operator-selected persistent state/evidence directory. Allocation pools
        may reside elsewhere and are recorded per resource.
    """

    def __init__(self, root: Path | str):
        self.root = Path(root).expanduser().resolve()
        self.path = self.root / "registry.sqlite"

    def initialize(self) -> None:
        """Create or validate the schema without changing existing identities."""
        self.root.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(sqlite3.connect(self.path, timeout=10)) as connection, connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, SCHEMA_VERSION):
                raise OwnershipConflict(f"Unsupported registry schema {version}; expected {SCHEMA_VERSION}")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, record TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS resources (
                    id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, record TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS resources_environment ON resources(environment_id);
                CREATE TABLE IF NOT EXISTS commands (
                    environment_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
                    PRIMARY KEY(environment_id, id));
                CREATE TABLE IF NOT EXISTS baselines (name TEXT PRIMARY KEY, record TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS dependencies (
                    resource_id TEXT NOT NULL, baseline_name TEXT NOT NULL,
                    PRIMARY KEY(resource_id, baseline_name));
                CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT, environment_id TEXT NOT NULL,
                    time REAL NOT NULL, kind TEXT NOT NULL, record TEXT NOT NULL);
            """)
            connection.execute("INSERT OR IGNORE INTO metadata VALUES ('id', ?)", (dump(uuid.uuid4().hex),))
            connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    @contextlib.contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Open a short write transaction; never hold across an await or OS mutation."""
        if not self.path.exists():
            raise FileNotFoundError(f"Registry does not exist: {self.path}")
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _query(self, query: str, args: tuple = ()) -> list:
        if not self.path.exists():
            return []
        with contextlib.closing(sqlite3.connect(self.path, timeout=10)) as connection, connection:
            return connection.execute(query, args).fetchall()

    @property
    def id(self) -> str:
        rows = self._query("SELECT value FROM metadata WHERE key='id'")
        if not rows:
            raise FileNotFoundError(f"Registry is not initialized: {self.path}")
        return json.loads(rows[0][0])

    def run_path(self, environment_id: str) -> Path:
        return self.root / "runs" / identifier(environment_id)

    def create_environment(self, plan: dict, *, environment_id: str | None = None) -> dict:
        """Record ownership before creating a run directory or operating-system resources."""
        self.initialize()
        environment_id = identifier(environment_id or uuid.uuid4().hex)
        record = {
            "id": environment_id,
            "schema": SCHEMA_VERSION,
            "state": "creating",
            "created_at": time.time(),
            "plan": plan,
            "stop_requested_at": None,
            "stopped_at": None,
            "cleanup": {},
            "errors": [],
        }
        with self.transaction() as connection:
            connection.execute("INSERT INTO environments VALUES (?,?)", (environment_id, dump(record)))
        path = self.run_path(environment_id)
        path.mkdir(parents=True, exist_ok=False)
        atomic_json(path / ".hostfork-owner.json", {"registry": self.id, "environment": environment_id})
        atomic_json(path / "manifest.json", record)
        return record

    def environment(self, environment_id: str) -> dict:
        rows = self._query("SELECT record FROM environments WHERE id=?", (identifier(environment_id),))
        if not rows:
            raise KeyError(f"Unknown environment: {environment_id}")
        return json.loads(rows[0][0])

    def environments(self) -> list[dict]:
        return [json.loads(row[0]) for row in self._query("SELECT record FROM environments ORDER BY rowid")]

    def update_environment(self, environment_id: str, **changes: object) -> dict:
        """Merge a lifecycle update and refresh the diagnostic manifest."""
        identifier(environment_id)
        with self.transaction() as connection:
            row = connection.execute("SELECT record FROM environments WHERE id=?", (environment_id,)).fetchone()
            if not row:
                raise KeyError(environment_id)
            record = json.loads(row[0])
            if changes.get("state") == "running" and record.get("stop_requested_at"):
                raise EnvironmentClosed("Environment was stopped during activation")
            record.update(changes, updated_at=time.time())
            connection.execute("UPDATE environments SET record=? WHERE id=?", (dump(record), environment_id))
        path = self.run_path(environment_id)
        if path.exists():
            self.verify_run(environment_id)
            atomic_json(path / "manifest.json", record)
        return record

    def verify_run(self, environment_id: str) -> Path:
        """Check the exact run marker before operating on its evidence."""
        path = self.run_path(environment_id)
        path_identity(path)
        expected = {"registry": self.id, "environment": environment_id}
        try:
            marker = json.loads((path / ".hostfork-owner.json").read_text())
        except (OSError, ValueError) as error:
            raise OwnershipConflict(f"Missing/invalid ownership marker: {path}") from error
        if marker != expected:
            raise OwnershipConflict(f"Run ownership conflict: {path}")
        return path

    def event(self, environment_id: str, kind: str, record: dict) -> None:
        with self.transaction() as connection:
            connection.execute(
                "INSERT INTO events(environment_id,time,kind,record) VALUES (?,?,?,?)",
                (identifier(environment_id), time.time(), kind, dump(record)),
            )

    def events(self, environment_id: str) -> list[dict]:
        return [
            {"sequence": row[0], "time": row[1], "kind": row[2], "record": json.loads(row[3])}
            for row in self._query(
                "SELECT sequence,time,kind,record FROM events WHERE environment_id=? ORDER BY sequence",
                (identifier(environment_id),),
            )
        ]

    def register_baseline(self, name: str, record: dict) -> dict:
        """Register a borrowed stable input; refuse replacement while referenced."""
        if not name or "/" in name or name in (".", ".."):
            raise ValueError("Baseline names must be nonempty simple names")
        self.initialize()
        with self.transaction() as connection:
            previous = connection.execute("SELECT record FROM baselines WHERE name=?", (name,)).fetchone()
            if previous and json.loads(previous[0]) != record:
                pinned = connection.execute(
                    "SELECT 1 FROM dependencies WHERE baseline_name=? LIMIT 1", (name,)
                ).fetchone()
                if pinned:
                    raise OwnershipConflict(f"Baseline is in use: {name}")
            connection.execute("INSERT OR REPLACE INTO baselines VALUES (?,?)", (name, dump(record)))
        return record

    def baseline(self, name: str) -> dict:
        rows = self._query("SELECT record FROM baselines WHERE name=?", (name,))
        if not rows:
            raise KeyError(f"Unknown baseline: {name}")
        return json.loads(rows[0][0])

    def baselines(self) -> dict[str, dict]:
        return {row[0]: json.loads(row[1]) for row in self._query("SELECT name,record FROM baselines ORDER BY name")}

    def reserve_resource(
        self,
        environment_id: str,
        *,
        pool: Path,
        name: str,
        kind: str,
        source: str | None = None,
        baseline: str | None = None,
        stable: bool = False,
        expected_baseline: dict | None = None,
    ) -> dict:
        """Reserve an allocation and dependency before touching its destination."""
        resource_id = uuid.uuid4().hex
        pool = pool.resolve()
        record = {
            "id": resource_id,
            "environment_id": identifier(environment_id),
            "name": name,
            "kind": kind,
            "allocation_path": str(pool / resource_id),
            "pool": str(pool),
            "source": source,
            "baseline": baseline,
            "stable": stable,
            "state": "reserved",
            "created_at": time.time(),
        }
        with self.transaction() as connection:
            if not connection.execute("SELECT 1 FROM environments WHERE id=?", (environment_id,)).fetchone():
                raise KeyError(environment_id)
            if baseline:
                if not connection.execute("SELECT 1 FROM baselines WHERE name=?", (baseline,)).fetchone():
                    raise KeyError(baseline)
                current = json.loads(
                    connection.execute("SELECT record FROM baselines WHERE name=?", (baseline,)).fetchone()[0]
                )
                if expected_baseline is not None and current != expected_baseline:
                    raise OwnershipConflict(f"Baseline changed since planning: {baseline}")
                connection.execute("INSERT INTO dependencies VALUES (?,?)", (resource_id, baseline))
            connection.execute("INSERT INTO resources VALUES (?,?,?)", (resource_id, environment_id, dump(record)))
        return record

    def prepare_allocation(self, record: dict) -> dict:
        """Create the exact reserved directory exclusively and publish its marker."""
        path = Path(record["allocation_path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.mkdir(exist_ok=False)
        marker = {"registry": self.id, "environment": record["environment_id"], "allocation": record["id"]}
        atomic_json(path / ".hostfork-owner.json", marker)
        return self.update_resource(record["id"], state="allocating", allocation_identity=path_identity(path))

    def verify_allocation(self, record: dict) -> Path:
        """Reject replacement directories and unrecorded destinations before cleanup."""
        path = Path(record["allocation_path"])
        expected = {"registry": self.id, "environment": record["environment_id"], "allocation": record["id"]}
        current_identity = path_identity(path)
        if record.get("allocation_identity") and current_identity != record["allocation_identity"]:
            raise OwnershipConflict(f"Allocation identity changed: {path}")
        try:
            marker = json.loads((path / ".hostfork-owner.json").read_text())
        except (OSError, ValueError) as error:
            raise OwnershipConflict(f"Allocation marker unavailable: {path}") from error
        if marker != expected:
            raise OwnershipConflict(f"Allocation ownership changed: {path}")
        return path

    def resources(self, environment_id: str | None = None) -> list[dict]:
        if environment_id is None:
            rows = self._query("SELECT record FROM resources ORDER BY rowid")
        else:
            rows = self._query(
                "SELECT record FROM resources WHERE environment_id=? ORDER BY rowid", (identifier(environment_id),)
            )
        return [json.loads(row[0]) for row in rows]

    def update_resource(self, resource_id: str, **changes: object) -> dict:
        with self.transaction() as connection:
            row = connection.execute("SELECT record FROM resources WHERE id=?", (identifier(resource_id),)).fetchone()
            if not row:
                raise KeyError(resource_id)
            record = json.loads(row[0])
            record.update(changes, updated_at=time.time())
            connection.execute("UPDATE resources SET record=? WHERE id=?", (dump(record), resource_id))
            if record["state"] == "released":
                connection.execute("DELETE FROM dependencies WHERE resource_id=?", (resource_id,))
        return record

    def command(self, environment_id: str, command_id: str, record: dict) -> None:
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO commands VALUES (?,?,?)",
                (identifier(environment_id), identifier(command_id), dump(record)),
            )

    def commands(self, environment_id: str) -> list[dict]:
        return [
            json.loads(row[0])
            for row in self._query(
                "SELECT record FROM commands WHERE environment_id=? ORDER BY rowid", (identifier(environment_id),)
            )
        ]

    @contextlib.asynccontextmanager
    async def lock(self, environment_id: str, *, timeout: float = 10):
        """Serialize mutations without blocking the event loop or independent kills."""
        if os.name != "posix":
            raise RuntimeError("Local operation locking requires POSIX flock")
        import fcntl

        path = self.root / "locks"
        path.mkdir(exist_ok=True)
        descriptor = os.open(path / identifier(environment_id), os.O_CREAT | os.O_RDWR, 0o600)
        until = time.monotonic() + timeout
        try:
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= until:
                        raise TimeoutError(f"Environment operation is busy: {environment_id}") from None
                    await asyncio.sleep(0.02)
            yield
        finally:
            os.close(descriptor)

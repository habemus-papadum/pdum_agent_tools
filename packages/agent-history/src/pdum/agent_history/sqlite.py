"""Read-only access to the SQLite databases an agent keeps beside its history."""

from __future__ import annotations

import sqlite3
from pathlib import Path


def open_readonly(path: Path) -> tuple[sqlite3.Connection, str]:
    """Open a SQLite file for reading, tolerating the WAL side-file trap.

    A WAL database whose ``-shm`` side file is absent refuses ``mode=ro`` with error 14,
    so the fallback is an ordinary connection with ``PRAGMA query_only``, which creates
    only the side file the owning program would create itself.

    Parameters
    ----------
    path : Path
        Existing SQLite database file.

    Returns
    -------
    tuple
        ``(connection, how)`` where ``how`` names the mode that worked.
    """
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        connection.execute("select count(*) from sqlite_master").fetchone()
        return connection, "mode=ro"
    except sqlite3.OperationalError as error:
        if "unable to open database" not in str(error):
            raise
    connection = sqlite3.connect(str(path), timeout=5)
    connection.execute("PRAGMA query_only = 1")
    return connection, "query_only fallback (-shm absent)"

# ruff: noqa: E501  -- SQL text reads better unwrapped; research code, not a package
"""Compare row counts and text byte sums per source between ``agent_history`` and the local files.

    uv run --frozen --all-packages --env-file .env python experiments/spikes/036-motherduck/verify.py

Row counts alone would not notice truncated strings, so for ``item_blobs.item_json``, ``items.text`` and
``logs.body`` the total ``length()`` per source is compared as well.

Writes ``experiments/artifacts/036-motherduck/verify.json``.
"""

from __future__ import annotations

import time
from typing import Any

import common

TEXT_COLUMNS = {"item_blobs": "item_json", "items": "text", "logs": "body"}


def main() -> None:
    con = common.connect_md("md:")
    report: dict[str, Any] = {"recorded_at": common.now_iso(), "sources": {}}
    wall = time.perf_counter()
    for name in common.LOCAL_FILES:
        common.attach_local(con, name)
        source_id = con.execute(f"SELECT source_id FROM {name}.main.provenance").fetchone()[0]
        entry: dict[str, Any] = {"source_id": source_id, "rows": {}, "bytes": {}}
        for table in common.tables_with(con, name, "source_id"):
            local = con.execute(f"SELECT count(*) FROM {name}.main.{table}").fetchone()[0]
            remote = con.execute(
                f"SELECT count(*) FROM {common.DATABASE}.main.{table} WHERE source_id = ?", [source_id]
            ).fetchone()[0]
            entry["rows"][table] = {"local": local, "remote": remote, "match": local == remote}
        for table, column in TEXT_COLUMNS.items():
            local = con.execute(f"SELECT coalesce(sum(length({column})), 0) FROM {name}.main.{table}").fetchone()[0]
            remote = con.execute(
                f"SELECT coalesce(sum(length({column})), 0) FROM {common.DATABASE}.main.{table} WHERE source_id = ?",
                [source_id],
            ).fetchone()[0]
            entry["bytes"][f"{table}.{column}"] = {"local": local, "remote": remote, "match": local == remote}
        report["sources"][name] = entry
        print(name, "rows match:", all(v["match"] for v in entry["rows"].values()), "bytes:", entry["bytes"])
    report["all_match"] = all(
        v["match"] for e in report["sources"].values() for part in ("rows", "bytes") for v in e[part].values()
    )
    report["seconds"] = round(time.perf_counter() - wall, 3)
    path = common.write_json("verify.json", report)
    print(f"all_match={report['all_match']} in {report['seconds']} s; wrote {path}")
    con.close()


if __name__ == "__main__":
    main()

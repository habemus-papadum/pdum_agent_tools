# ruff: noqa: E501  -- research code, not a package
"""Render the report tables from the spike's JSON artifacts.

    uv run --frozen --all-packages python experiments/spikes/036-motherduck/report_tables.py

Reads ``seed.json``, ``latency.json``, ``concurrency.json`` and ``replace.json`` from
``experiments/artifacts/036-motherduck/`` and prints Markdown tables for the summary document.
"""

from __future__ import annotations

import common


def gb(n: int | None) -> str:
    return "" if n is None else f"{n / 1e9:.2f}"


def seed_tables() -> None:
    data = common.read_json("seed.json")
    print("### Load\n")
    print("| Table | Codex rows | Codex s | Claude rows | Claude s | Rows/s |")
    print("| --- | ---: | ---: | ---: | ---: | ---: |")
    codex = data["sources"].get("codex", {}).get("tables", {})
    claude = data["sources"].get("claude", {}).get("tables", {})
    for table in list(codex) + [t for t in claude if t not in codex]:
        c, k = codex.get(table, {}), claude.get(table, {})
        rows = (c.get("rows") or 0) + (k.get("rows") or 0)
        secs = (c.get("seconds") or 0) + (k.get("seconds") or 0)
        rate = f"{rows / secs:,.0f}" if secs else ""
        print(
            f"| {table} | {c.get('rows', ''):,} | {c.get('seconds', '')} | {k.get('rows', ''):,} | {k.get('seconds', '')} | {rate} |"
        )
    print(
        f"| total | | {data['sources'].get('codex', {}).get('seconds', '')} | | {data['sources'].get('claude', {}).get('seconds', '')} | |"
    )
    print()
    print(
        f"load wall clock {data['load_seconds']} s, whole run {data['total_seconds']} s, connect {data['steps']['connect_s']} s, create database {data['steps']['create_database'].get('seconds')} s, DDL {data['steps']['ddl'].get('seconds')} s, counts match {data['counts_match']}, aborted {data['aborted']}"
    )
    print()
    st = data["storage"]
    print("### Storage\n")
    print("| Measure | Bytes | GB |")
    print("| --- | ---: | ---: |")
    for name, size in st["local_files"].items():
        print(f"| local {name}.duckdb file | {size:,} | {gb(size)} |")
    for row in st.get("storage_info", []):
        for key in ("active_bytes", "historical_bytes", "retained_for_clone_bytes", "failsafe_bytes"):
            print(f"| storage_info.{key} | {row[key]:,} | {gb(row[key])} |")
        print(f"| storage_info.computed_ts | {row['computed_ts']} | |")
    for name, size in st.get("pragma_database_size", {}).items():
        print(f"| PRAGMA database_size {name} | {size} | |")
    print()


def latency_table() -> None:
    data = common.read_json("latency.json")
    print("### Latency\n")
    print("| Query | MotherDuck cold ms | MotherDuck warm ms | Local cold ms | Local warm ms | Same answer |")
    print("| --- | ---: | ---: | ---: | ---: | --- |")
    for key, title in data["titles"].items():
        md, lo = data["motherduck"][key], data["local"][key]
        print(
            f"| {title} | {md.get('cold_ms', md.get('error', ''))} | {md.get('warm_ms', '')} | {lo.get('cold_ms', lo.get('error', ''))} | {lo.get('warm_ms', '')} | {'yes' if data['agree'][key] else 'no'} |"
        )
    print()
    print(
        f"MotherDuck connect {data['motherduck_connect_s']} s, local open {data['local_open_s']} s, runs per query {data['runs']}"
    )
    print()


def concurrency_table() -> None:
    data = common.read_json("concurrency.json")
    print("### Concurrent writers\n")
    print("| Worker | Transaction | Delete ms | Insert ms | Commit ms | Total ms | Result |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | --- |")
    for name, w in data["workers"].items():
        for it in w.get("iterations", []):
            result = "ok" if it.get("ok") else it.get("error", "failed")[:120]
            print(
                f"| {name} | {it['iteration'] + 1} | {it.get('delete_ms', '')} | {it.get('insert_ms', '')} | {it.get('commit_ms', '')} | {it['total_ms']} | {result} |"
            )
    print()
    print(
        f"all_ok {data['all_ok']}, final counts {data['final_counts']}, wall after spawn {data['wall_seconds_after_spawn']} s, connect "
        + ", ".join(f"{n} {w.get('connect_s')} s" for n, w in data["workers"].items())
    )
    print()


def replace_table() -> None:
    data = common.read_json("replace.json")
    print("### Replace one thread\n")
    print("| Table | Thread rows | Table rows | Delete ms | Insert ms |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for step in data["steps"]:
        t = step["table"]
        print(
            f"| {t} | {data['after'][t]['thread']:,} | {data['after'][t]['total']:,} | {step['delete_ms']} | {step['insert_ms']} |"
        )
    print()
    print(
        f"ok {data['ok']}, transaction {data['transaction_seconds']} s, commit {data.get('commit_ms')} ms, unchanged {data['unchanged']}"
    )
    print()


def main() -> None:
    for fn in (seed_tables, latency_table, concurrency_table, replace_table):
        try:
            fn()
        except FileNotFoundError as exc:
            print(f"({exc.filename} missing)\n")


if __name__ == "__main__":
    main()

"""Facts that look across threads, computed from the store after a source's threads are written.

Parsing one file decides what that file owns. Which file continued which, and which root a thread
belongs to, need every thread of a source, so the ingesters record per-thread links while parsing
(``thread_links``) and this module turns them into ``fork_edges`` and the ``forked_from_id``,
``lineage_id`` and ``lineage_depth`` columns of ``threads``. It runs on the target after every
publish, over metadata only, so an incremental run that replaced three files recomputes a source's
lineage in milliseconds.

Link kinds
----------
``producer``
    A Claude file copied ``records`` messages produced by ``target_thread_id``; ``ordinal`` is the
    order of first appearance, ``ts`` the last copied message. The last producer is the parent.
``continued-in``
    A Claude session's own record naming the session that continued it.
``fork-context-ref``
    A Claude sub-agent referencing its session's context; ``detail`` holds the parent's last uuid.
``forked-from``
    A Codex rollout's ``session_meta`` naming the thread it was forked from.
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

import duckdb

from . import schema
from .base import assign_lineage


def derive_lineage(connection: duckdb.DuckDBPyConnection, source_id: str, source: str) -> dict[str, Any]:
    """Rebuild ``fork_edges`` and the lineage columns of ``threads`` for one source.

    Parameters
    ----------
    connection : duckdb.DuckDBPyConnection
        Connection to the database holding the source's threads and links.
    source_id : str
        Which source to recompute.
    source : str
        The ``source`` value written to new edge rows.

    Returns
    -------
    dict
        ``edges`` written, ``threads`` updated and any ``notes`` (cycles).
    """
    threads: dict[str, dict[str, Any]] = {}
    for thread_id, parent, forked, created in connection.execute(
        "select thread_id, parent_thread_id, forked_from_id, created_at from threads where source_id = ?",
        [source_id],
    ).fetchall():
        threads[thread_id] = {
            "thread_id": thread_id,
            "parent_thread_id": parent,
            "forked_from_id": forked if parent else None,
            "created_at": created,
        }
    links: dict[str, list[tuple]] = defaultdict(list)
    for row in connection.execute(
        "select thread_id, kind, target_thread_id, ordinal, records, ts, detail from thread_links "
        "where source_id = ? order by thread_id, kind, ordinal",
        [source_id],
    ).fetchall():
        links[row[0]].append(row)

    edges: list[tuple] = []
    edge_index: dict[str, int] = {}

    def edge(parent: str, child: str, **values: Any) -> None:
        edge_index[child] = len(edges)
        edges.append(
            schema.row(
                "fork_edges",
                parent_thread_id=parent,
                child_thread_id=child,
                source_id=source_id,
                source=source,
                origin="derived",
                **{"ambiguous": False, **values},
            )
        )

    for thread_id, rows in links.items():
        record = threads.get(thread_id)
        producers = [row for row in rows if row[1] == "producer"]
        if producers and record is not None and not record["parent_thread_id"]:
            parent = producers[-1][2]
            record["forked_from_id"] = parent
            edge(
                parent,
                thread_id,
                kind="continuation",
                evidence="marker",
                inherited_records=sum(int(row[4] or 0) for row in producers),
                fork_point_ts=max((row[5] for row in producers if row[5] is not None), default=None),
                child_started_at=record["created_at"],
            )
        for row in rows:
            if row[1] == "fork-context-ref" and record is not None and record["parent_thread_id"]:
                detail = json.loads(row[6] or "{}")
                parent = row[2] or record["parent_thread_id"]
                record["forked_from_id"] = parent
                fork_point = None
                last_uuid = detail.get("parentLastUuid")
                if last_uuid:
                    found = connection.execute(
                        "select created_at from items where source_id = ? and thread_id = ? and uuid = ? "
                        "order by rollout_ordinal limit 1",
                        [source_id, parent, last_uuid],
                    ).fetchone()
                    fork_point = found[0] if found else None
                edge(
                    parent,
                    thread_id,
                    kind="subagent-fork",
                    evidence="fork-context-ref",
                    inherited_records=row[4],
                    fork_point_ts=fork_point,
                    child_started_at=record["created_at"],
                )
            elif row[1] == "forked-from" and record is not None:
                parent = row[2]
                if parent and parent != thread_id:
                    record["forked_from_id"] = parent
                    edge(
                        parent,
                        thread_id,
                        kind="fork",
                        evidence="rollout",
                        child_started_at=record["created_at"],
                    )
    for thread_id, rows in links.items():
        for row in rows:
            if row[1] != "continued-in" or not row[2]:
                continue
            successor = row[2]
            index = edge_index.get(successor)
            if index is not None and edges[index][0] == thread_id:
                evidence_at = [name for name, _ in schema.COLUMNS["fork_edges"]].index("evidence")
                current = edges[index]
                edges[index] = (
                    current[:evidence_at] + (f"{current[evidence_at]}+continued-in",) + current[evidence_at + 1 :]
                )
                continue
            child = threads.get(successor)
            edge(
                thread_id,
                successor,
                kind="continuation",
                evidence="continued-in",
                child_started_at=child["created_at"] if child else row[5],
            )
            if child is not None and not child.get("forked_from_id"):
                child["forked_from_id"] = thread_id
    notes = assign_lineage(threads)

    connection.execute("DELETE FROM fork_edges WHERE source_id = ?", [source_id])
    schema.insert(connection, "fork_edges", edges)
    updates = [
        (record.get("forked_from_id"), record["lineage_id"], record["lineage_depth"], thread_id)
        for thread_id, record in threads.items()
    ]
    if updates:
        connection.register(
            "_lineage_updates",
            _as_table(updates),
        )
        connection.execute(
            "UPDATE threads SET forked_from_id = u.forked_from_id, lineage_id = u.lineage_id, "
            "lineage_depth = u.lineage_depth FROM _lineage_updates u "
            "WHERE threads.thread_id = u.thread_id AND threads.source_id = ?",
            [source_id],
        )
        connection.unregister("_lineage_updates")
    return {"edges": len(edges), "threads": len(updates), "notes": list(notes.values())}


def _as_table(updates: list[tuple]) -> Any:
    import pyarrow as pa

    forked, lineage, depth, thread_id = zip(*updates, strict=True)
    return pa.table(
        {
            "forked_from_id": pa.array(forked, type=pa.string()),
            "lineage_id": pa.array(lineage, type=pa.string()),
            "lineage_depth": pa.array(depth, type=pa.int32()),
            "thread_id": pa.array(thread_id, type=pa.string()),
        }
    )


def dedupe_responses(connection: duckdb.DuckDBPyConnection, source_id: str) -> int:
    """Mark responses that several unmarked files of one source claim, keeping the earliest-started thread's.

    Parallel sub-agents launched from one call can begin with the same responses, and files
    written without markers cannot say so themselves. After publishing, any response id that more
    than one thread of a source holds as its own stays with the thread that started first (ties
    broken by thread id) and the other copies get ``origin = 'copied-context'``, so usage counts
    them once and the duplicate check stays at zero. One pass settles every group.

    Returns
    -------
    int
        Number of response rows marked as copies.
    """
    before = connection.execute(
        "select count(*) from responses where source_id = ? and origin = 'copied-context'", [source_id]
    ).fetchone()[0]
    connection.execute(
        """
        UPDATE responses r SET origin = 'copied-context'
        FROM (
            SELECT n.thread_id, n.response_id
            FROM responses n
            JOIN threads hn ON hn.thread_id = n.thread_id AND hn.source_id = n.source_id
            JOIN responses o ON o.source_id = n.source_id AND o.response_id = n.response_id
                 AND o.thread_id <> n.thread_id AND o.origin <> 'copied-context'
            JOIN threads ho ON ho.thread_id = o.thread_id AND ho.source_id = o.source_id
            WHERE n.source_id = ? AND n.origin <> 'copied-context'
              AND (ho.created_at < hn.created_at
                   OR (ho.created_at IS NOT DISTINCT FROM hn.created_at AND ho.thread_id < hn.thread_id))
        ) d
        WHERE r.source_id = ? AND r.thread_id = d.thread_id AND r.response_id = d.response_id
        """,
        [source_id, source_id],
    )
    after = connection.execute(
        "select count(*) from responses where source_id = ? and origin = 'copied-context'", [source_id]
    ).fetchone()[0]
    return int(after - before)

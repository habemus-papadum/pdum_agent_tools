"""Ingest agent session history into DuckDB with one shared schema.

The Codex ingester reads a Codex home read-only; the Claude ingester reads a Claude Code
configuration directory. Both write the tables described by :mod:`pdum.agent_history.schema`,
tagging every row with its ``source`` and ``origin`` so analysis code can say which input
produced a fact. Query, invariant and forensics code lives in the TypeScript package
``@habemus-papadum/agent-history``; this package owns the schema contract and the readers.
"""

from .base import DEFAULT_WINDOW_DAYS, IngestSummary
from .claude import ClaudeIngest, ingest_claude_dir
from .codex import CodexIngest, ingest_codex_home
from .config import Config
from .config import load as load_config
from .schema import SCHEMA_VERSION, describe
from .sync import sync
from .targets import Target

__all__ = [
    "DEFAULT_WINDOW_DAYS",
    "SCHEMA_VERSION",
    "ClaudeIngest",
    "CodexIngest",
    "Config",
    "IngestSummary",
    "Target",
    "describe",
    "ingest_claude_dir",
    "ingest_codex_home",
    "load_config",
    "sync",
]

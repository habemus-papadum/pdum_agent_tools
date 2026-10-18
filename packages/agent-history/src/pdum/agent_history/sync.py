"""One command for every agent on the machine: sync each configured source into each target."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime

from .base import BaseIngest, IngestSummary
from .claude import ClaudeIngest
from .codex import CodexIngest
from .config import Config, ConfigError, Source
from .targets import Target


def build(
    source: Source,
    target: Target,
    config: Config,
    *,
    mode: str,
    now: datetime | None = None,
    host: dict[str, str] | None = None,
) -> BaseIngest:
    """Construct the ingester for one source and target."""
    kind = CodexIngest if source.agent == "codex" else ClaudeIngest
    ingest = kind(
        source.root,
        target,
        window_days=config.window_days,
        blobs=config.blobs,
        now=now,
        mode=mode,
        host=host,
    )
    ingest.summary.label = source.label
    return ingest


def sync(
    config: Config,
    *,
    targets: Iterable[str] | None = None,
    full: bool = False,
    now: datetime | None = None,
    host: dict[str, str] | None = None,
) -> list[IngestSummary]:
    """Sync every source into every selected target and return one summary per pair.

    Parameters
    ----------
    config : Config
        Parsed configuration.
    targets : iterable of str or None
        Target names or specs to use; all when None.
    full : bool
        Re-read every unit instead of only the changed ones.
    now : datetime or None
        Reference time for the window, for tests.
    host : dict or None
        Host identity override, for tests.
    """
    wanted = set(targets or [])
    selected = [target for target in config.targets if not wanted or target.label in wanted or target.spec in wanted]
    if wanted and not selected:
        raise ConfigError(f"no target named {sorted(wanted)}; configured: {[t.label for t in config.targets]}")
    summaries: list[IngestSummary] = []
    for target in selected:
        for source in config.sources:
            ingest = build(source, target, config, mode="full" if full else "sync", now=now, host=host)
            summaries.append(ingest.run())
    return summaries

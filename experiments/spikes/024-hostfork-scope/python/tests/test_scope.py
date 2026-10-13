"""Real OS integration matrix; requires a usable systemd user manager."""

import asyncio
import importlib.util
from pathlib import Path

import pytest
from hostfork_scope_spike import ScopedProcess, scoped_process
from hostfork_spike.linux import identity, signal_verified


def test_scope_matrix(tmp_path: Path) -> None:
    """Exercise actual adoption, I/O, descendant death and failure evidence."""
    entry = Path(__file__).resolve().parents[2] / "probe.py"
    spec = importlib.util.spec_from_file_location("scope_probe", entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    asyncio.run(module.matrix(tmp_path / "evidence"))


def test_journal_failure_aborts_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed journal write after spawn must not leak a gate or run its target."""
    original_save = scoped_process.save
    original_spawn = asyncio.create_subprocess_exec
    spawned = []

    async def capture_spawn(*args, **kwargs):
        process = await original_spawn(*args, **kwargs)
        spawned.append((process, identity(process.pid)))
        return process

    def failing_save(path: Path, record: dict) -> None:
        if record["stage"] == "gated":
            raise OSError("injected post-spawn journal failure")
        original_save(path, record)

    monkeypatch.setattr(scoped_process, "save", failing_save)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_spawn)

    async def exercise() -> None:
        try:
            with pytest.raises(OSError, match="injected post-spawn"):
                await ScopedProcess.prepare(["/bin/true"], artifact_root=tmp_path / "environment")
            assert len(spawned) == 1
            assert spawned[0][0].returncode == 125
            assert not (tmp_path / "environment" / "released.txt").exists()
        finally:
            for process, expected in spawned:
                signal_verified(expected)
                await asyncio.wait_for(process.wait(), 3)

    asyncio.run(exercise())

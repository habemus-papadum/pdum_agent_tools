"""Cancellation timing gates around actual file writes and profile leases."""

import asyncio
import json
import sys
import threading
import tomllib

import pytest
from pdum.codex_launcher import (
    LaunchOptions,
    ProfileBusy,
    ProfileSpec,
    configure_api_key,
    create_profile,
    launch,
    profile_status,
    profiles,
    runtime,
    temporary_profile,
    workflow,
)
from pdum.codex_launcher.runtime import dispose_profile, profile_lease


class WriteGate:
    def __init__(self, original, selected):
        self.original = original
        self.selected = selected
        self.entered = asyncio.Event()
        self.release = threading.Event()
        self.loop = asyncio.get_running_loop()
        self.used = False

    def __call__(self, path, content):
        if not self.used and self.selected(path, content):
            self.used = True
            self.loop.call_soon_threadsafe(self.entered.set)
            if not self.release.wait(5):
                raise TimeoutError("File-write test gate was not released")
        self.original(path, content)


async def test_cancelled_api_key_update_holds_lease_until_both_files_finish(tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=sys.executable))
    gate = WriteGate(workflow.atomic_write, lambda path, content: path.name == "config.toml")
    monkeypatch.setattr(workflow, "atomic_write", gate)
    operation = asyncio.create_task(configure_api_key(profile, "CANCELLATION_TEST_KEY"))
    try:
        await asyncio.wait_for(gate.entered.wait(), 2)
        operation.cancel()
        await asyncio.sleep(0.02)
        assert not operation.done()
        with pytest.raises(ProfileBusy):
            async with profile_lease(profile):
                pass
    finally:
        gate.release.set()
    with pytest.raises(asyncio.CancelledError):
        await operation
    native = tomllib.loads((profile / "codex/config.toml").read_text())
    launcher = tomllib.loads((profile / "launcher.toml").read_text())
    assert native["model_providers"]["pdum_api"]["env_key"] == "CANCELLATION_TEST_KEY"
    assert "CANCELLATION_TEST_KEY" in launcher["environment"]["inherit_keys"]
    async with profile_lease(profile):
        pass


async def test_cancelled_starting_journal_cannot_overwrite_closed_state(tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=sys.executable))
    gate = WriteGate(runtime.atomic_write, lambda path, content: json.loads(content).get("state") == "starting")
    monkeypatch.setattr(runtime, "atomic_write", gate)

    async def operation():
        async with launch(profile, LaunchOptions(relay=False)):
            pytest.fail("Cancellation must stop launch before creating a process")

    pending = asyncio.create_task(operation())
    try:
        await asyncio.wait_for(gate.entered.wait(), 2)
        pending.cancel()
        await asyncio.sleep(0.02)
        assert not pending.done()
        with pytest.raises(ProfileBusy):
            async with profile_lease(profile):
                pass
    finally:
        gate.release.set()
    with pytest.raises(asyncio.CancelledError):
        await pending
    state = await profile_status(profile)
    assert state["state"] == "closed"
    assert not state["server_alive"]
    assert not state["locked"]
    async with profile_lease(profile):
        pass


async def test_temporary_allocation_cancellation_does_not_lose_directory(tmp_path, monkeypatch):
    original = profiles.tempfile.mkdtemp
    loop = asyncio.get_running_loop()
    pending = None
    allocated = []

    def allocate(*arguments, **keywords):
        directory = original(*arguments, **keywords)
        if keywords.get("prefix") == "pdum-codex-":
            allocated.append(directory)
            loop.call_soon_threadsafe(pending.cancel)
        return directory

    monkeypatch.setattr(profiles.tempfile, "mkdtemp", allocate)

    async def operation():
        async with temporary_profile(ProfileSpec(executable=sys.executable), clean=True, parent=tmp_path):
            pytest.fail("Cancellation should occur during temporary setup")

    pending = asyncio.create_task(operation())
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pending, 5)
    assert allocated
    assert list(tmp_path.iterdir()) == []


async def test_cancelled_disposal_finishes_marker_and_removal_before_returning(tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=sys.executable))
    gate = WriteGate(runtime.atomic_write, lambda path, content: path.name == "disposed")
    monkeypatch.setattr(runtime, "atomic_write", gate)
    operation = asyncio.create_task(dispose_profile(profile))
    try:
        await asyncio.wait_for(gate.entered.wait(), 2)
        operation.cancel()
        await asyncio.sleep(0.02)
        assert not operation.done()
        with pytest.raises(ProfileBusy):
            async with profile_lease(profile):
                pass
    finally:
        gate.release.set()
    with pytest.raises(asyncio.CancelledError):
        await operation
    assert not profile.exists()

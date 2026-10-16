import asyncio
import os
import shutil
import signal

import psutil
import pytest
from pdum.codex_launcher import (
    LaunchOptions,
    ProfileSpec,
    configure_profile_capture,
    create_profile,
    launch,
    profile_status,
)
from pdum.mitm import SidecarConfig

pytestmark = [pytest.mark.codex, pytest.mark.skipif(shutil.which("codex") is None, reason="Codex not installed")]


async def test_managed_sidecar_toggle_status_and_shutdown(tmp_path):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=shutil.which("codex")))
    options = LaunchOptions(host="127.0.0.1", mitm_config=SidecarConfig(capture_dir=tmp_path / "capture"))
    async with launch(profile, options) as server:
        initial = next(run for run in (await profile_status(profile))["runs"] if run["run_id"] == server.run_id)
        proxy_pid = initial["mitm"]["pid"]
        assert psutil.pid_exists(proxy_pid)
        assert not initial["capture"]["recording"]
        updated = await configure_profile_capture(profile, True)
        assert updated["recording"]
        await server.configure_capture(False, expected_revision=updated["revision"])
        assert not (await server.status())["capture"]["recording"]
    assert not psutil.pid_exists(proxy_pid)
    assert (await profile_status(profile))["live_runs"] == []
    assert list((tmp_path / "capture").glob("*/manifest.json"))


async def test_fatal_sidecar_exit_stops_owned_codex(tmp_path):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=shutil.which("codex")))
    async with launch(profile, LaunchOptions(host="127.0.0.1", mitm_config=SidecarConfig())) as server:
        status = await server.status()
        os.kill(status["mitm"]["pid"], signal.SIGKILL)
        await asyncio.wait_for(server.wait(), 15)
        assert not psutil.pid_exists(server.pid)
        assert "sidecar_failure" in await server.status()
    assert (await profile_status(profile))["live_runs"] == []

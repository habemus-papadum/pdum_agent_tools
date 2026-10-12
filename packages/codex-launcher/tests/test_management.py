import shutil

import httpx
import pytest
from fastapi import FastAPI
from pdum.codex_launcher import LaunchOptions, ProfileSpec, create_profile, launch
from pdum.codex_launcher.management import create_app
from pdum.mitm import SidecarConfig

CODEX = shutil.which("codex")
pytestmark = [pytest.mark.codex, pytest.mark.skipif(CODEX is None, reason="Native Codex executable is not installed")]


async def test_mounted_management_delegates_without_taking_process_ownership(tmp_path):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=CODEX, model="gpt-6-luna"))
    async with launch(profile, LaunchOptions(host="127.0.0.1")) as server:
        application = FastAPI()
        application.mount("/agent", create_app(server))
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://management"
        ) as client:
            response = await client.get("/agent/status")
            assert response.status_code == 200
            assert response.json()["state"] == "ready"
            response = await client.post("/agent/capture", json={"enabled": True})
            assert response.status_code == 409
            assert "No MITM sidecar" in response.json()["detail"]
            for invalid in (
                {"enabled": "true"},
                {"enabled": True, "expected_revision": -1},
                {"enabled": True, "extra": 1},
            ):
                assert (await client.post("/agent/capture", json=invalid)).status_code == 422
        assert (await server.status())["state"] == "ready"
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://management"
        ) as client:
            assert (await client.post("/agent/stop")).json() == {"stopped": True}
            assert (await client.get("/agent/status")).json()["state"] == "closed"
            assert (await client.post("/agent/stop")).json() == {"stopped": True}


async def test_management_toggles_real_sidecar_and_reports_revision_conflicts(tmp_path):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=CODEX, model="gpt-6-luna"))
    options = LaunchOptions(host="127.0.0.1", mitm_config=SidecarConfig(capture_dir=tmp_path / "captures"))
    async with launch(profile, options) as server:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(server)), base_url="http://management"
        ) as client:
            response = await client.post("/capture", json={"enabled": True, "expected_revision": 0})
            assert response.status_code == 200
            assert response.json()["recording"] is True
            assert response.json()["revision"] == 1
            response = await client.post("/capture", json={"enabled": False, "expected_revision": 0})
            assert response.status_code == 409
            response = await client.post("/capture", json={"enabled": False, "expected_revision": 1})
            assert response.status_code == 200
            assert response.json()["recording"] is False
            assert (await client.get("/status")).json()["capture"]["revision"] == 2

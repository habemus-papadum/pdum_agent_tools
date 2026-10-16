"""Generated authentication settings accepted by the real native app-server."""

from __future__ import annotations

import asyncio
import json
import shutil
import tomllib
from pathlib import Path

import pytest
from pdum.codex_launcher import LaunchOptions, ProfileSpec, create_profile, launch
from pdum.codex_launcher.authentication import AuthSpec, apply_auth
from pdum.codex_launcher.federation import FederationSpec
from websockets.asyncio.client import connect

CODEX = shutil.which("codex")


async def request(connection, identifier: int, method: str, params: dict) -> dict:
    await connection.send(json.dumps({"id": identifier, "method": method, "params": params}))
    async with asyncio.timeout(15):
        while True:
            message = json.loads(await connection.recv())
            if message.get("id") == identifier:
                assert "error" not in message, message
                return message["result"]


@pytest.mark.codex
@pytest.mark.skipif(CODEX is None, reason="Native Codex executable is not installed")
@pytest.mark.parametrize("method", ["api-key", "aws-federation"])
async def test_native_accepts_generated_auth_without_resolving_credentials(tmp_path: Path, monkeypatch, method: str):
    directory = tmp_path / "profile"
    await create_profile(directory, ProfileSpec(executable=CODEX))
    specification = AuthSpec(
        method=method,
        api_key_env="PDUM_LOCAL_TEST_KEY",
        federation=FederationSpec(
            region="us-east-1",
            identity_provider_id="unused-local-provider",
            service_account_id="unused-local-account",
            aws_home=tmp_path / "aws-home",
            aws_executable="must-not-execute-aws-during-config-read",
        ),
    )
    native_path = directory / "config.toml"
    launcher_path = directory / ".pdum/launcher.toml"
    native, metadata = apply_auth(native_path.read_text(), launcher_path.read_text(), specification, directory)
    native_path.write_text(native)
    launcher_path.write_text(metadata)
    monkeypatch.setenv("PDUM_LOCAL_TEST_KEY", "local-placeholder-never-sent-upstream")
    expected_provider = tomllib.loads(native)["model_provider"]
    async with launch(directory, LaunchOptions(host="127.0.0.1")) as server:
        async with connect(server.endpoint, max_size=None, proxy=None) as connection:
            await request(
                connection,
                1,
                "initialize",
                {"clientInfo": {"name": "pdum-auth-config-review", "version": "1"}},
            )
            await connection.send(json.dumps({"method": "initialized"}))
            configuration = await request(connection, 2, "config/read", {"includeLayers": False})
            account = await request(connection, 3, "account/read", {"refreshToken": False})
    actual = configuration["config"]
    assert actual["model_provider"] == expected_provider
    assert actual["model_providers"][expected_provider]["supports_websockets"]
    assert not account["requiresOpenaiAuth"]
    assert account["account"] is None
    assert not (directory / "auth.json").exists()

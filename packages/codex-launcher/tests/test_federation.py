import asyncio
import json
import os
import signal
import sys
from dataclasses import replace
from pathlib import Path

import psutil
import pytest
from aiohttp import web
from pdum.codex_launcher import federation
from pdum.codex_launcher.authentication import AuthSpec, apply_auth, login_auth
from pdum.codex_launcher.errors import ProfileError
from pdum.codex_launcher.federation import (
    FederationSpec,
    aws_environment,
    aws_login,
    federation_from_settings,
    federation_settings,
    mint_token,
)
from pdum.codex_launcher.profiles import ProfileSpec, create_profile
from pdum.codex_launcher.runtime import profile_status, stop_profile


def aws_script(tmp_path: Path, body: str) -> Path:
    executable = tmp_path / "aws-fixture"
    executable.write_text(f"#!{psutil.Process().exe()}\n" + body)
    executable.chmod(0o700)
    return executable


def spec_for(tmp_path: Path, executable: Path) -> FederationSpec:
    return FederationSpec(
        "us-east-1",
        "idp_example",
        "user-example",
        aws_profile="example",
        aws_home=tmp_path / "aws-home",
        aws_executable=str(executable),
        timeout_seconds=2,
    )


def test_aws_context_changes_only_child_environment(tmp_path):
    spec = FederationSpec(
        "us-east-1",
        "idp_example",
        "user-example",
        aws_home=tmp_path,
        aws_profile="example",
        aws_config_file=tmp_path / "config",
        aws_credentials_file=tmp_path / "credentials",
        aws_login_cache_directory=tmp_path / "login-cache",
    )
    parent = {"HOME": "/isolated-codex", "CODEX_HOME": "/isolated-codex/codex", "OTHER": "keep"}
    child = aws_environment(spec, parent)
    assert child["HOME"] == str(tmp_path)
    assert child["CODEX_HOME"] == parent["CODEX_HOME"]
    assert child["AWS_CONFIG_FILE"] == str(tmp_path / "config")
    assert child["AWS_SHARED_CREDENTIALS_FILE"] == str(tmp_path / "credentials")
    assert child["AWS_LOGIN_CACHE_DIRECTORY"] == str(tmp_path / "login-cache")
    assert parent["HOME"] == "/isolated-codex"
    assert federation_from_settings(federation_settings(spec)) == spec


async def test_local_subprocess_and_http_exchange_contract(tmp_path, monkeypatch):
    calls = tmp_path / "calls.jsonl"
    executable = aws_script(
        tmp_path,
        "import json, os, pathlib, sys\n"
        f"with pathlib.Path({str(calls)!r}).open('a') as stream:\n"
        "    stream.write(json.dumps({'args': sys.argv[1:], 'home': os.environ['HOME']}) + '\\n')\n"
        "print(json.dumps({'WebIdentityToken': 'fixture-subject-not-real'}))\n",
    )
    requests = []

    async def exchange(request):
        requests.append(await request.json())
        return web.json_response({"access_token": f"fixture-access-{len(requests)}", "expires_in": 3600})

    application = web.Application()
    application.router.add_post("/token", exchange)
    runner = web.AppRunner(application)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    monkeypatch.setattr(federation, "TOKEN_ENDPOINT", f"http://127.0.0.1:{port}/token")
    try:
        spec = replace(spec_for(tmp_path, executable), client_id="example-client")
        first = await mint_token(spec)
        second = await mint_token(spec)
        assert first.access_token == "fixture-access-1"
        assert second.access_token == "fixture-access-2"
        assert "fixture-access" not in repr(first)
        assert requests[0] == {
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token": "fixture-subject-not-real",
            "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
            "identity_provider_id": "idp_example",
            "service_account_id": "user-example",
            "client_id": "example-client",
        }
        invocations = [json.loads(line) for line in calls.read_text().splitlines()]
        assert len(invocations) == 2
        assert invocations[0]["home"] == str(tmp_path / "aws-home")
        assert invocations[0]["args"][:2] == ["sts", "get-web-identity-token"]
        assert "--profile" in invocations[0]["args"]
    finally:
        await runner.cleanup()


@pytest.mark.parametrize(
    ("status", "payload", "error"),
    [
        (401, {"secret": "do-not-show"}, "HTTP 401"),
        (200, {"access_token": "fixture-secret", "expires_in": 241}, "too short"),
        (200, {"access_token": "fixture-secret"}, "invalid access token or expiry"),
        (200, {"access_token": "fixture-secret", "expires_in": True}, "invalid access token or expiry"),
    ],
)
async def test_exchange_failure_diagnostics_never_include_payload(tmp_path, monkeypatch, status, payload, error):
    executable = aws_script(tmp_path, 'print(\'{"WebIdentityToken": "fixture-subject"}\')\n')

    async def exchange(request):
        await request.read()
        return web.json_response(payload, status=status)

    application = web.Application()
    application.router.add_post("/token", exchange)
    runner = web.AppRunner(application)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    monkeypatch.setattr(federation, "TOKEN_ENDPOINT", f"http://127.0.0.1:{port}/token")
    try:
        with pytest.raises(ProfileError, match=error) as captured:
            await mint_token(spec_for(tmp_path, executable))
        assert "fixture-secret" not in str(captured.value)
        assert "do-not-show" not in str(captured.value)
    finally:
        await runner.cleanup()


async def test_aws_failed_subprocess_has_no_stderr_secrets(tmp_path):
    executable = aws_script(tmp_path, "import sys\nprint('fixture-secret', file=sys.stderr)\nsys.exit(7)\n")
    with pytest.raises(ProfileError, match="exit 7") as captured:
        await mint_token(spec_for(tmp_path, executable))
    assert "fixture-secret" not in str(captured.value)


async def test_cancelling_aws_operation_reaps_real_child(tmp_path):
    marker = tmp_path / "pid"
    executable = aws_script(
        tmp_path,
        f"import os, pathlib, time\npathlib.Path({str(marker)!r}).write_text(str(os.getpid()))\ntime.sleep(30)\n",
    )
    pending = asyncio.create_task(mint_token(replace(spec_for(tmp_path, executable), timeout_seconds=30)))
    async with asyncio.timeout(5):
        while not marker.exists():
            await asyncio.sleep(0.01)
    process_id = int(marker.read_text())
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    with pytest.raises(ProcessLookupError):
        os.kill(process_id, 0)


async def test_aws_login_is_explicit_and_uses_selected_context(tmp_path):
    marker = tmp_path / "login.json"
    executable = aws_script(
        tmp_path,
        "import json, os, pathlib, sys\n"
        f"pathlib.Path({str(marker)!r}).write_text(json.dumps({{'args': sys.argv[1:], 'home': os.environ['HOME']}}))\n",
    )
    spec = spec_for(tmp_path, executable)
    await aws_login(spec)
    assert json.loads(marker.read_text())["args"][:2] == ["sso", "login"]
    assert json.loads(marker.read_text())["home"] == str(tmp_path / "aws-home")
    await aws_login(replace(spec, login_method="login"))
    assert json.loads(marker.read_text())["args"][0] == "login"
    with pytest.raises(ProfileError, match="no interactive"):
        await aws_login(replace(spec, login_method="none"))


async def test_helper_entry_missing_profile_exits_without_stdout(tmp_path):
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "pdum.codex_launcher._federation_helper",
        "--profile-dir",
        str(tmp_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    assert process.returncode == 1
    assert stdout == b""
    assert b"valid AWS federation settings" in stderr
    assert b"RuntimeWarning" not in stderr


async def test_profile_aws_login_journals_and_recovers_orphan_without_cloud(tmp_path):
    marker = tmp_path / "login-pid"
    executable = aws_script(
        tmp_path,
        f"import os, pathlib, time\npathlib.Path({str(marker)!r}).write_text(str(os.getpid()))\ntime.sleep(30)\n",
    )
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=sys.executable))
    native, launcher = apply_auth(
        (profile / "config.toml").read_text(),
        (profile / ".pdum/launcher.toml").read_text(),
        AuthSpec("aws-federation", federation=spec_for(tmp_path, executable)),
        profile,
    )
    (profile / "config.toml").write_text(native)
    (profile / ".pdum/launcher.toml").write_text(launcher)
    controller_log = tmp_path / "controller.log"
    with controller_log.open("wb") as output:
        controller = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            "import asyncio, pathlib, sys; from pdum.codex_launcher.authentication import login_auth; "
            "asyncio.run(login_auth(pathlib.Path(sys.argv[1])))",
            str(profile),
            stdout=output,
            stderr=asyncio.subprocess.STDOUT,
        )
    try:
        async with asyncio.timeout(5):
            while True:
                runs = (await profile_status(profile))["runs"]
                login_runs = [run for run in runs if run.get("state") == "authenticating"]
                if login_runs and marker.exists():
                    state = login_runs[0]
                    break
                if controller.returncode is not None:
                    pytest.fail(f"Fixture controller exited: {controller_log.read_text()}")
                await asyncio.sleep(0.02)
        assert state["authentication_method"] == "aws-federation"
        controller.kill()
        await controller.wait()
        orphan = next(run for run in (await profile_status(profile))["runs"] if run["run_id"] == state["run_id"])
        assert orphan["server_alive"] and not orphan["owner_alive"]
        recovered = next(
            run for run in (await stop_profile(profile, timeout=1))["runs"] if run["run_id"] == state["run_id"]
        )
        assert not recovered["live"]
        assert recovered["state"] == "closed"
        assert recovered["recovered"]
    finally:
        if controller.returncode is None:
            controller.kill()
            await controller.wait()
        if marker.exists():
            try:
                os.kill(int(marker.read_text()), signal.SIGTERM)
            except ProcessLookupError:
                pass


async def test_profile_api_auth_has_no_login_action(tmp_path):
    profile = tmp_path / "profile"
    await create_profile(profile, ProfileSpec(executable=sys.executable))
    native, launcher = apply_auth(
        (profile / "config.toml").read_text(),
        (profile / ".pdum/launcher.toml").read_text(),
        AuthSpec("api-key"),
        profile,
    )
    (profile / "config.toml").write_text(native)
    (profile / ".pdum/launcher.toml").write_text(launcher)
    with pytest.raises(ProfileError, match="no managed login"):
        await login_auth(profile)

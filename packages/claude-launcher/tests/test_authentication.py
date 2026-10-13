import asyncio
import json
import os
import shutil
import sys

import psutil
import pytest
from pdum.claude_launcher import authentication
from pdum.claude_launcher.authentication import AuthSpec, auth_status, build_environment, login_auth
from pdum.claude_launcher.errors import AuthenticationError
from pdum.claude_launcher.profiles import create_profile


async def test_api_reference_environment_excludes_ambient_credentials_and_does_not_mutate_parent(tmp_path, monkeypatch):
    for key, value in {
        "ANTHROPIC_API_KEY": "ambient-api-value",
        "ANTHROPIC_AUTH_TOKEN": "ambient-bearer-value",
        "ANTHROPIC_PROFILE": "ambient-profile",
        "ANTHROPIC_CONFIG_DIR": "/ambient/anthropic",
        "CLAUDE_CODE_OAUTH_TOKEN": "ambient-oauth-value",
        "CLAUDE_CONFIG_DIR": "/ambient/claude",
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "CLAUDECODE": "1",
        "SELECTED_KEY": "selected-api-value",
        "EDITOR": "keep-this",
    }.items():
        monkeypatch.setenv(key, value)
    parent_environment = dict(os.environ)
    profile = create_profile(tmp_path / "profile", workspace=tmp_path, auth=AuthSpec("api-key", "SELECTED_KEY"))
    environment = await build_environment(profile)
    assert environment["ANTHROPIC_API_KEY"] == "selected-api-value"
    assert environment["CLAUDE_CONFIG_DIR"] == str(profile.config_directory)
    assert environment["ANTHROPIC_CONFIG_DIR"] == str(profile.anthropic_directory)
    assert environment["EDITOR"] == "keep-this"
    assert "SELECTED_KEY" not in environment
    assert "CLAUDECODE" not in environment
    assert "ANTHROPIC_AUTH_TOKEN" not in environment
    assert "ANTHROPIC_PROFILE" not in environment
    assert "CLAUDE_CODE_USE_BEDROCK" not in environment
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in environment
    assert dict(os.environ) == parent_environment
    uncredentialed = await build_environment(profile, authenticate=False)
    assert "ANTHROPIC_API_KEY" not in uncredentialed
    monkeypatch.delenv("SELECTED_KEY")
    with pytest.raises(AuthenticationError, match="SELECTED_KEY"):
        await build_environment(profile)
    assert await build_environment(profile, authenticate=False)


async def test_file_login_reuse_is_read_only_does_not_copy_refresh_and_supports_concurrency(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    path = source / ".credentials.json"
    original = json.dumps({"claudeAiOauth": {"accessToken": "synthetic-access", "refreshToken": "do-not-copy"}})
    path.write_text(original)
    profile = create_profile(
        tmp_path / "profile", workspace=tmp_path, auth=AuthSpec("reuse-login", source_directory=source)
    )
    environments = await asyncio.gather(*(build_environment(profile) for _ in range(3)))
    assert all(environment["CLAUDE_CODE_OAUTH_TOKEN"] == "synthetic-access" for environment in environments)
    assert path.read_text() == original
    for destination in profile.directory.rglob("*"):
        if destination.is_file():
            assert "synthetic-access" not in destination.read_text()
            assert "do-not-copy" not in destination.read_text()
    path.write_text("unparseable-secret-payload")
    with pytest.raises(AuthenticationError) as error:
        await build_environment(profile)
    assert "unparseable-secret-payload" not in str(error.value)
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in await build_environment(profile, authenticate=False)


def _native_fixture(tmp_path, body):
    executable = tmp_path / "native-fixture"
    executable.write_text(f"#!{sys.executable}\n" + body)
    executable.chmod(0o700)
    return str(executable)


async def test_auth_commands_use_owned_roots_and_login_preserves_native_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ambient-key-never-selected")
    executable = _native_fixture(
        tmp_path,
        "import json, os, pathlib, sys\n"
        "assert sys.argv[1:3] == ['--setting-sources', 'user']\n"
        "assert 'ANTHROPIC_API_KEY' not in os.environ\n"
        "assert 'CLAUDE_CODE_OAUTH_TOKEN' not in os.environ\n"
        "root = pathlib.Path(os.environ['CLAUDE_CONFIG_DIR'])\n"
        "assert root.parent / 'anthropic' == pathlib.Path(os.environ['ANTHROPIC_CONFIG_DIR'])\n"
        "if sys.argv[3:] == ['auth', 'login', '--claudeai']:\n"
        "    (root / 'native-login-fixture').write_text('created-by-native-command')\n"
        "else:\n"
        "    assert sys.argv[3:] == ['auth', 'status', '--json']\n"
        "    print(json.dumps({'loggedIn': False, 'authMethod': 'none', 'apiProvider': 'firstParty', "
        "'email': 'private-account@example.invalid', 'unknown': 'ignored-sensitive-value'}))\n"
        "    sys.exit(1)\n",
    )
    profile = create_profile(tmp_path / "profile", workspace=tmp_path, executable=executable, setting_sources=("user",))
    before = (profile.config_directory / "settings.json").read_bytes()
    status = await auth_status(profile)
    assert not status.logged_in
    assert status.exit_code == 1
    assert status.method == "none"
    assert "private-account" not in repr(status)
    assert "ignored-sensitive-value" not in repr(status)
    assert await login_auth(profile) == 0
    assert (profile.config_directory / "native-login-fixture").read_text() == "created-by-native-command"
    assert (profile.config_directory / "settings.json").read_bytes() == before


async def test_auth_status_failures_do_not_echo_output(tmp_path):
    executable = _native_fixture(tmp_path, "print('unparseable-sensitive-native-error')\n")
    profile = create_profile(tmp_path / "profile", workspace=tmp_path, executable=executable)
    with pytest.raises(AuthenticationError) as error:
        await auth_status(profile)
    assert "unparseable-sensitive-native-error" not in str(error.value)


async def test_login_rejects_non_native_profile(tmp_path):
    profile = create_profile(tmp_path / "profile", workspace=tmp_path, auth=AuthSpec("api-key"))
    with pytest.raises(AuthenticationError, match="native authentication"):
        await login_auth(profile)


async def test_auth_status_timeout_reaps_owned_process(tmp_path):
    executable = _native_fixture(
        tmp_path,
        "import os, pathlib, time\npathlib.Path('status.pid').write_text(str(os.getpid()))\ntime.sleep(60)\n",
    )
    profile = create_profile(tmp_path / "profile", workspace=tmp_path, executable=executable)
    with pytest.raises(AuthenticationError, match="timed out"):
        await auth_status(profile, timeout=0.5)
    pid = int((tmp_path / "status.pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.parametrize("operation", ["status", "login", "keychain"])
async def test_cancellation_during_spawn_keeps_ownership_and_reaps_real_child(tmp_path, monkeypatch, operation):
    executable = _native_fixture(tmp_path, "import time\ntime.sleep(60)\n")
    profile = create_profile(tmp_path / "profile", workspace=tmp_path, executable=executable)
    spawn = asyncio.create_subprocess_exec
    spawned = asyncio.Event()
    release = asyncio.Event()
    processes = []

    async def delayed_spawn(*command, **options):
        # Exercise the real OS child creation/ownership race while replacing
        # only the Keychain command with our credential-free fixture.
        if operation == "keychain":
            command = (executable,)
        process = await spawn(*command, **options)
        processes.append(process)
        spawned.set()
        await release.wait()
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed_spawn)
    coroutine = {
        "status": lambda: auth_status(profile),
        "login": lambda: login_auth(profile),
        "keychain": authentication._keychain_credentials,
    }[operation]()
    pending = asyncio.create_task(coroutine)
    try:
        await asyncio.wait_for(spawned.wait(), 5)
        pending.cancel()
        await asyncio.sleep(0)
        pending.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(pending, 5)
        assert processes[0].returncode is not None
        assert not psutil.pid_exists(processes[0].pid)
    finally:
        release.set()
        if not pending.done():
            pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        for process in processes:
            if process.returncode is None:
                process.kill()
                await process.wait()


@pytest.mark.skipif(os.name == "nt", reason="POSIX inherited-pipe fixture")
async def test_status_timeout_closes_owned_pipes_after_parent_exits_without_hanging(tmp_path):
    executable = _native_fixture(
        tmp_path,
        "import os, pathlib, subprocess, sys\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "pathlib.Path('descendant.pid').write_text(str(child.pid))\n"
        "os._exit(0)\n",
    )
    profile = create_profile(tmp_path / "profile", workspace=tmp_path, executable=executable)
    pending = asyncio.create_task(auth_status(profile, timeout=2))
    descendant = None
    try:
        async with asyncio.timeout(5):
            while not (tmp_path / "descendant.pid").exists():
                await asyncio.sleep(0.01)
        descendant = psutil.Process(int((tmp_path / "descendant.pid").read_text()))
        descendant.create_time()
        with pytest.raises(AuthenticationError, match="timed out"):
            await asyncio.wait_for(pending, 4)
        # An unknown escaped descendant is not killed by reusing its dead
        # parent's PID/group. The fixture, which owns its identity, removes it.
        assert descendant.is_running()
    finally:
        if descendant is not None and descendant.is_running():
            descendant.kill()
            await asyncio.to_thread(descendant.wait, 5)
        if not pending.done():
            pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.skipif(os.name == "nt", reason="POSIX SIGTERM escalation fixture")
async def test_status_cancellation_escalates_for_stubborn_owned_process(tmp_path):
    executable = _native_fixture(
        tmp_path,
        "import os, pathlib, signal, time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "pathlib.Path('stubborn.pid').write_text(str(os.getpid()))\n"
        "time.sleep(60)\n",
    )
    profile = create_profile(tmp_path / "profile", workspace=tmp_path, executable=executable)
    pending = asyncio.create_task(auth_status(profile))
    async with asyncio.timeout(5):
        while not (tmp_path / "stubborn.pid").exists():
            await asyncio.sleep(0.01)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pending, 3)
    with pytest.raises(ProcessLookupError):
        os.kill(int((tmp_path / "stubborn.pid").read_text()), 0)


@pytest.mark.claude
@pytest.mark.skipif(shutil.which("claude") is None, reason="Native Claude executable is unavailable")
async def test_real_native_status_fresh_profile_ignores_ambient_authentication(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "invalid-ambient-must-not-be-selected")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "invalid-ambient-must-not-be-selected")
    profile_a = create_profile(tmp_path / "a", workspace=tmp_path, setting_sources=())
    profile_b = create_profile(tmp_path / "b", workspace=tmp_path, setting_sources=())
    first, second = await asyncio.gather(auth_status(profile_a), auth_status(profile_b))
    assert first.logged_in is False
    assert second.logged_in is False
    assert first.method == second.method == "none"
    assert (profile_a.config_directory / ".claude.json").exists()
    assert (profile_b.config_directory / ".claude.json").exists()

import asyncio
import json
import os
import sys
import tomllib

import pytest
from pdum.codex_launcher.config import read_config
from pdum.codex_launcher.environment import build_environment
from pdum.codex_launcher.errors import ProfileError
from pdum.codex_launcher.profiles import (
    ProfileSpec,
    configure_api_key,
    create_profile,
    inspect_profile,
    list_profiles,
    resolve_profile,
    temporary_profile,
)


async def test_create_clone_keeps_native_unknowns_and_only_settings(tmp_path):
    source = tmp_path / "source"
    await create_profile(source, ProfileSpec(executable=sys.executable, model="example-model"))
    native = '# Keep this comment\nmodel="future"\n[new_section]\nunknown="verbatim"\ncredential="dummy"\n'
    (source / "codex/config.toml").write_text(native)
    (source / "codex/auth.json").write_text('{"dummy":"not-a-real-credential"}')
    (source / "codex/sessions").mkdir()
    (source / "codex/sessions/not-copied").write_text("history")
    (source / "codex/skills").mkdir()
    script = source / "codex/skills/script.sh"
    script.write_text("#!/bin/sh\nexit 0\n")
    script.chmod(0o755)
    destination = tmp_path / "clone"
    result = await create_profile(destination, ProfileSpec(source=source, copy_auth=True))
    assert (destination / "codex/config.toml").read_text() == native
    assert (source / "codex/config.toml").read_text() == native
    assert not (destination / "codex/sessions").exists()
    assert (destination / "codex/skills/script.sh").stat().st_mode & 0o111
    assert (destination / "codex/auth.json").stat().st_mode & 0o777 == 0o600
    assert result.auth_file_present
    assert len(result.warnings) == 2


async def test_concurrent_creation_yields_one_complete_profile(tmp_path):
    target = tmp_path / "shared"
    results = await asyncio.gather(
        *(create_profile(target, ProfileSpec(executable=sys.executable)) for _ in range(10)),
        return_exceptions=True,
    )
    assert sum(not isinstance(result, BaseException) for result in results) == 1
    assert all(not isinstance(result, BaseException) or isinstance(result, ProfileError) for result in results)
    assert (await inspect_profile(target)).directory == target.resolve()
    assert not list(tmp_path.glob(".shared.creating-*"))


async def test_minimal_native_defaults_and_model_override(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=sys.executable, model="gpt-6-luna"))
    config = tomllib.loads((path / "codex/config.toml").read_text())
    assert config["sandbox_mode"] == "danger-full-access"
    assert config["approval_policy"] == "never"
    assert config["model"] == "gpt-6-luna"


def test_selection_is_explicit_and_aliases_resolve(tmp_path):
    with pytest.raises(ProfileError):
        resolve_profile()
    with pytest.raises(ProfileError):
        resolve_profile("../escape", root=tmp_path)
    with pytest.raises(ProfileError):
        resolve_profile("name", directory=tmp_path)
    assert resolve_profile("research", root=tmp_path) == tmp_path.resolve() / "research"


async def test_environment_clean_and_inherited_remain_profile_local(tmp_path):
    path = (tmp_path / "profile").resolve()
    await create_profile(path, ProfileSpec(executable=sys.executable))
    config = read_config(path)
    parent = {"HOME": "/wrong", "CODEX_HOME": "/wrong", "HTTPS_PROXY": "http://wrong", "PATH": "/bin"}
    clean = build_environment(path, config, parent=parent)
    assert clean["CODEX_HOME"] == str(path / "codex")
    assert "HTTPS_PROXY" not in clean
    inherited = build_environment(path, config, mode="inherit", parent=parent)
    assert inherited["HOME"] == str(path / "home")
    assert inherited["HTTPS_PROXY"] == "http://wrong"
    with pytest.raises(ProfileError, match="conflicts"):
        build_environment(path, config, {"HOME": "/wrong"})
    assert build_environment(path, config, {"HTTPS_PROXY": "http://chosen"})["HTTPS_PROXY"] == "http://chosen"


async def test_api_key_setup_preserves_native_fields_and_references_environment(tmp_path):
    path = tmp_path / "profile"
    await create_profile(path, ProfileSpec(executable=sys.executable))
    with (path / "codex/config.toml").open("a") as stream:
        stream.write('\n[future]\nunknown = "keep"\n')
    await configure_api_key(path, "MY_DUMMY_KEY", "https://api.example.invalid/v1")
    native = tomllib.loads((path / "codex/config.toml").read_text())
    assert native["future"]["unknown"] == "keep"
    assert native["model_providers"]["pdum_api"]["env_key"] == "MY_DUMMY_KEY"
    with pytest.raises(ProfileError, match="MY_DUMMY_KEY"):
        build_environment(path.resolve(), read_config(path), parent={})
    environment = build_environment(path.resolve(), read_config(path), parent={"MY_DUMMY_KEY": "dummy"})
    assert environment["MY_DUMMY_KEY"] == "dummy"


async def test_temporary_auth_is_snapshot_and_cleanup_is_automatic(tmp_path, monkeypatch):
    original = tmp_path / "normal-codex"
    original.mkdir()
    auth = original / "auth.json"
    auth.write_text(json.dumps({"dummy": "original"}))
    monkeypatch.setenv("CODEX_HOME", str(original))
    async with temporary_profile(ProfileSpec(executable=sys.executable)) as info:
        created = info.directory
        assert info.auth_file_present
        (created / "codex/auth.json").write_text('{"dummy":"destination-only"}')
        assert json.loads(auth.read_text())["dummy"] == "original"
        assert info.warnings
    assert not created.exists()
    async with temporary_profile(ProfileSpec(executable=sys.executable), clean=True) as info:
        assert not info.auth_file_present


async def test_listing_preserves_malformed_profile_errors(tmp_path):
    await create_profile(tmp_path / "good", ProfileSpec(executable=sys.executable))
    malformed = tmp_path / "bad"
    malformed.mkdir()
    (malformed / "launcher.toml").write_text("invalid TOML [")
    results = await list_profiles(tmp_path)
    assert results[0].error
    assert results[1].error is None


async def test_symlink_cycle_fails_without_publishing_or_mutating_source(tmp_path):
    source = tmp_path / "source"
    await create_profile(source, ProfileSpec(executable=sys.executable))
    (source / "codex/skills").mkdir()
    (source / "codex/skills/cycle").symlink_to(source / "codex/skills", target_is_directory=True)
    with pytest.raises(ProfileError, match="Cyclic"):
        await create_profile(tmp_path / "target", ProfileSpec(source=source))
    assert not (tmp_path / "target").exists()
    assert os.path.islink(source / "codex/skills/cycle")

import json
from pathlib import Path

import pytest
from pdum.claude_launcher.authentication import AuthSpec
from pdum.claude_launcher.errors import ProfileError
from pdum.claude_launcher.profiles import (
    create_profile,
    list_profiles,
    load_profile,
    resolve_profile,
    temporary_profile,
)


def test_profile_preserves_unknown_native_settings_without_source_writes(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    original = b'{ "future": {"unknown": [1, "two"]}, "model": "native-choice" }\n'
    source = tmp_path / "source-settings.json"
    source.write_bytes(original)
    profile = create_profile(tmp_path / "profiles" / "one", workspace=workspace, native_settings=source)
    assert (profile.config_directory / "settings.json").read_bytes() == original
    assert source.read_bytes() == original
    (profile.config_directory / "settings.json").write_text('{"newNativeSetting": true}\n')
    assert load_profile(profile.directory) == profile
    assert source.read_bytes() == original
    assert list_profiles(tmp_path / "profiles") == (profile,)
    assert list_profiles(tmp_path / "missing") == ()
    assert not (profile.directory / "profile.lock").exists()


def test_profile_metadata_has_auth_references_and_supports_shared_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("SELECTED_KEY", "synthetic-value-not-to-save")
    profile_a = create_profile(
        tmp_path / "a", workspace=tmp_path, auth=AuthSpec("api-key", "SELECTED_KEY"), setting_sources=()
    )
    profile_b = create_profile(
        tmp_path / "b", workspace=tmp_path, auth=AuthSpec("reuse-login", source_directory=tmp_path)
    )
    assert profile_a.workspace == profile_b.workspace
    assert profile_a.config_directory != profile_b.config_directory
    assert load_profile(profile_a.directory) == profile_a
    assert load_profile(profile_b.directory) == profile_b
    assert "synthetic-value-not-to-save" not in (profile_a.directory / "profile.json").read_text()
    assert "synthetic-value-not-to-save" not in repr(profile_a)
    assert json.loads((profile_a.config_directory / "settings.json").read_text())["sandbox"] == {"enabled": False}


def test_existing_path_and_config_symlink_are_rejected_without_mutation(tmp_path):
    existing = tmp_path / "existing"
    existing.mkdir()
    sentinel = existing / "keep"
    sentinel.write_text("unchanged")
    with pytest.raises(ProfileError, match="already exists"):
        create_profile(existing, workspace=tmp_path)
    assert sentinel.read_text() == "unchanged"
    profile = create_profile(tmp_path / "profile", workspace=tmp_path)
    profile.config_directory.rename(profile.directory / "saved-claude")
    profile.config_directory.symlink_to(existing, target_is_directory=True)
    with pytest.raises(ProfileError, match="ordinary directory"):
        load_profile(profile.directory)
    assert sentinel.read_text() == "unchanged"


def test_explicit_executable_paths_are_fixed_when_saved_without_requiring_installation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    profile = create_profile(tmp_path / "profile", workspace=tmp_path, executable="./bin/claude")
    assert profile.executable == str(tmp_path / "bin/claude")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    assert load_profile(profile.directory).executable == str(tmp_path / "bin/claude")
    bare = create_profile(tmp_path / "bare", workspace=tmp_path, executable="claude")
    assert bare.executable == "claude"
    monkeypatch.setenv("HOME", str(tmp_path))
    expanded = create_profile(tmp_path / "expanded", workspace=tmp_path, executable="~/bin/claude")
    assert expanded.executable == str(tmp_path / "bin/claude")


@pytest.mark.parametrize(
    "field,value", [("workspace", "relative"), ("schema_version", True), ("setting_sources", "user")]
)
def test_malformed_metadata_cannot_redirect_profile(tmp_path, field, value):
    profile = create_profile(tmp_path / "profile", workspace=tmp_path)
    path = profile.directory / "profile.json"
    content = json.loads(path.read_text())
    content[field] = value
    path.write_text(json.dumps(content))
    with pytest.raises(ProfileError, match="malformed"):
        load_profile(profile.directory)


def test_temporary_profile_removes_only_owned_state(tmp_path):
    sentinel = tmp_path / "keep"
    sentinel.write_text("workspace")
    with temporary_profile(workspace=tmp_path) as profile:
        assert profile.directory.is_dir()
        assert profile.workspace == tmp_path
    assert not profile.directory.exists()
    assert sentinel.read_text() == "workspace"


def test_selection_and_invalid_auth_are_rejected_before_creation(tmp_path):
    assert resolve_profile("one", root=tmp_path) == tmp_path / "one"
    assert resolve_profile(directory=tmp_path) == tmp_path
    for name in ("..", "../bad", "", "a/b"):
        with pytest.raises(ProfileError):
            resolve_profile(name, root=tmp_path)
    with pytest.raises(ProfileError):
        resolve_profile("one", directory=tmp_path)
    with pytest.raises(ProfileError):
        AuthSpec("unsupported")
    with pytest.raises(ProfileError):
        AuthSpec("api-key", "not a reference")
    with pytest.raises(ProfileError):
        AuthSpec("native", source_directory=Path("source"))
    with pytest.raises(ProfileError):
        create_profile(tmp_path / "invalid", workspace=tmp_path, setting_sources=("user", "user"))
    assert not (tmp_path / "invalid").exists()

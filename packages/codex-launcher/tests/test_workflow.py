import asyncio
import sys
import threading
import tomllib
from dataclasses import replace
from pathlib import Path

import pytest
from pdum.codex_launcher import (
    AuthSpec,
    FederationSpec,
    ImportSelection,
    ProfileBusy,
    ProfileEdit,
    ProfileError,
    load_profile_draft,
    prepare_edit,
    remaining_config,
    save_profile_edit,
    workflow,
)
from pdum.codex_launcher.runtime import profile_lease


async def test_create_filters_and_edits_remainder_without_source_changes(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    original = """# Future native key remains
future_setting = "kept"
model = "old"
[mcp_servers.keep]
command = "one"
[mcp_servers.skip]
command = "two"
"""
    (source / "config.toml").write_text(original)
    (source / "auth.json").write_text('{"example":"snapshot, not a real credential"}')
    draft = await load_profile_draft(tmp_path / "profile", source=source)
    edit = ProfileEdit(
        executable=Path(sys.executable),
        model="gpt-6-luna",
        selection=ImportSelection(mcp_servers=("keep",)),
        copy_auth=True,
    )
    prepared = prepare_edit(draft, edit)
    remainder = remaining_config(prepared)
    assert "mcp_servers" not in remainder
    assert "model" not in remainder
    assert "# Future native key remains" in remainder
    assert not draft.directory.exists()
    prepared = prepare_edit(draft, replace(edit, remaining_toml=remainder.replace('"kept"', '"edited"')))
    info = await save_profile_edit(prepared)
    result = tomllib.loads((info.directory / "codex/config.toml").read_text())
    assert result["future_setting"] == "edited"
    assert result["model"] == "gpt-6-luna"
    assert set(result["mcp_servers"]) == {"keep"}
    assert info.auth_file_present
    assert (source / "config.toml").read_text() == original


async def test_remainder_cannot_restore_excluded_settings(tmp_path):
    draft = await load_profile_draft(tmp_path / "profile", clean=True)
    edit = ProfileEdit(executable=Path(sys.executable), selection=ImportSelection(mcp_servers="none"))
    for content in ('[mcp_servers.sneaky]\ncommand="whoops"', "[skills]\nconfig=[]", 'plugins="wrong"'):
        with pytest.raises(ProfileError, match="already represented"):
            prepare_edit(draft, replace(edit, remaining_toml=content))
    with pytest.raises(ProfileError, match="invalid"):
        prepare_edit(draft, replace(edit, remaining_toml="broken ["))
    assert not draft.directory.exists()


async def _clean_profile(tmp_path):
    draft = await load_profile_draft(tmp_path / "profile", clean=True)
    await save_profile_edit(prepare_edit(draft, ProfileEdit(executable=Path(sys.executable))))
    return draft.directory


async def test_configure_starts_from_current_profile_and_retains_sessions_auth(tmp_path, monkeypatch):
    directory = await _clean_profile(tmp_path)
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "do-not-read"))
    (directory / "codex/auth.json").write_text("snapshot")
    (directory / "codex/sessions").mkdir()
    (directory / "codex/sessions/session.jsonl").write_text("retained")
    skill = directory / "codex/skills/example"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: example\ndescription: test\n---\nA skill")
    draft = await load_profile_draft(directory, existing=True)
    assert len(draft.inventory.skills) == 1
    await save_profile_edit(prepare_edit(draft, ProfileEdit(selection=ImportSelection(skills="none"))))
    assert not skill.exists()
    assert (directory / "codex/auth.json").read_text() == "snapshot"
    assert (directory / "codex/sessions/session.jsonl").read_text() == "retained"


async def test_existing_busy_conflict_and_write_failure_leave_settings_intact(tmp_path, monkeypatch):
    directory = await _clean_profile(tmp_path)
    draft = await load_profile_draft(directory, existing=True)
    prepared = prepare_edit(draft, ProfileEdit(model="new", import_assets=False))
    async with profile_lease(directory):
        with pytest.raises(ProfileBusy):
            await save_profile_edit(prepared)
    native = directory / "codex/config.toml"
    native.write_text(draft.native_toml + '\nchanged="outside"\n')
    with pytest.raises(ProfileError, match="changed since"):
        await save_profile_edit(prepared)
    native.write_text(draft.native_toml)
    rename = Path.rename

    def fail_metadata(source, target):
        if source.name == "launcher.toml" and ".editing-" in str(source) and ".previous" not in str(source):
            raise OSError("injected publication failure")
        return rename(source, target)

    monkeypatch.setattr(Path, "rename", fail_metadata)
    with pytest.raises(OSError, match="publication failure"):
        await save_profile_edit(prepared)
    assert native.read_text() == draft.native_toml
    assert (directory / "launcher.toml").read_text() == draft.launcher_toml
    assert not list(directory.parent.glob(".profile.editing-*"))


async def test_cancellation_keeps_lease_until_writer_finishes(tmp_path, monkeypatch):
    directory = await _clean_profile(tmp_path)
    draft = await load_profile_draft(directory, existing=True)
    prepared = prepare_edit(draft, ProfileEdit(model="new", import_assets=False))
    entered = threading.Event()
    finish = threading.Event()
    actual = workflow._save

    def slow_save(value):
        entered.set()
        assert finish.wait(5)
        return actual(value)

    monkeypatch.setattr(workflow, "_save", slow_save)
    saving = asyncio.create_task(save_profile_edit(prepared))
    assert await asyncio.to_thread(entered.wait, 5)
    saving.cancel()
    await asyncio.sleep(0)
    try:
        with pytest.raises(ProfileBusy):
            async with profile_lease(directory):
                raise AssertionError("Lease released before writer finished")
    finally:
        finish.set()
    with pytest.raises(asyncio.CancelledError):
        await saving
    assert tomllib.loads((directory / "codex/config.toml").read_text())["model"] == "new"


async def test_clone_rebases_owned_federation_helper(tmp_path):
    source = await _clean_profile(tmp_path)
    draft = await load_profile_draft(source, existing=True)
    auth = AuthSpec("aws-federation", federation=FederationSpec("us-east-1", "idp-example", "sa-example"))
    await save_profile_edit(prepare_edit(draft, ProfileEdit(auth=auth, import_assets=False)))
    destination = tmp_path / "clone"
    draft = await load_profile_draft(destination, source=source)
    prepared = prepare_edit(draft)
    native = tomllib.loads(prepared.native_toml)
    helper = native["model_providers"][native["model_provider"]]["auth"]
    assert str(destination) in helper["args"]
    assert str(source) not in helper["args"]
    await save_profile_edit(prepared)


async def test_auth_switch_clears_only_owned_environment_and_active_profile(tmp_path):
    directory = await _clean_profile(tmp_path)
    draft = await load_profile_draft(directory, existing=True)
    await save_profile_edit(
        prepare_edit(draft, ProfileEdit(auth=AuthSpec("api-key", "EXAMPLE_KEY"), import_assets=False))
    )
    native = directory / "codex/config.toml"
    native.write_text('profile="old"\n' + native.read_text() + '\n[profiles.old]\nmodel="old"\n')
    draft = await load_profile_draft(directory, existing=True)
    prepared = prepare_edit(draft, ProfileEdit(auth=AuthSpec("chatgpt"), model="new", import_assets=False))
    assert "profile" not in tomllib.loads(prepared.native_toml)
    assert "old" in tomllib.loads(prepared.native_toml)["profiles"]
    assert "EXAMPLE_KEY" not in tomllib.loads(prepared.launcher_toml)["environment"]["inherit_keys"]
    await save_profile_edit(prepared)


async def test_selected_asset_cannot_contain_staging_directory(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "config.toml").write_text('[marketplaces.local]\nsource_type="local"\n' + f'source="{source}"\n')
    destination = source / "profile"
    draft = await load_profile_draft(destination, source=source)
    prepared = prepare_edit(draft, ProfileEdit(executable=Path(sys.executable)))
    with pytest.raises(ProfileError, match="inside a selected source asset"):
        await save_profile_edit(prepared)
    assert not destination.exists()
    assert not list(source.glob(".profile.editing-*"))


async def test_redirected_native_parent_does_not_mutate_external_tree(tmp_path):
    directory = await _clean_profile(tmp_path)
    external = tmp_path / "external-codex"
    (directory / "codex").rename(external)
    (directory / "codex").symlink_to(external, target_is_directory=True)
    draft = await load_profile_draft(directory, existing=True)
    prepared = prepare_edit(draft, ProfileEdit(model="new", import_assets=False))
    with pytest.raises(ProfileError, match="redirects writes"):
        await save_profile_edit(prepared)
    assert (external / "config.toml").read_text() == draft.native_toml


async def test_explicit_relative_executable_uses_caller_directory(tmp_path, monkeypatch):
    executable = tmp_path / "tools/codex"
    executable.parent.mkdir()
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o700)
    monkeypatch.chdir(tmp_path)
    draft = await load_profile_draft(tmp_path / "profile", clean=True)
    prepared = prepare_edit(draft, ProfileEdit(executable=Path("tools/codex")))
    assert tomllib.loads(prepared.launcher_toml)["executable"]["path"] == str(executable)

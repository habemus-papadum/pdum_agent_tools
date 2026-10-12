"""Independent regression checks for profile edit failure recovery."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from pdum.codex_launcher import ProfileSpec, create_profile
from pdum.codex_launcher.authentication import AuthSpec
from pdum.codex_launcher.errors import ProfileError
from pdum.codex_launcher.imports import ImportSelection
from pdum.codex_launcher.workflow import ProfileEdit, load_profile_draft, prepare_edit, save_profile_edit


async def existing_profile(tmp_path: Path) -> Path:
    directory = tmp_path / "profile"
    await create_profile(directory, ProfileSpec(executable=sys.executable, model="original-model"))
    skill = directory / "codex/skills/local/SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: local\ndescription: Local test skill\n---\nOriginal content.\n")
    (directory / "codex/auth.json").write_text('{"local_fixture": "unchanged"}')
    (directory / "codex/sessions").mkdir()
    (directory / "codex/sessions/keep.jsonl").write_text("preserved history\n")
    return directory


async def test_partial_publication_restores_assets_and_settings(tmp_path: Path, monkeypatch):
    directory = await existing_profile(tmp_path)
    originals = {
        relative: (directory / relative).read_bytes()
        for relative in (
            "launcher.toml",
            "codex/config.toml",
            "codex/auth.json",
            "codex/skills/local/SKILL.md",
            "codex/sessions/keep.jsonl",
        )
    }
    draft = await load_profile_draft(directory, existing=True)
    prepared = prepare_edit(draft, ProfileEdit(model="replacement-model", selection=ImportSelection(skills="none")))
    original_rename = Path.rename
    injected = []

    def rename(path: Path, target: Path):
        if path.name == "config.toml" and ".editing-" in str(path) and ".previous" not in path.parts and not injected:
            injected.append(path)
            raise OSError("injected replacement publication failure")
        return original_rename(path, target)

    monkeypatch.setattr(Path, "rename", rename)
    with pytest.raises(OSError, match="injected replacement"):
        await save_profile_edit(prepared)
    assert injected
    for relative, content in originals.items():
        assert (directory / relative).read_bytes() == content
    assert not list(tmp_path.glob(".profile.editing-*"))
    assert (directory / "runtime/lease.lock").exists()


async def test_model_only_auth_edit_preserves_asset_identity_and_history(tmp_path: Path):
    directory = await existing_profile(tmp_path)
    paths = [
        directory / relative
        for relative in ("codex/auth.json", "codex/skills/local/SKILL.md", "codex/sessions/keep.jsonl")
    ]
    originals = [(path.read_bytes(), path.stat().st_ino) for path in paths]
    draft = await load_profile_draft(directory, existing=True)
    prepared = prepare_edit(draft, ProfileEdit(model="replacement-model", import_assets=False))
    await save_profile_edit(prepared)
    for path, (content, inode) in zip(paths, originals, strict=True):
        assert path.read_bytes() == content
        assert path.stat().st_ino == inode


async def test_failed_rollback_retains_originals_for_recovery(tmp_path: Path, monkeypatch):
    directory = await existing_profile(tmp_path)
    original_config = (directory / "codex/config.toml").read_bytes()
    draft = await load_profile_draft(directory, existing=True)
    prepared = prepare_edit(draft, ProfileEdit(model="replacement-model", import_assets=False))
    original_rename = Path.rename

    def rename(path: Path, target: Path):
        if path.name == "config.toml" and ".editing-" in str(path):
            if ".previous" in path.parts:
                raise OSError("injected rollback failure")
            raise OSError("injected publication failure")
        return original_rename(path, target)

    monkeypatch.setattr(Path, "rename", rename)
    with pytest.raises(ProfileError, match="originals retained"):
        await save_profile_edit(prepared)
    recovery = list(tmp_path.glob(".profile.editing-*/.previous/codex/config.toml"))
    assert len(recovery) == 1
    assert recovery[0].read_bytes() == original_config


async def test_remainder_cannot_override_selected_chatgpt_provider(tmp_path: Path):
    directory = await existing_profile(tmp_path)
    draft = await load_profile_draft(directory, existing=True)
    edited = '[model_providers.openai]\nname="wrong provider"\nenv_key="OTHER_KEY"\nrequires_openai_auth=false\n'
    with pytest.raises(ProfileError):
        prepare_edit(draft, ProfileEdit(auth=AuthSpec("chatgpt"), remaining_toml=edited))


async def test_remainder_cannot_replace_reserved_parent_with_scalar(tmp_path: Path):
    directory = await existing_profile(tmp_path)
    draft = await load_profile_draft(directory, existing=True)
    with pytest.raises(ProfileError):
        prepare_edit(draft, ProfileEdit(remaining_toml='skills="not a settings table"\n'))

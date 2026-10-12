from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest
from pdum.codex_launcher.authentication import AuthSpec
from pdum.codex_launcher.imports import ImportSelection
from pdum.codex_launcher.interview import interview
from pdum.codex_launcher.workflow import ProfileEdit, load_profile_draft, prepare_edit

interview_module = importlib.import_module("pdum.codex_launcher.interview")


class Answers:
    def __init__(self, responses: dict[str, list | object]):
        self.responses = {
            message: list(value) if isinstance(value, list) else [value] for message, value in responses.items()
        }
        self.calls: list[tuple[str, dict]] = []

    def question(self, message: str, **options):
        self.calls.append((message, options))
        answers = self.responses.get(message)
        if answers:
            answer = answers.pop(0)
        elif "default" in options:
            answer = options["default"]
        else:
            raise AssertionError(f"Unexpected UI prompt: {message}")

        class Question:
            async def ask_async(self):
                return answer

        return Question()

    def install(self, monkeypatch: pytest.MonkeyPatch):
        for function in ("text", "select", "checkbox", "confirm"):
            monkeypatch.setattr(interview_module.questionary, function, self.question)


def source_profile(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    source.mkdir()
    (source / "launcher.toml").write_text(f"schema_version=1\n[executable]\npath={json.dumps(sys.executable)}\n")
    (source / "codex").mkdir()
    (source / "codex/config.toml").write_text(
        'model="gpt-6-luna"\nunknown_setting="preserve me"\n'
        '[mcp_servers.one]\ncommand="one"\n[mcp_servers.two]\ncommand="two"\n'
    )
    return source


async def test_interview_selects_entries_previews_and_returns_without_writing(tmp_path: Path, monkeypatch):
    source = source_profile(tmp_path)
    before = (source / "codex/config.toml").read_bytes()
    answers = Answers(
        {
            "Import MCP servers (2 available)?": "individual",
            "Select MCP servers (Space toggles, Enter accepts)": [("one",)],
            "Authentication method": "chatgpt",
            "Run the selected login flow after saving?": True,
            "Remaining configuration": "accept",
            "Save this profile configuration?": True,
        }
    )
    answers.install(monkeypatch)
    draft = await load_profile_draft(tmp_path / "new-profile", source=source)
    edit = await interview(draft)
    assert edit is not None
    assert edit.selection.mcp_servers == ("one",)
    assert edit.auth.method == "chatgpt"
    assert edit.login_after
    assert not draft.directory.exists()
    assert (source / "codex/config.toml").read_bytes() == before
    assert "unknown_setting" in prepare_edit(draft, edit).native_toml


async def test_cancelled_question_or_save_leaves_profile_untouched(tmp_path: Path, monkeypatch):
    source = source_profile(tmp_path)
    draft = await load_profile_draft(tmp_path / "out", source=source)
    Answers({"Import MCP servers (2 available)?": None}).install(monkeypatch)
    assert await interview(draft) is None
    Answers({"Remaining configuration": "accept", "Save this profile configuration?": False}).install(monkeypatch)
    assert await interview(draft) is None
    assert not draft.directory.exists()


async def test_remainder_editor_retries_invalid_or_reintroduced_keys(tmp_path: Path, monkeypatch, capsys):
    source = source_profile(tmp_path)
    draft = await load_profile_draft(tmp_path / "out", source=source)
    answers = Answers({"Remaining configuration": ["edit", "accept", "edit", "accept"]})
    answers.install(monkeypatch)
    edited = iter(['[mcp_servers.excluded]\ncommand="wrong"\n', 'unknown_setting="edited"\n'])
    monkeypatch.setattr(interview_module.click, "edit", lambda *args, **kwargs: next(edited))
    edit = await interview(draft)
    assert edit is not None
    assert edit.remaining_toml == 'unknown_setting="edited"\n'
    assert "Cannot accept that TOML" in capsys.readouterr().out
    assert not draft.directory.exists()


async def test_pager_and_editor_cancel_keep_remainder_and_source(tmp_path: Path, monkeypatch):
    source = source_profile(tmp_path)
    draft = await load_profile_draft(tmp_path / "out", source=source)
    Answers({"Remaining configuration": ["pager", "edit", "accept"]}).install(monkeypatch)
    pages = []
    monkeypatch.setattr(interview_module, "_page", lambda console, content, language: pages.append((content, language)))
    monkeypatch.setattr(interview_module.click, "edit", lambda *args, **kwargs: None)
    edit = await interview(draft)
    assert edit is not None
    assert edit.remaining_toml is None
    assert len(pages) == 1
    assert "unknown_setting" in pages[0][0]
    assert "mcp_servers" not in pages[0][0]


async def test_auth_only_uses_initial_flags_and_never_reimports_assets(tmp_path: Path, monkeypatch):
    source = source_profile(tmp_path)
    draft = await load_profile_draft(source, existing=True)
    answers = Answers({})
    answers.install(monkeypatch)
    initial = ProfileEdit(auth=AuthSpec("api-key", api_key_env="CUSTOM_KEY"))
    edit = await interview(draft, auth_only=True, initial=initial)
    assert edit is not None
    assert edit.auth.method == "api-key"
    assert edit.auth.api_key_env == "CUSTOM_KEY"
    assert not edit.import_assets
    assert not any(
        message.startswith("Import ") or message == "Remaining configuration" for message, _ in answers.calls
    )
    assert (source / "codex/config.toml").read_text() == draft.native_toml


async def test_initial_model_executable_and_import_choices_seed_prompts(tmp_path: Path, monkeypatch):
    source = source_profile(tmp_path)
    draft = await load_profile_draft(tmp_path / "out", source=source)
    answers = Answers({"Remaining configuration": "accept"})
    answers.install(monkeypatch)
    edit = await interview(
        draft,
        initial=ProfileEdit(
            model="gpt-6-sol", executable=Path("/bin/sh"), selection=ImportSelection(mcp_servers="none")
        ),
    )
    assert edit is not None
    assert edit.model == "gpt-6-sol"
    assert edit.executable == Path("/bin/sh")
    assert edit.selection.mcp_servers == "none"


async def test_federation_interview_collects_only_configuration(tmp_path: Path, monkeypatch):
    source = source_profile(tmp_path)
    draft = await load_profile_draft(tmp_path / "out", source=source)
    answers = Answers(
        {
            "Authentication method": "aws-federation",
            "AWS profile (blank uses the native credential chain)": "work",
            "OpenAI identity-provider ID": "test-provider",
            "OpenAI service-account ID": "test-service-account",
            "Run the selected login flow after saving?": True,
            "Remaining configuration": "accept",
        }
    )
    answers.install(monkeypatch)
    edit = await interview(draft)
    assert edit is not None
    assert edit.auth.federation is not None
    assert edit.auth.federation.aws_profile == "work"
    assert edit.auth.federation.identity_provider_id == "test-provider"
    assert edit.login_after
    assert not draft.directory.exists()


async def test_auth_snapshot_offer_is_explicit_and_never_prints_credentials(tmp_path: Path, monkeypatch, capsys):
    source = source_profile(tmp_path)
    (source / "codex/auth.json").write_text('{"token":"DO-NOT-PRINT-THIS"}')
    draft = await load_profile_draft(tmp_path / "out", source=source)
    Answers({"Copy the source auth.json snapshot?": True, "Remaining configuration": "accept"}).install(monkeypatch)
    edit = await interview(draft)
    assert edit is not None and edit.copy_auth
    assert "DO-NOT-PRINT-THIS" not in capsys.readouterr().out
    assert not draft.directory.exists()


async def test_empty_category_preserves_explicit_none():
    from pdum.codex_launcher.interview import _category

    assert await _category("plugins", (), "none") == "none"

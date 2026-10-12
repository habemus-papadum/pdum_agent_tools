from __future__ import annotations

import json
import os
import tomllib
from pathlib import Path

import pytest
from pdum.codex_launcher.errors import ProfileError
from pdum.codex_launcher.imports import (
    ImportPlan,
    ImportSelection,
    apply_import_assets,
    build_import_plan,
    empty_inventory,
    inventory_source,
)


def write(path: Path, content: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def skill(root: Path, name: str) -> Path:
    return write(root / "SKILL.md", f"---\nname: {name}\ndescription: Import test.\n---\nContent.\n").parent


def test_selective_import_preserves_comments_unknowns_and_plugin_dependencies(tmp_path: Path):
    source = tmp_path / "source"
    market = tmp_path / "external-market"
    write(market / ".claude-plugin/marketplace.json", json.dumps({"name": "sample", "plugins": []}))
    write(source / "plugins/cache/sample/one/1.0.0/.claude-plugin/plugin.json", '{"name":"one"}')
    write(source / "plugins/cache/sample/two/local/.claude-plugin/plugin.json", '{"name":"two"}')
    native = f"""# original comment
model = "gpt-6-luna"
future = "retain me"

[marketplaces.sample]
source_type = "local"
source = {json.dumps(str(market))}
future_market_field = "preserve"

[plugins._default]
enabled = true
future_plugin_default = "preserve"

[plugins."one@sample"]
enabled = true
future_plugin_field = "preserve"

[plugins."two@sample"]
enabled = true

[mcp_servers.keep]
command = "something"
unknown_parameter = "preserve"

[mcp_servers.drop]
command = "do-not-import"

[skills]
include_instructions = false
future_skills_field = "preserve"
"""
    write(source / "config.toml", native)
    inventory = inventory_source(source)
    destination = tmp_path / "destination"
    plan = build_import_plan(
        inventory,
        ImportSelection(marketplaces="none", plugins=("one@sample",), mcp_servers=("keep",), skills="none"),
        destination,
    )
    document = tomllib.loads(plan.native_toml)
    assert "# original comment" in plan.native_toml
    assert document["future"] == "retain me"
    assert document["plugins"]["_default"] == {"enabled": False, "future_plugin_default": "preserve"}
    assert set(document["plugins"]) == {"_default", "one@sample"}
    assert document["plugins"]["one@sample"]["future_plugin_field"] == "preserve"
    assert document["marketplaces"]["sample"]["source"] == str(destination / "codex/.tmp/marketplaces/sample")
    assert document["marketplaces"]["sample"]["future_market_field"] == "preserve"
    assert set(document["mcp_servers"]) == {"keep"}
    assert document["skills"]["future_skills_field"] == "preserve"
    assert any("required by selected plugin" in warning for warning in plan.warnings)
    apply_import_assets(plan, destination)
    assert (destination / "codex/plugins/cache/sample/one/1.0.0/.claude-plugin/plugin.json").is_file()
    assert not (destination / "codex/plugins/cache/sample/two").exists()
    assert (source / "config.toml").read_text() == native


def test_marketplaces_do_not_implicitly_import_or_enable_plugins(tmp_path: Path):
    source = tmp_path / "source"
    write(source / "config.toml", '[marketplaces.sample]\nsource_type="git"\nsource="https://example.invalid/repo"\n')
    write(source / ".tmp/marketplaces/sample/.claude-plugin/marketplace.json", '{"plugins":[]}')
    write(source / "plugins/cache/sample/extra/local/.claude-plugin/plugin.json", '{"name":"extra"}')
    plan = build_import_plan(inventory_source(source), ImportSelection(plugins="none"), tmp_path / "destination")
    assert tomllib.loads(plan.native_toml)["plugins"] == {"_default": {"enabled": False}}
    assert all("plugins/cache" not in destination.as_posix() for _, destination in plan.assets)
    assert len(plan.assets) == 1


def test_installed_only_and_missing_plugins_report_limitations(tmp_path: Path):
    source = tmp_path / "source"
    write(source / "config.toml", '[plugins."missing@sample"]\nenabled=true\n')
    write(source / "plugins/cache/other/cached/1.0/.claude-plugin/plugin.json", '{"name":"cached"}')
    inventory = inventory_source(source)
    assert {choice.id for choice in inventory.plugins} == {"missing@sample", "cached@other"}
    plan = build_import_plan(inventory, ImportSelection(), tmp_path / "out")
    assert any("Selected asset is unavailable: missing@sample" in warning for warning in plan.warnings)
    assert any("No configured marketplace metadata for cached@other" in warning for warning in plan.warnings)
    assert "cached@other" in tomllib.loads(plan.native_toml)["plugins"]


def test_skills_include_default_user_skills_and_materialize_symlinks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "home"
    native = home / ".codex"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(native))
    external = skill(tmp_path / "external", "linked-skill")
    executable = write(external / "run.sh", "#!/bin/sh\necho okay\n")
    executable.chmod(0o755)
    (native / "skills").mkdir(parents=True)
    (native / "skills/linked").symlink_to(external, target_is_directory=True)
    skill(home / ".agents/skills/nested/user", "user-skill")
    skill(native / "skills/drop", "drop-skill")
    native_config = f"""# rules comment
[[skills.config]]
path = {json.dumps(str(external / "SKILL.md"))}
enabled = false
future = "retained"

[[skills.config]]
name = "drop-skill"
enabled = false
"""
    write(native / "config.toml", native_config)
    inventory = inventory_source()
    assert {choice.id for choice in inventory.skills} == {"codex:linked", "codex:drop", "user:nested/user"}
    destination = tmp_path / "out"
    plan = build_import_plan(
        inventory,
        ImportSelection(skills=("codex:linked", "user:nested/user")),
        destination,
    )
    apply_import_assets(plan, destination)
    copied = destination / "codex/skills/linked"
    assert not copied.is_symlink()
    assert os.access(copied / "run.sh", os.X_OK)
    assert (destination / "home/.agents/skills/nested/user/SKILL.md").is_file()
    assert not (destination / "codex/skills/drop").exists()
    rules = tomllib.loads(plan.native_toml)["skills"]["config"]
    assert rules == [{"path": str(copied / "SKILL.md"), "enabled": False, "future": "retained"}]
    assert (native / "config.toml").read_text() == native_config
    assert inventory_source(native).skills == inventory.skills


def test_managed_profile_skills_do_not_import_developer_user_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "developer"
    monkeypatch.setenv("HOME", str(home))
    skill(home / ".agents/skills/unrelated", "unrelated")
    profile = tmp_path / "profile"
    write(profile / "launcher.toml", 'schema_version=1\n[executable]\npath="/bin/true"\n')
    skill(profile / "codex/skills/native", "native")
    skill(profile / "home/.agents/skills/managed", "managed")
    inventory = inventory_source(profile)
    assert inventory.is_profile
    assert inventory.launcher_toml is not None
    assert {choice.id for choice in inventory.skills} == {"codex:native", "user:managed"}
    assert inventory.auth_file is None


def test_inline_skill_config_and_external_configured_skill(tmp_path: Path):
    source = tmp_path / "source"
    configured = skill(tmp_path / "outside", "outside")
    write(
        source / "config.toml",
        f"[skills]\nconfig = [{{path={json.dumps(str(configured))}, enabled=false}}, "
        '{name="builtin", enabled=false}]\n',
    )
    inventory = inventory_source(source)
    plan = build_import_plan(inventory, ImportSelection(skills=("config:0",)), tmp_path / "out")
    rules = tomllib.loads(plan.native_toml)["skills"]["config"]
    assert len(rules) == 1
    assert rules[0]["path"] == str(tmp_path / "out/codex/skills/imported/0-outside")


def test_unknown_selection_bad_toml_and_unsupported_shape_fail_explicitly(tmp_path: Path):
    source = tmp_path / "source"
    write(source / "config.toml", "[plugins]\n")
    with pytest.raises(ProfileError, match="Unknown plugins"):
        build_import_plan(inventory_source(source), ImportSelection(plugins=("unknown",)), tmp_path / "out")
    write(source / "config.toml", "[plugins")
    with pytest.raises(ProfileError, match="invalid native TOML"):
        inventory_source(source)
    write(source / "config.toml", "plugins = 3")
    with pytest.raises(ProfileError, match="expected a table"):
        inventory_source(source)


def test_asset_copy_refuses_collisions_escapes_and_cycles(tmp_path: Path):
    source = write(tmp_path / "source/file", "content")
    out = tmp_path / "out"
    write(out / "codex/file", "existing")
    with pytest.raises(ProfileError, match="already exists"):
        apply_import_assets(ImportPlan("", ((source, Path("codex/file")),), ()), out)
    with pytest.raises(ProfileError, match="Invalid import destination"):
        apply_import_assets(ImportPlan("", ((source, Path("../escape")),), ()), out)
    external = tmp_path / "external"
    external.mkdir()
    (out / "symlink").symlink_to(external, target_is_directory=True)
    with pytest.raises(ProfileError, match="leaves staging"):
        apply_import_assets(ImportPlan("", ((source, Path("symlink/file")),), ()), out)
    cyclic = tmp_path / "cyclic"
    cyclic.mkdir()
    (cyclic / "again").symlink_to(cyclic, target_is_directory=True)
    with pytest.raises(ProfileError, match="Cyclic import asset"):
        apply_import_assets(ImportPlan("", ((cyclic, Path("cycle")),), ()), out)


def test_reconfigure_rebases_without_source_mutation_and_replacement_roots_are_explicit(tmp_path: Path):
    profile = tmp_path / "profile"
    write(profile / "launcher.toml", "schema_version=1\n")
    original = skill(profile / "codex/skills/example", "example")
    config = f"[[skills.config]]\npath={json.dumps(str(original / 'SKILL.md'))}\nenabled=false\n"
    write(profile / "codex/config.toml", config)
    plan = build_import_plan(inventory_source(profile), ImportSelection(), profile)
    apply_import_assets(plan, tmp_path / "staging")
    assert (profile / "codex/config.toml").read_text() == config
    assert tomllib.loads(plan.native_toml)["skills"]["config"][0]["path"] == str(original / "SKILL.md")
    assert Path("codex/plugins/cache") in plan.replacement_roots
    assert ("skills", "config") in plan.handled_paths


def test_clean_inventory_has_no_implicit_source(tmp_path: Path):
    plan = build_import_plan(empty_inventory(), ImportSelection(), tmp_path / "profile")
    assert plan.assets == ()
    assert plan.native_toml == ""
    assert inventory_source(tmp_path / "missing").native_toml == ""


def test_multiple_unmatched_skill_rules_remain_selectable(tmp_path: Path):
    source = tmp_path / "source"
    write(
        source / "config.toml",
        '[[skills.config]]\nname="missing-first"\nenabled=false\n'
        '[[skills.config]]\nname="missing-second"\nenabled=false\n',
    )
    inventory = inventory_source(source)
    assert {choice.id for choice in inventory.skills} == {"config:0", "config:1"}
    plan = build_import_plan(inventory, ImportSelection(skills=("config:1",)), tmp_path / "out")
    assert tomllib.loads(plan.native_toml)["skills"]["config"] == [{"name": "missing-second", "enabled": False}]


def test_partial_plugin_import_preserves_explicit_or_inherited_disabled_state(tmp_path: Path):
    source = tmp_path / "source"
    write(
        source / "config.toml",
        '[plugins._default]\nenabled=false\n[plugins."one@sample"]\n[plugins."two@sample"]\nenabled=true\n',
    )
    plan = build_import_plan(
        inventory_source(source), ImportSelection(plugins=("one@sample", "two@sample")), tmp_path / "out"
    )
    plugins = tomllib.loads(plan.native_toml)["plugins"]
    assert plugins["_default"]["enabled"] is False
    assert plugins["one@sample"]["enabled"] is False
    assert plugins["two@sample"]["enabled"] is True

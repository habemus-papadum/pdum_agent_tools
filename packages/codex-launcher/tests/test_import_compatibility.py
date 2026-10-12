"""Selective imports qualified by real native discovery, without model calls."""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
from pathlib import Path

import pytest
from pdum.codex_launcher import LaunchOptions, ProfileSpec, create_profile, launch
from pdum.codex_launcher.imports import ImportSelection, apply_import_assets, build_import_plan, inventory_source
from websockets.asyncio.client import connect

CODEX = shutil.which("codex")


def write_asset(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def tree_digest(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file()
    }


async def request(connection, identifier: int, method: str, params: dict) -> dict:
    await connection.send(json.dumps({"id": identifier, "method": method, "params": params}))
    async with asyncio.timeout(20):
        while True:
            response = json.loads(await connection.recv())
            if response.get("id") == identifier:
                assert "error" not in response, response
                return response["result"]


@pytest.mark.codex
@pytest.mark.skipif(CODEX is None, reason="Native Codex executable is not installed")
@pytest.mark.parametrize("import_plugin", [False, True])
async def test_native_discovers_only_selected_imports(tmp_path: Path, monkeypatch, import_plugin: bool) -> None:
    source = tmp_path / "native"
    market = source / "local-market"
    user_home = tmp_path / "user"
    for name in ("selected", "excluded"):
        manifest = json.dumps({"name": name, "description": f"{name} local test plugin"})
        for plugin_root in (market / name, source / "plugins/cache/review" / name / "local"):
            write_asset(plugin_root / ".codex-plugin/plugin.json", manifest)
            write_asset(
                plugin_root / "skills" / name / "SKILL.md",
                f"---\nname: plugin-{name}\ndescription: Local {name} test skill\n---\nDo nothing.\n",
            )
        write_asset(
            source / "skills" / name / "SKILL.md",
            f"---\nname: native-{name}\ndescription: Local {name} native skill\n---\nDo nothing.\n",
        )
    write_asset(
        user_home / ".agents/skills/selected/SKILL.md",
        "---\nname: user-selected\ndescription: Local user test skill\n---\nDo nothing.\n",
    )
    write_asset(
        market / ".agents/plugins/marketplace.json",
        json.dumps(
            {
                "name": "review",
                "plugins": [
                    {"name": name, "source": {"source": "local", "path": f"./{name}"}}
                    for name in ("selected", "excluded")
                ],
            }
        ),
    )
    write_asset(
        source / "config.toml",
        'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n'
        'cli_auth_credentials_store = "file"\n[features]\nplugins = true\n'
        f'[marketplaces.review]\nsource_type = "local"\nsource = {json.dumps(str(market))}\n'
        '[plugins."selected@review"]\nenabled = true\n[plugins."excluded@review"]\nenabled = true\n'
        '[mcp_servers.excluded]\ncommand = "must-not-execute-excluded-mcp"\nenabled = false\n',
    )
    monkeypatch.setenv("HOME", str(user_home))
    monkeypatch.setenv("CODEX_HOME", str(source))
    original = tree_digest(source)
    inventory = inventory_source()
    target = tmp_path / "profile"
    selected = ("selected@review",) if import_plugin else "none"
    plan = build_import_plan(
        inventory,
        ImportSelection(
            marketplaces="all", plugins=selected, mcp_servers="none", skills=("codex:selected", "user:selected")
        ),
        target,
    )
    await create_profile(target, ProfileSpec(executable=CODEX))
    apply_import_assets(plan, target)
    (target / "codex/config.toml").write_text(plan.native_toml)
    async with launch(target, LaunchOptions(host="127.0.0.1")) as server:
        async with connect(server.endpoint, max_size=None, proxy=None) as connection:
            await request(
                connection,
                1,
                "initialize",
                {"clientInfo": {"name": "pdum-import-review", "version": "1"}},
            )
            await connection.send(json.dumps({"method": "initialized"}))
            configuration = await request(connection, 2, "config/read", {"includeLayers": False})
            assert not configuration["config"].get("mcp_servers")
            plugins = await request(connection, 3, "plugin/list", {"marketplaceKinds": ["local"]})
            skills = await request(connection, 4, "skills/list", {"cwds": [str(target / "work")], "forceReload": True})
    skill_names = {skill["name"].split(":")[-1] for entry in skills["data"] for skill in entry["skills"]}
    assert {"native-selected", "user-selected"} <= skill_names
    assert "native-excluded" not in skill_names
    assert "plugin-excluded" not in skill_names
    assert ("plugin-selected" in skill_names) is import_plugin
    marketplace = next(entry for entry in plugins["marketplaces"] if entry["name"] == "review")
    assert {plugin["name"] for plugin in marketplace["plugins"]} == {"selected", "excluded"}
    assert tree_digest(source) == original

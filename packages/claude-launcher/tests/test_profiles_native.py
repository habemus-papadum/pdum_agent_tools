"""Credential-free profile discovery through real Claude processes and the Node SDK.

The local MCP server is a protocol fixture, never a provider-success substitute.
No prompt is submitted and no developer configuration is read or modified.
"""

import asyncio
import json
import shutil
import sys
from dataclasses import replace
from pathlib import Path

import psutil
import pytest
from pdum.claude_launcher.authentication import build_environment
from pdum.claude_launcher.profiles import Profile, create_profile
from pdum.claude_launcher.relay import open_relay
from pdum.claude_launcher.runtime import ClaudeManager, LaunchOptions

EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "claude-client"
pytestmark = [
    pytest.mark.claude,
    pytest.mark.skipif(shutil.which("claude") is None, reason="Native Claude executable is not installed"),
    pytest.mark.skipif(shutil.which("node") is None, reason="Node is not installed"),
    pytest.mark.skipif(
        not (EXAMPLE / "node_modules" / "@anthropic-ai" / "claude-agent-sdk").exists(),
        reason="Run pnpm install --frozen-lockfile in examples/claude-client for the official Node SDK",
    ),
]

NODE_DISCOVERY = """
import { query } from '@anthropic-ai/claude-agent-sdk';
import { remoteProcess } from './node-transport.mjs';
import { InputQueue } from './common.js';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const workers = JSON.parse(raw);
const reports = await Promise.all(workers.map(async worker => {
  const input = new InputQueue();
  const session = query({prompt: input, options: {
    spawnClaudeCodeProcess: () => remoteProcess(worker.url),
  }});
  const types = [];
  let error;
  const completion = (async () => {
    try { for await (const frame of session) types.push(frame.type); }
    catch (value) { error = value; }
  })();
  try {
    const initialization = await session.initializationResult();
    const agents = (await session.supportedAgents()).map(item => item.name).sort();
    const commands = (await session.supportedCommands()).map(item => item.name).sort();
    // The public summary mode uses local estimates, with no token-count API.
    const context = await session.getContextUsage({detail: 'summary'});
    let mcp;
    const deadline = Date.now() + 15000;
    do {
      mcp = await session.mcpServerStatus();
      if (!mcp.some(item => item.status === 'pending')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    await session.interrupt();
    if (error) throw error;
    return {id: worker.id, agents, commands, outputStyle: initialization.output_style,
      tokenSource: initialization.account?.tokenSource ?? 'none',
      memoryFiles: context.memoryFiles.map(item => item.path),
      mcp: mcp.map(item => ({name: item.name, status: item.status})), types};
  } finally {
    session.close();
    input.close();
    await completion;
  }
}));
console.log(JSON.stringify(reports));
"""

MCP_SERVER = """
import json, os, sys
with open(sys.argv[1], 'a') as log:
    log.write(json.dumps({'pid': os.getpid()}) + '\\n')
for line in sys.stdin:
    message = json.loads(line)
    with open(sys.argv[1], 'a') as log:
        log.write(json.dumps({'method': message.get('method')}) + '\\n')
    if 'id' not in message:
        continue
    method = message.get('method')
    if method == 'initialize':
        result = {'protocolVersion': message['params']['protocolVersion'],
                  'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'pdum-isolation-fixture', 'version': '1.0.0'}}
    elif method == 'tools/list':
        result = {'tools': []}
    else:
        result = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}), flush=True)
"""


def write_file(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)


def write_json(path: Path, value: object) -> None:
    write_file(path, json.dumps(value))


def customizations(directory: Path, name: str) -> None:
    write_file(directory / "CLAUDE.md", f"# {name} instructions\nFixture only.\n")
    write_file(directory / "rules" / f"{name}.md", f"# {name} rule\nFixture only.\n")
    write_file(directory / "agents" / f"{name}.md", f"---\nname: {name}\ndescription: {name} agent\n---\nFixture.\n")
    write_file(directory / "commands" / f"{name}.md", f"---\ndescription: {name} command\n---\nFixture.\n")
    write_file(
        directory / "skills" / f"{name}-skill" / "SKILL.md",
        f"---\nname: {name}-skill\ndescription: {name} skill\n---\nFixture.\n",
    )


@pytest.fixture
def isolated_profiles(tmp_path, monkeypatch):
    # The sentinel home is synthetic. Both workers share it, just as production
    # workers share an operator HOME while using distinct CLAUDE_CONFIG_DIRs.
    shared_home = tmp_path / "synthetic-home"
    customizations(shared_home / ".claude", "ordinary-home")
    ordinary_files = {path: path.read_bytes() for path in (shared_home / ".claude").rglob("*") if path.is_file()}
    monkeypatch.setenv("HOME", str(shared_home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(shared_home / ".config"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    profiles = {}
    for label, style in (("a", "Explanatory"), ("b", "Learning")):
        profile = create_profile(tmp_path / label, workspace=workspace, executable=shutil.which("claude"))
        customizations(profile.config_directory, f"user-{label}")
        write_json(profile.config_directory / "settings.json", {"outputStyle": style})
        profiles[label] = profile
    yield profiles
    assert {
        path: path.read_bytes() for path in (shared_home / ".claude").rglob("*") if path.is_file()
    } == ordinary_files


async def native_command(profile: Profile, *arguments: str) -> str:
    process = await asyncio.create_subprocess_exec(
        profile.executable,
        *arguments,
        cwd=profile.workspace,
        env=await build_environment(profile, authenticate=False),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 30)
    finally:
        if process.returncode is None:
            process.kill()
            await process.communicate()
    assert process.returncode == 0, (stdout.decode(), stderr.decode())
    return stdout.decode()


async def discover(profiles: dict[str, Profile]) -> dict[str, dict]:
    observations = []
    async with (
        ClaudeManager(profiles, observer=lambda *item: observations.append(item)) as manager,
        open_relay(manager, host="127.0.0.1") as relay,
    ):
        workers = [
            await manager.allocate(name, options=LaunchOptions(tools=(), max_turns=1, max_budget_usd=0.01))
            for name in profiles
        ]
        process = await asyncio.create_subprocess_exec(
            shutil.which("node"),
            "--input-type=module",
            "-e",
            NODE_DISCOVERY,
            cwd=EXAMPLE,
            env=await build_environment(next(iter(profiles.values())), authenticate=False),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(
                    json.dumps(
                        [{"id": worker.profile_id, "url": relay.worker_url(worker.id)} for worker in workers]
                    ).encode()
                ),
                45,
            )
        finally:
            if process.returncode is None:
                process.kill()
                await process.communicate()
        assert process.returncode == 0, (stdout.decode(), stderr.decode())
        reports = {report["id"]: report for report in json.loads(stdout)}
        async with asyncio.timeout(10):
            while any(worker.state not in {"stopped", "failed"} for worker in workers):
                await asyncio.sleep(0.02)
        assert len({worker.pid for worker in workers}) == len(workers)
        for worker in workers:
            assert worker.pid and not psutil.pid_exists(worker.pid)
            assert worker.state == "stopped"
            assert worker.cleanup_errors == 0
            traffic = b"".join(item[2] for item in observations if item[:2] == (worker.id, "client_to_worker"))
            assert all(json.loads(line)["type"] != "user" for line in traffic.splitlines() if line.strip())
        for report in reports.values():
            assert report["tokenSource"] == "none"
            assert not set(report["types"]) & {"assistant", "result"}
        return reports


def assert_customizations(report: dict, *, present: set[str], absent: set[str]) -> None:
    for name in present:
        assert name in report["agents"], report
        assert {name, f"{name}-skill"} <= set(report["commands"]), report
    for name in absent:
        assert name not in report["agents"], report
        assert not {name, f"{name}-skill"} & set(report["commands"]), report


async def test_native_profiles_isolate_user_customizations_and_select_project_sources(isolated_profiles):
    profiles = isolated_profiles
    workspace = profiles["a"].workspace
    customizations(workspace / ".claude", "project-shared")
    write_json(workspace / ".claude" / "settings.json", {"outputStyle": "Concise"})
    write_json(workspace / ".claude" / "settings.local.json", {"outputStyle": "Learning"})
    write_file(workspace / "CLAUDE.local.md", "# Local instructions\nFixture only.\n")
    reports = await discover(profiles)
    for label in profiles:
        other = "b" if label == "a" else "a"
        assert_customizations(
            reports[label], present={f"user-{label}", "project-shared"}, absent={f"user-{other}", "ordinary-home"}
        )
        assert reports[label]["outputStyle"] == "Concise"
        memory = {Path(path).resolve() for path in reports[label]["memoryFiles"]}
        assert profiles[label].config_directory / "CLAUDE.md" in memory
        assert workspace / ".claude" / "CLAUDE.md" in memory
        assert profiles[other].config_directory / "CLAUDE.md" not in memory
        assert workspace / "CLAUDE.local.md" not in memory
    matrix = await discover(
        {
            "user": replace(profiles["a"], setting_sources=("user",)),
            "project": replace(profiles["a"], setting_sources=("project",)),
            "none": replace(profiles["a"], setting_sources=()),
            "local": replace(profiles["a"], setting_sources=("user", "project", "local")),
        }
    )
    assert_customizations(matrix["user"], present={"user-a"}, absent={"user-b", "project-shared", "ordinary-home"})
    assert_customizations(matrix["project"], present={"project-shared"}, absent={"user-a", "user-b", "ordinary-home"})
    assert_customizations(matrix["none"], present=set(), absent={"user-a", "user-b", "project-shared", "ordinary-home"})
    assert matrix["user"]["outputStyle"] == "Explanatory"
    assert matrix["project"]["outputStyle"] == "Concise"
    assert matrix["none"]["outputStyle"] == "default"
    assert matrix["local"]["outputStyle"] == "Learning"
    user_files = {
        profiles["a"].config_directory / "CLAUDE.md",
        profiles["a"].config_directory / "rules" / "user-a.md",
    }
    project_files = {workspace / ".claude" / "CLAUDE.md", workspace / ".claude" / "rules" / "project-shared.md"}
    assert {Path(path).resolve() for path in matrix["user"]["memoryFiles"]} == user_files
    assert {Path(path).resolve() for path in matrix["project"]["memoryFiles"]} == project_files
    assert matrix["none"]["memoryFiles"] == []
    assert {Path(path).resolve() for path in matrix["local"]["memoryFiles"]} == (
        user_files | project_files | {workspace / "CLAUDE.local.md"}
    )


async def test_native_user_mcp_is_profile_scoped_and_project_mcp_is_shared(isolated_profiles, tmp_path):
    server = tmp_path / "mcp-server.py"
    server.write_text(MCP_SERVER)
    log = tmp_path / "mcp-log.jsonl"
    config = {"command": sys.executable, "args": ["-u", str(server), str(log)]}
    for label, profile in isolated_profiles.items():
        await native_command(profile, "mcp", "add-json", "--scope", "user", f"user-{label}", json.dumps(config))
        write_json(profile.config_directory / "settings.json", {"enableAllProjectMcpServers": True})
    write_json(isolated_profiles["a"].workspace / ".mcp.json", {"mcpServers": {"project-shared": config}})
    reports = await discover(isolated_profiles)
    for label, report in reports.items():
        assert {item["name"] for item in report["mcp"]} == {f"user-{label}", "project-shared"}, report
        assert all(item["status"] == "connected" for item in report["mcp"]), report
    matrix = await discover(
        {
            "user": replace(isolated_profiles["a"], setting_sources=("user",)),
            "project": replace(isolated_profiles["a"], setting_sources=("project",)),
            "none": replace(isolated_profiles["a"], setting_sources=()),
        }
    )
    assert {item["name"] for item in matrix["user"]["mcp"]} == {"user-a"}, matrix
    assert {item["name"] for item in matrix["project"]["mcp"]} == {"project-shared"}, matrix
    assert matrix["none"]["mcp"] == [], matrix
    records = [json.loads(line) for line in log.read_text().splitlines()]
    assert sum(item.get("method") == "initialize" for item in records) == 6
    assert not any(item.get("method") == "tools/call" for item in records)
    for item in records:
        if "pid" in item:
            assert not psutil.pid_exists(item["pid"])


async def test_native_user_plugin_install_is_profile_scoped(isolated_profiles, tmp_path):
    marketplace = tmp_path / "marketplace"
    server = tmp_path / "plugin-mcp-server.py"
    server.write_text(MCP_SERVER)
    log = tmp_path / "plugin-mcp-log.jsonl"
    for label in isolated_profiles:
        plugin = marketplace / "plugins" / f"plugin-{label}"
        write_json(plugin / ".claude-plugin" / "plugin.json", {"name": f"plugin-{label}", "version": "1.0.0"})
        customizations(plugin, "component")
        write_json(
            plugin / ".mcp.json",
            {"mcpServers": {"component": {"command": sys.executable, "args": ["-u", str(server), str(log), label]}}},
        )
    write_json(
        marketplace / ".claude-plugin" / "marketplace.json",
        {
            "name": "pdum-isolation-fixture",
            "owner": {"name": "PDUM test fixture"},
            "plugins": [
                {"name": f"plugin-{label}", "source": f"./plugins/plugin-{label}"} for label in isolated_profiles
            ],
        },
    )
    for label, profile in isolated_profiles.items():
        await native_command(profile, "plugin", "marketplace", "add", str(marketplace))
        await native_command(profile, "plugin", "install", f"plugin-{label}@pdum-isolation-fixture", "--scope", "user")
        listing = json.loads(await native_command(profile, "plugin", "list", "--json"))
        assert {item["id"] for item in listing} == {f"plugin-{label}@pdum-isolation-fixture"}
    reports = await discover(isolated_profiles)
    for label, report in reports.items():
        other = "b" if label == "a" else "a"
        assert f"plugin-{label}:component" in report["agents"], report
        assert {f"plugin-{label}:component", f"plugin-{label}:component-skill"} <= set(report["commands"]), report
        assert f"plugin-{other}:component" not in report["agents"], report
        assert not {f"plugin-{other}:component", f"plugin-{other}:component-skill"} & set(report["commands"]), report
        assert report["mcp"] == [{"name": f"plugin:plugin-{label}:component", "status": "connected"}], report
    disabled = await discover({"a": replace(isolated_profiles["a"], setting_sources=("project",))})
    assert "plugin-a:component" not in disabled["a"]["agents"], disabled
    assert "plugin-a:component-skill" not in disabled["a"]["commands"], disabled
    assert disabled["a"]["mcp"] == [], disabled
    records = [json.loads(line) for line in log.read_text().splitlines()]
    assert sum(item.get("method") == "initialize" for item in records) == 2
    assert not any(item.get("method") == "tools/call" for item in records)
    for item in records:
        if "pid" in item:
            assert not psutil.pid_exists(item["pid"])

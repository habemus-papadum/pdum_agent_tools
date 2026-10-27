"""Real no-inference launch/history/cleanup check in isolated temporary state."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
from pathlib import Path

import psutil
from backend import LiveLab
from websockets.asyncio.client import connect


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pdum-live-backend-check-") as temporary:
        root = Path(temporary)
        auth = root / "source-auth.json"
        auth.write_text('{"OPENAI_API_KEY":"sk-deliberately-invalid-test-marker"}\n')
        token = root / "source-token.txt"
        token.write_text("deliberately-invalid-no-inference\n")
        before = hashlib.sha256(auth.read_bytes()).hexdigest()
        lab = LiveLab(root / "lab")
        lab.auth_source, lab.token_file = auth, token
        lab.prepare_workspace()
        checks = []
        try:
            assert not lab.codex_profile.exists() and not lab.claude_profile.exists()
            assert lab.configuration()["defaultCwd"] == str(lab.workspace)
            checks.append("configuration inspection starts no providers and creates no profiles")
            await lab.ensure_profile("codex")
            assert not (lab.codex_profile / "skills").exists()
            codex = await lab.start({"provider": "codex", "cwd": str(lab.workspace)})
            pid = codex.server.pid
            assert psutil.pid_exists(pid)
            async with connect(codex.websocket_url, max_size=None, proxy=None) as websocket:

                async def rpc(identity, method, params):
                    await websocket.send(json.dumps({"id": identity, "method": method, "params": params}))
                    while True:
                        frame = json.loads(await websocket.recv())
                        if frame.get("id") == identity and "method" not in frame:
                            assert "error" not in frame, frame.get("error")
                            return frame["result"]

                await rpc(
                    1,
                    "initialize",
                    {
                        "clientInfo": {"name": "pdum-067-check", "version": "0.0.0"},
                        "capabilities": {"experimentalApi": True},
                    },
                )
                await websocket.send(json.dumps({"method": "initialized"}))
                created = await rpc(
                    2,
                    "thread/start",
                    {
                        "cwd": str(lab.workspace),
                        "model": "gpt-6-luna",
                        "approvalPolicy": "never",
                        "sandbox": "danger-full-access",
                    },
                )
                codex.thread_id = created["thread"]["id"]
                checks.append("real owned Codex app-server initializes and starts an empty thread without a turn")
                try:
                    history = await lab.snapshot(codex)
                    assert history["sessionId"] == codex.thread_id
                    assert history["source"]["readOnly"]
                    checks.append("native Codex history read retains session identity")
                except ValueError as error:
                    assert "history is not available" in str(error)
                    checks.append("unmaterialized empty native history is explicit")
            ended = await lab.end(codex)
            assert ended["state"] == "ended" and not psutil.pid_exists(pid)
            checks.append("ending owned Codex run reaps its actual native PID")
            native = (lab.codex_profile / "config.toml").read_text()
            assert "gpt-6-luna" in native and "mcp_servers" not in native
            assert hashlib.sha256(auth.read_bytes()).hexdigest() == before
            checks.append("auth-only copy preserves source and copies no settings or skills")
            claude = await lab.start({"provider": "claude", "cwd": str(lab.workspace), "qualification": True})
            worker = lab.manager.worker(claude.worker_id)
            assert worker.pid is None and worker.state == "waiting"
            assert worker.options.max_budget_usd == 0.05
            assert worker.options.environment["CLAUDE_CODE_OAUTH_TOKEN"] == token.read_text().strip()
            assert claude.thread_id == worker.conversation_id
            checks.append("Claude allocation records native identity and scoped credential without starting a process")
            await lab.end(claude)
            assert worker.state == "stopped"
            checks.append("ending an unconnected Claude allocation leaves no native process")
            assert not (lab.claude_profile / "claude/.credentials.json").exists()
            starting = asyncio.create_task(lab.start({"provider": "codex", "cwd": str(lab.workspace)}))
            while not lab.lifecycle_lock.locked() and not starting.done():
                await asyncio.sleep(0)
            closing = asyncio.create_task(lab.close())
            late_run = await starting
            await closing
            assert late_run.state == "ended" and not psutil.pid_exists(late_run.server.pid)
            checks.append("shutdown includes an in-flight native launch and reaps its PID")
        finally:
            await lab.close()
        print(
            json.dumps(
                {
                    "passed": len(checks),
                    "checks": checks,
                    "modelInputs": 0,
                    "providerInferenceUsd": 0,
                    "ordinaryProfilesChanged": False,
                    "pid": os.getpid(),
                }
            )
        )


if __name__ == "__main__":
    asyncio.run(main())

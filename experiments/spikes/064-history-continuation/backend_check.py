"""Real native history/fork checks over isolated copies; submits no model input."""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "067-live-session-workspace"))
from backend import LiveLab  # noqa: E402
from websockets.asyncio.client import connect  # noqa: E402

REPO = HERE.parents[2]
SOURCE = REPO / "experiments/artifacts/067-live-session-workspace"
CODEX = "01a173b1-644a-7f30-bee4-aae2a281f7ec"
CLAUDE = "dbcf36c7-54be-4c2c-921b-f39594f5c460"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def main() -> None:
    if not SOURCE.is_dir():
        raise SystemExit("Prepare the explicitly selected 067 source corpus first")
    with tempfile.TemporaryDirectory(prefix="pdum-064-native-") as temporary:
        root = Path(temporary)
        lab = LiveLab(root / "lab")
        lab.workspace = SOURCE / "workspace"
        auth = root / "invalid-auth.json"
        auth.write_text('{"OPENAI_API_KEY":"sk-deliberately-invalid-no-model"}')
        token = root / "invalid-token.txt"
        token.write_text("deliberately-invalid-no-model")
        lab.auth_source, lab.token_file = auth, token
        await lab.ensure_profile("codex")
        await lab.ensure_profile("claude")
        originals = []
        for provider, session, source_root, destination in (
            ("codex", CODEX, SOURCE / "profiles/codex", lab.codex_profile),
            ("claude", CLAUDE, SOURCE / "profiles/claude/claude", lab.claude_profile / "claude"),
        ):
            candidates = list(source_root.rglob(f"*{session}*.jsonl"))
            if not candidates:
                raise RuntimeError(f"Selected {provider} native source is unavailable")
            for source in candidates:
                target = destination / source.relative_to(source_root)
                target.parent.mkdir(parents=True, exist_ok=True)
                originals.append((source, digest(source)))
                shutil.copy2(source, target)
        # Keep native item projection; let Codex rebuild a catalogue with local
        # copied paths. Copying state_*.sqlite could retain original rollout paths.
        for source in (SOURCE / "profiles/codex").glob("thread_history_*.sqlite"):
            read = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
            write = sqlite3.connect(lab.codex_profile / source.name)
            try:
                read.backup(write)
            finally:
                write.close()
                read.close()
        checks = []
        try:
            for provider, session in (("codex", CODEX), ("claude", CLAUDE)):
                for _ in range(20):
                    listing = await lab.catalogue(provider)
                    if any(row["sessionId"] == session for row in listing["sessions"]):
                        break
                    await asyncio.sleep(0.2)
                assert any(row["sessionId"] == session for row in listing["sessions"]), listing.get("errors")
                choice = await lab.history_choice(provider, session, str(lab.workspace))
                assert choice["reference"]["sessionId"] == session and choice["branchPoints"]
                assert choice["document"]["source"]["readOnly"]
                checks.append(f"{provider}: native catalogue/read exposes qualified branch identities")
                point = choice["branchPoints"][0]
                before = choice["document"]["payload"]
                run = await lab.start(
                    {
                        "provider": provider,
                        "cwd": str(lab.workspace),
                        "continuation": {
                            "kind": "fork",
                            "sourceSessionId": session,
                            "pointId": point["id"],
                            "pointKind": point["kind"],
                        },
                    }
                )
                if provider == "codex":
                    async with connect(run.websocket_url, max_size=None, proxy=None) as socket:

                        async def rpc(identity, method, params):
                            assert method in {"initialize", "thread/fork", "thread/loaded/list"}
                            await socket.send(json.dumps({"id": identity, "method": method, "params": params}))
                            while True:
                                value = json.loads(await socket.recv())
                                if value.get("id") == identity and "method" not in value:
                                    assert "error" not in value, value.get("error")
                                    return value["result"]

                        await rpc(
                            1,
                            "initialize",
                            {
                                "clientInfo": {"name": "pdum-064-native", "version": "0.0.0"},
                                "capabilities": {"experimentalApi": True},
                            },
                        )
                        await socket.send(json.dumps({"method": "initialized"}))
                        assert (await rpc(2, "thread/loaded/list", {}))["data"] == []
                        forked = await rpc(
                            3,
                            "thread/fork",
                            {
                                "threadId": session,
                                "lastTurnId": point["id"],
                                "excludeTurns": True,
                            },
                        )
                        run.thread_id = forked["thread"]["id"]
                else:
                    worker = lab.manager.worker(run.worker_id)
                    assert worker.resume and worker.pid is None
                assert run.thread_id != session
                after = (await lab.history_choice(provider, session, str(lab.workspace)))["document"]["payload"]
                if provider == "codex":
                    assert before["thread"]["turns"] == after["thread"]["turns"]
                else:
                    assert before["messages"] == after["messages"]
                await lab.end(run)
                checks.append(f"{provider}: native fork creates a new identity and preserves source content")
                try:
                    await lab.start(
                        {
                            "provider": provider,
                            "cwd": str(lab.workspace),
                            "continuation": {
                                "kind": "resume",
                                "sourceSessionId": session,
                                "pointId": point["id"],
                                "pointKind": point["kind"],
                            },
                        }
                    )
                    raise AssertionError("resume accepted a branch point")
                except ValueError as error:
                    assert "Resume uses the latest" in str(error)
                checks.append(f"{provider}: resume cannot silently reinterpret a fork-point request")
            previous = lab.directory / "runs/prior-owner/run.json"
            previous.parent.mkdir(parents=True)
            previous.write_text(
                json.dumps({"id": "prior-owner", "provider": "codex", "state": "ready", "cwd": str(lab.workspace)})
            )
            record = next(row for row in await lab.observations() if row["id"] == "prior-owner")
            assert not record["owned"] and record["state"] == "unknown"
            try:
                lab.find("prior-owner")
                raise AssertionError("prior owner was adopted")
            except Exception as error:
                assert getattr(error, "status_code", None) == 409
            checks.append("previous-owner records stay unknown/unowned and cannot be stopped by adoption")
            receipt = await lab.end_all()
            assert receipt["targetIds"] == [] and receipt["failures"] == []
            assert all(digest(path) == before for path, before in originals)
            checks.append("end-all excludes prior owners and original selected files stay unchanged")
        finally:
            await lab.close()
        print(json.dumps({"passed": len(checks), "checks": checks, "modelInputs": 0, "providerInferenceUsd": 0}))


if __name__ == "__main__":
    asyncio.run(main())

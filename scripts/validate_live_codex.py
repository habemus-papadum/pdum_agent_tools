"""Opt-in, single-turn real Codex CLI parity check, optionally through MITM."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import typer
from check_codex_client import check_client
from pdum.codex_launcher.metrics import UsageObserver
from pdum.codex_launcher.observation import JsonlRecorder, Observation
from pdum.codex_launcher.profiles import ProfileSpec, create_profile
from pdum.codex_launcher.runtime import LaunchOptions, launch
from websockets.asyncio.client import connect

app = typer.Typer(help=__doc__)


class TurnEvidence:
    """Observe completion independently of text printed by the real terminal UI."""

    def __init__(self) -> None:
        self.completed = asyncio.Event()
        self.messages: list[dict[str, Any]] = []
        self.thread_id: str | None = None

    async def open(self) -> None:
        """Start an in-memory evidence collector."""

    async def process(self, observation: Observation) -> None:
        """Keep protocol evidence and signal an actual terminal turn notification."""
        message = await asyncio.to_thread(json.loads, observation.payload)
        if isinstance(message, dict):
            self.messages.append(message)
            if (
                message.get("method") == "turn/completed"
                and message.get("params", {}).get("threadId") == self.thread_id
            ):
                self.completed.set()

    async def close(self) -> None:
        """Leave evidence available to the validation report."""


async def prepare_named_thread(endpoint: str) -> str:
    """Create a named Luna thread so native TUI title generation does not use another model."""
    async with connect(endpoint, proxy=None, max_size=None) as client:

        async def request(method: str, params: dict[str, Any]) -> dict[str, Any]:
            await client.send(json.dumps({"id": method, "method": method, "params": params}))
            async with asyncio.timeout(20):
                while True:
                    message = json.loads(await client.recv())
                    if message.get("id") == method:
                        if "error" in message:
                            raise RuntimeError(f"Native {method} failed: {message['error'].get('code')}")
                        return message["result"]

        await request("initialize", {"clientInfo": {"name": "pdum-live-validation", "version": "1"}})
        await client.send(json.dumps({"method": "initialized"}))
        result = await request("thread/start", {"model": "gpt-6-luna"})
        thread_id = result["thread"]["id"]
        await request("thread/name/set", {"threadId": thread_id, "name": "pdum live validation"})
        return thread_id


def summarize_upstream(root: Path) -> dict[str, Any]:
    """Extract only non-secret API transport, model and usage evidence."""
    models: set[str] = set()
    completions: dict[str, dict[str, Any]] = {}
    websocket_messages = 0
    for archive in root.glob("*/records.jsonl"):
        with archive.open() as stream:
            for line in stream:
                record = json.loads(line)
                if record.get("kind") != "websocket_message":
                    continue
                websocket_messages += 1
                data = record.get("json")
                if not isinstance(data, dict):
                    continue
                if data.get("type") == "response.create" and isinstance(data.get("model"), str):
                    models.add(data["model"])
                if data.get("type") == "response.completed":
                    response = data["response"]
                    completions[response["id"]] = {
                        "model": response.get("model"),
                        "service_tier": response.get("service_tier"),
                        "usage": {
                            key: value
                            for key, value in response.get("usage", {}).items()
                            if key in {"input_tokens", "output_tokens", "input_tokens_details", "total_tokens"}
                        },
                    }
    return {"models": sorted(models), "websocket_messages": websocket_messages, "responses": list(completions.values())}


async def validate(output: Path, auth_file: Path, binary: str, mitm: bool) -> dict[str, Any]:
    """Run one live Luna turn using copied credentials and isolated server/client state."""
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    source_digest = hashlib.sha256(auth_file.read_bytes()).digest()
    evidence = TurnEvidence()
    usage = UsageObserver()
    proxy_status = None
    async with AsyncExitStack() as stack:
        directory = stack.enter_context(tempfile.TemporaryDirectory(prefix="pdum-live-", dir="/tmp"))
        profile = Path(directory) / "profile"
        info = await create_profile(
            profile,
            ProfileSpec(executable=binary, model="gpt-6-luna", copy_auth=True, auth_source=auth_file),
        )
        for warning in info.warnings:
            typer.echo(warning, err=True)
        sidecar_config = None
        if mitm:
            from pdum.mitm import SidecarConfig

            sidecar_config = SidecarConfig(capture_dir=output / "upstream", recording=True)
        options = LaunchOptions(
            host="127.0.0.1",
            mitm_config=sidecar_config,
            processors=(JsonlRecorder(output / "protocol.jsonl"), usage, evidence),
        )
        async with launch(profile, options) as server:
            evidence.thread_id = await prepare_named_thread(server.endpoint)
            client = await check_client(
                server.endpoint,
                binary=binary,
                timeout=90,
                prompt=(
                    "What is two plus two? Reply only with the lowercase English word for the answer. Do not use tools."
                ),
                expected="four",
                completion=evidence.completed,
                thread_id=evidence.thread_id,
            )
            await asyncio.wait_for(evidence.completed.wait(), 10)
            server_status = await server.status()
        if mitm:
            proxy_status = (await server.status())["capture"]
    messages = evidence.messages
    turns = [message for message in messages if message.get("method") == "turn/start"]
    completed = [message for message in messages if message.get("method") == "turn/completed"]
    assert len(turns) == 1, f"Expected exactly one live turn; observed {len(turns)}"
    assert completed and completed[-1]["params"]["turn"]["status"] == "completed", "Turn did not complete successfully"
    models = {
        message["result"]["model"]
        for message in messages
        if isinstance(message.get("result"), dict) and isinstance(message["result"].get("model"), str)
    }
    assert models == {"gpt-6-luna"}, f"Unexpected effective model(s): {sorted(models)}"
    snapshots = usage.snapshot()
    total = next(iter(snapshots.values()), {}).get("token_usage", {}).get("total", {})
    upstream = summarize_upstream(output / "upstream") if mitm else None
    if upstream is not None:
        assert upstream["models"] == ["gpt-6-luna"], f"Unexpected upstream models: {upstream['models']}"
        assert upstream["websocket_messages"] > 0 and upstream["responses"], "Missing live WebSocket evidence"
    input_tokens = (
        sum(response["usage"].get("input_tokens", 0) for response in upstream["responses"])
        if upstream is not None
        else total.get("inputTokens")
    )
    output_tokens = (
        sum(response["usage"].get("output_tokens", 0) for response in upstream["responses"])
        if upstream is not None
        else total.get("outputTokens")
    )
    upper_estimate = None
    if isinstance(input_tokens, int) and isinstance(output_tokens, int) and input_tokens <= 272000:
        upper_estimate = (input_tokens * 0.125 + output_tokens * 0.50) / 1_000_000
    source_unchanged = hashlib.sha256(auth_file.read_bytes()).digest() == source_digest
    result = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "binary": binary,
        "model": "gpt-6-luna",
        "client": client,
        "turns": len(turns),
        "source_auth_unchanged": source_unchanged,
        "server": server_status,
        "usage": snapshots,
        "mitm": proxy_status,
        "upstream_evidence": upstream,
        "standard_short_context_upper_estimate_usd": upper_estimate,
        "pricing_source": "https://developers.openai.com/api/docs/models/gpt-6-luna",
        "pricing_checked_on": "2026-10-12",
        "estimate_note": (
            "API-equivalent, not subscription billing; input charged at cache-write rate; excludes unknown use"
        ),
    }
    (output / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    assert source_unchanged, (
        "Source auth changed during validation; investigate concurrent refresh before another probe"
    )
    return result


@app.command()
def main(
    output: Path,
    auth_file: Path = typer.Option(None),
    binary: str = typer.Option(None),
    mitm: bool = False,
    live: bool = typer.Option(False, help="Acknowledge one paid/credentialed Luna inference call"),
) -> None:
    """Validate native remote-client behavior; requires an explicit --live flag."""
    if not live:
        raise typer.BadParameter("Use --live for this opt-in credentialed integration test")
    selected = binary or shutil.which("codex")
    if selected is None:
        raise typer.BadParameter("Codex not found; provide --binary")
    source = auth_file or Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "auth.json"
    if not source.is_file():
        raise typer.BadParameter("File-backed auth not found; provide --auth-file")
    result = asyncio.run(validate(output, source, selected, mitm))
    typer.echo(
        json.dumps(
            {
                "model": result["model"],
                "turns": result["turns"],
                "source_auth_unchanged": result["source_auth_unchanged"],
                "estimated_usd": result["standard_short_context_upper_estimate_usd"],
                "summary": str(output / "summary.json"),
            }
        )
    )


if __name__ == "__main__":
    app()

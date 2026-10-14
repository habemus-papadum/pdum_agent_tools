"""Credentials-free native OTLP metrics/version/failure qualification.

Run from experiments: uv run --frozen python spikes/034-codex-observation/metrics_probe.py
No login file is opened, no thread or turn is started, and no provider call is requested.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
INSTALLED = Path("/Users/nehal/.local/bin/codex").resolve()
BUILT = ROOT / "artifacts/003-codex-control/target/debug/codex"


class Collector:
    """Local JSON OTLP collector with optional explicit delay or rejection."""

    def __init__(self, path: Path, status: int, delay: float) -> None:
        self.records: list[dict[str, Any]] = []
        self.status, self.delay = status, delay
        self.active = 0
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                entry = {
                    "path": self.path,
                    "receivedAt": time.time(),
                    "status": status,
                    "delaySeconds": delay,
                    "payload": payload,
                }
                with owner.lock:
                    owner.active += 1
                    owner.records.append(entry)
                    with path.open("a") as output:
                        output.write(json.dumps(entry) + "\n")
                try:
                    time.sleep(delay)
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b"{}")
                except (BrokenPipeError, ConnectionResetError):
                    entry["responseConnectionClosed"] = True
                finally:
                    with owner.lock:
                        owner.active -= 1

            def log_message(self, *_: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


async def run_case(
    artifacts: Path, label: str, binary: Path, analytics: bool, status: int = 200, delay: float = 0
) -> dict[str, Any]:
    case = artifacts / label
    case.mkdir()
    profile = Path(tempfile.mkdtemp(prefix=f"pdum034-metrics-{label}-"))
    for name in ("home", "codex", "work", "tmp"):
        (profile / name).mkdir()
    collector = Collector(case / "otlp.jsonl", status, delay)
    config = f"""model = "gpt-6-luna"
cli_auth_credentials_store = "file"
sandbox_mode = "danger-full-access"
approval_policy = "never"
[analytics]
enabled = {str(analytics).lower()}
[feedback]
enabled = false
[features]
apps = false
plugins = false
[skills.bundled]
enabled = false
[otel]
environment = "spike034-metrics-credentials-free"
exporter = "none"
trace_exporter = "none"
[otel.metrics_exporter.otlp-http]
endpoint = "http://127.0.0.1:{collector.server.server_port}/v1/metrics"
protocol = "json"
"""
    (profile / "codex/config.toml").write_text(config)
    env = {
        "HOME": str(profile / "home"),
        "CODEX_HOME": str(profile / "codex"),
        "TMPDIR": str(profile / "tmp"),
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "en_US.UTF-8",
        "OTEL_METRIC_EXPORT_INTERVAL": "200",
        "OTEL_METRIC_EXPORT_TIMEOUT": "1000",
    }
    pending: dict[int, asyncio.Future] = {}
    messages: list[dict] = []
    result: dict[str, Any] = {
        "label": label,
        "binary": str(binary),
        "analyticsEnabled": analytics,
        "collectorStatus": status,
        "collectorDelaySeconds": delay,
        "profile": str(profile),
        "requestedProviderCalls": 0,
        "latencies": [],
        "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
    }
    stderr = (case / "stderr.txt").open("wb")
    process = await asyncio.create_subprocess_exec(
        str(binary),
        "app-server",
        "--listen",
        "stdio://",
        cwd=profile / "work",
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=stderr,
    )

    def record(direction: str, message: dict) -> None:
        entry = {"direction": direction, "time": time.time(), "message": message}
        messages.append(entry)
        with (case / "messages.jsonl").open("a") as output:
            output.write(json.dumps(entry) + "\n")

    async def receive() -> None:
        async for line in process.stdout:
            message = json.loads(line)
            record("server", message)
            if "id" in message and "method" not in message:
                future = pending.pop(message["id"], None)
                if future and not future.done():
                    future.set_result(message)

    reader = asyncio.create_task(receive())
    next_id = 0

    async def send(message: dict) -> None:
        record("client", message)
        process.stdin.write(json.dumps(message).encode() + b"\n")
        await process.stdin.drain()

    async def request(method: str, params: dict) -> dict:
        nonlocal next_id
        next_id += 1
        future = asyncio.get_running_loop().create_future()
        pending[next_id] = future
        started = time.monotonic()
        active = collector.active
        await send({"id": next_id, "method": method, "params": params})
        response = await asyncio.wait_for(future, 10)
        result["latencies"].append(
            {"method": method, "seconds": time.monotonic() - started, "collectorRequestsInFlightAtSend": active}
        )
        if "error" in response:
            raise RuntimeError(str(response["error"]))
        return response["result"]

    try:
        result["initialize"] = await request(
            "initialize",
            {"clientInfo": {"name": "spike034_metrics", "version": "0.0.0"}, "capabilities": {"experimentalApi": True}},
        )
        await send({"method": "initialized", "params": {}})
        result["account"] = await request("account/read", {"refreshToken": False})
        assert result["account"]["account"] is None
        result["command"] = await request(
            "command/exec",
            {
                "command": ["/usr/bin/printf", "NATIVE_METRICS_OK"],
                "cwd": str(profile / "work"),
                "sandboxPolicy": {"type": "dangerFullAccess"},
                "timeoutMs": 2000,
            },
        )
        assert result["command"]["exitCode"] == 0
        # Administrative traffic overlaps slow exports, but never requests model work.
        for _ in range(12):
            await asyncio.sleep(0.2)
            await request("config/read", {"includeLayers": False})
        await asyncio.sleep(0.6)
        result["batchesBeforeShutdown"] = len(collector.records)
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        started = time.monotonic()
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 5)
        except TimeoutError:
            result["forcedTermination"] = True
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 2)
            except TimeoutError:
                process.kill()
                await process.wait()
        await reader
        result["shutdownSeconds"] = time.monotonic() - started
        result["returncode"] = process.returncode
        stderr.close()
        await asyncio.sleep(0.1)
        await asyncio.to_thread(collector.close)
    result["batches"] = len(collector.records)
    metrics = [
        metric
        for batch in collector.records
        for resource in batch["payload"].get("resourceMetrics", [])
        for scope in resource.get("scopeMetrics", [])
        for metric in scope.get("metrics", [])
    ]
    result["metricNames"] = dict(Counter(metric["name"] for metric in metrics))
    result["authFileCreated"] = (profile / "codex/auth.json").exists()
    result["sessionFiles"] = len(list((profile / "codex/sessions").rglob("*.jsonl")))
    result["stderrBytes"] = (case / "stderr.txt").stat().st_size
    shutil.rmtree(profile)
    result["temporaryProfileRemoved"] = True
    (case / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


async def main() -> None:
    os.umask(0o077)
    artifacts = ROOT / "artifacts/034-codex-observation" / f"metrics-{time.time_ns() // 1_000_000}"
    artifacts.mkdir(parents=True)
    results = []
    async with asyncio.timeout(90):
        for args in (
            ("installed-false", INSTALLED, False),
            ("installed-true", INSTALLED, True),
            ("built-false", BUILT, False),
            ("built-reject503", BUILT, False, 503),
            ("built-slow", BUILT, False, 200, 1.5),
        ):
            results.append(await run_case(artifacts, *args))
    summary = {"artifacts": str(artifacts), "requestedProviderCalls": 0, "cases": results}
    (artifacts / "result.json").write_text(json.dumps(summary, indent=2) + "\n")
    assert all(not result.get("error") and result["returncode"] == 0 for result in results)
    assert all(not result["authFileCreated"] and result["sessionFiles"] == 0 for result in results)
    assert results[0]["batches"] == 0
    assert all("codex.process.start" in result["metricNames"] for result in results[1:])
    assert any(value["collectorRequestsInFlightAtSend"] > 0 for value in results[-1]["latencies"])
    print(
        json.dumps(
            {
                "artifacts": str(artifacts),
                "cases": [
                    {
                        "label": r["label"],
                        "batches": r["batches"],
                        "metricNames": r["metricNames"],
                        "error": r.get("error"),
                        "maxAdministrativeLatencySeconds": max(
                            value["seconds"] for value in r["latencies"] if value["method"] == "config/read"
                        ),
                    }
                    for r in results
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())

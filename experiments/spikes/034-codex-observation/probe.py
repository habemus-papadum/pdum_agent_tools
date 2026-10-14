"""Real launcher/client/offline analysis parity and native OTLP to a local collector.

Run from experiments using the absolute root workspace interpreter (see README).
One success turn, one sandbox-denial turn, and one explicit compaction. Uses Luna only.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pdum.codex_launcher import JsonlRecorder, LaunchOptions, launch
from pdum.mitm import SidecarConfig

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


common = load("joins_probe", ROOT / "spikes/028-codex-joins/probe.py")
accounting = load("accounting", ROOT / "spikes/033-codex-accounting/analysis.py")


class Processor:
    def __init__(self, *, delay=0, fail=False):
        self.analysis = accounting.Analysis()
        self.delay, self.fail = delay, fail
        self.count = 0

    async def open(self):
        pass

    async def process(self, observation):
        self.count += 1
        if self.fail and self.count > 2:
            raise RuntimeError("Deliberately unavailable research exporter")
        if self.delay:
            await asyncio.sleep(self.delay)
        self.analysis.accept(observation.as_dict())

    async def close(self):
        pass


class Probe(common.Probe):
    def __init__(self):
        super().__init__("034-codex-observation")
        self.profile = Path(tempfile.mkdtemp(prefix="pdum034-")) / "profile"
        self.client_analysis = accounting.Analysis()

    def record(self, client, direction, message):
        super().record(client, direction, message)
        self.client_analysis.accept({"client": client, "direction": direction, "message": message})


def collector(artifacts):
    records = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            try:
                payload = json.loads(body)
            except ValueError:
                payload = {"unexpectedNonJsonBytes": len(body)}
            entry = {"path": self.path, "time": time.time(), "payload": payload}
            records.append(entry)
            with (artifacts / "otlp.jsonl").open("a") as stream:
                stream.write(json.dumps(entry) + "\n")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, records


async def exercise(probe):
    await probe.setup()
    http, records = collector(probe.artifacts)
    config = probe.profile / "codex/config.toml"
    with config.open("a") as stream:
        stream.write('\n[otel]\nenvironment = "spike034"\nlog_user_prompt = true\nlog_agent_responses = true\n')
        for key, path in (("exporter", "logs"), ("trace_exporter", "traces"), ("metrics_exporter", "metrics")):
            stream.write(
                f'\n[otel.{key}.otlp-http]\nendpoint = "http://127.0.0.1:{http.server_port}/v1/{path}"\n'
                'protocol = "json"\n'
            )
    live = Processor()
    slow = Processor(delay=0.1)
    failed = Processor(fail=True)
    options = LaunchOptions(
        executable=common.BINARY,
        host="127.0.0.1",
        port=0,
        processors=[JsonlRecorder(probe.artifacts / "relay.jsonl"), live, slow, failed],
        environment={
            "OTEL_BSP_SCHEDULE_DELAY": "300",
            "OTEL_BLRP_SCHEDULE_DELAY": "300",
            "OTEL_METRIC_EXPORT_INTERVAL": "1000",
        },
        mitm_config=SidecarConfig(
            capture_dir=probe.artifacts / "upstream", recording=True, bind_host="127.0.0.1", advertised_host="127.0.0.1"
        ),
    )
    try:
        async with launch(probe.profile, options) as server:
            a = await probe.client("A", server.endpoint, auth=True)
            thread = await probe.start_thread(a, historyMode="paginated")
            turn, index = await probe.turn(
                a,
                thread,
                "Run exactly one shell command: printf 'OTLP_OK\\n'. "
                "Do not use any other tool. Then reply exactly OBSERVED.",
            )
            done = await a.wait("turn/completed", after=index)
            assert done["params"]["turn"]["status"] == "completed"
            probe.save(
                "success-history.json", await a.request("thread/read", {"threadId": thread, "includeTurns": True})
            )
            probe.result["cases"]["whileSlowExporterBacklogged"] = await server.status()
            await asyncio.sleep(1)
            before = len(records)
            denial = await probe.start_thread(a, sandbox="read-only", historyMode="paginated")
            denial_target = probe.profile.parent / "denied-write"
            turn, index = await probe.turn(
                a,
                denial,
                f"Run exactly one shell command: touch {denial_target}. "
                "Do not retry or call any other tool. Report whether it succeeded.",
            )
            await a.wait("turn/completed", after=index)
            probe.save(
                "denial-history.json", await a.request("thread/read", {"threadId": denial, "includeTurns": True})
            )
            probe.result["cases"]["denialOtlpBatchStart"] = before
            index = len(a.messages)
            probe.result["attempts"].append(
                {"operation": "thread/compact/start", "thread": thread, "model": common.MODEL}
            )
            await a.request("thread/compact/start", {"threadId": thread})
            await a.wait(
                "item/completed",
                after=index,
                predicate=lambda m: m["params"]["item"].get("type") == "contextCompaction",
            )
            probe.save(
                "after-compaction.json", await a.request("thread/read", {"threadId": thread, "includeTurns": True})
            )
            await asyncio.sleep(3)
            probe.result["cases"]["statusBeforeClose"] = await server.status()
            for client in probe.clients:
                await client.close()
        await asyncio.sleep(1)
    finally:
        http.shutdown()
        http.server_close()
    replay = accounting.Analysis()
    for line in (probe.artifacts / "relay.jsonl").read_text().splitlines():
        replay.accept(json.loads(line))
    client_snapshot, plugin_snapshot, replay_snapshot = (
        probe.client_analysis.snapshot(),
        live.analysis.snapshot(),
        replay.snapshot(),
    )
    probe.save("client-analysis.json", client_snapshot)
    probe.save("processor-analysis.json", plugin_snapshot)
    probe.save("offline-analysis.json", replay_snapshot)
    assert client_snapshot == plugin_snapshot == replay_snapshot
    probe.result["analysisEqual"] = True
    probe.result["processorCounts"] = {"live": live.count, "slow": slow.count, "failed": failed.count}
    probe.result["otlpBatchCounts"] = {
        path: sum(e["path"] == path for e in records) for path in sorted({e["path"] for e in records})
    }
    probe.result["profileOutsideCheckout"] = str(probe.profile)


async def main():
    probe = Probe()
    try:
        async with asyncio.timeout(180):
            await exercise(probe)
    except Exception as error:
        probe.result["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        await probe.finish()
        probe.result["missingUsage"] = (
            "Client counters exclude warmups and explicit compaction. "
            "Run analyze.py against the recorded upstream and OTLP evidence; actual billing unknown."
        )
        shutil.rmtree(probe.profile.parent)
        probe.result["temporaryProfileRemoved"] = True
        probe.save("result.json", probe.result)


if __name__ == "__main__":
    asyncio.run(main())

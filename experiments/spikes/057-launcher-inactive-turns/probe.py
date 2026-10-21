"""Bounded live lifecycle qualification through the production Codex launcher/relay.

Two paid Luna turns maximum, one managed heartbeat process, isolated profile.
Run with the root workspace interpreter via uv; --live is required deliberately.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import shlex
import sys
import time
import tomllib
from dataclasses import replace
from pathlib import Path

import psutil
from pdum.codex_launcher import ProfileSpec, create_profile, launch

shared_path = Path(__file__).resolve().parents[1] / "028-codex-joins/probe.py"
spec = importlib.util.spec_from_file_location("joins_057", shared_path)
shared = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = shared
spec.loader.exec_module(shared)


class Probe(shared.Probe):
    def __init__(self):
        super().__init__("057-launcher-inactive-turns")
        self.work = self.artifacts / "work"
        self.work.mkdir()
        self.checks = []
        self.identity = None
        self.result["checks"] = self.checks

    def check(self, condition, description):
        if not condition:
            raise AssertionError(description)
        self.checks.append(description)

    async def setup(self):
        await create_profile(self.profile, ProfileSpec(executable=shared.BINARY, model=shared.MODEL, copy_skills=False))
        self.delay_before = tomllib.loads((self.profile / "config.toml").read_text()).get("thread_unload_delay_secs")
        self.script = self.work / "heartbeat.py"
        self.script.write_text(
            "import os, time\nfrom pathlib import Path\n"
            "root = Path(__file__).parent\n(root/'heartbeat.pid').write_text(str(os.getpid()))\n"
            "deadline = time.monotonic() + 120\n"
            "while time.monotonic() < deadline:\n"
            "    with (root/'heartbeat.log').open('a') as f: f.write(str(time.monotonic())+'\\n')\n"
            "    time.sleep(0.2)\n"
            "(root/'natural-completion').write_text('completed')\n"
        )
        version = await asyncio.create_subprocess_exec(str(shared.BINARY), "--version", stdout=asyncio.subprocess.PIPE)
        out, _ = await version.communicate()
        self.save(
            "level0.json",
            {
                "version": out.decode().strip(),
                "binary": str(shared.BINARY),
                "sha256": hashlib.sha256(shared.BINARY.read_bytes()).hexdigest(),
                "model": shared.MODEL,
                "effort": "low",
                "serviceTier": "default",
                "priceDate": "2026-10-19",
                "profile": str(self.profile),
                "launchOptions": {"relay": True, "thread_unload_delay_secs": 3},
                "bounds": {"modelTurns": 2, "wallSeconds": 160, "toolItems": 8, "observedApiEquivalentUsd": 0.10},
                "auth": "existing login read once; account/login/start into isolated profile; source hash checked",
            },
        )

    def options(self, capture="relay.jsonl"):
        return replace(
            super().options(capture),
            config_overrides={
                "thread_unload_delay_secs": "3",
                "model_reasoning_effort": '"low"',
                "service_tier": '"default"',
                "web_search": '"disabled"',
                "analytics.enabled": "false",
                "feedback.enabled": "false",
                "features.apps": "false",
                "features.plugins": "false",
                "features.multi_agent": "false",
                "skills.bundled.enabled": "false",
            },
        )

    def observe(self, message):
        super().observe(message)
        if self.estimate() > 0.10 or len(self.calls) > 8:
            self.bound_error = "057 usage/tool bound exceeded"

    async def turn(self, *args, **kwargs):
        if self.turns >= 2:
            raise RuntimeError("057 paid turn bound reached")
        return await super().turn(*args, **kwargs)

    def heartbeat_size(self):
        return (self.work / "heartbeat.log").stat().st_size

    def process_alive(self):
        if self.identity is None:
            return False
        try:
            p = psutil.Process(self.identity["pid"])
            return p.create_time() == self.identity["create_time"] and p.status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False


async def exercise(p):
    async with launch(p.profile, p.options()) as server:
        a = await p.client("live", server.endpoint, auth=True)
        b = await p.client("observer", server.endpoint)
        status = await server.status()
        p.result["launcherBefore"] = status
        config = await a.request("config/read", {"includeLayers": True})
        p.save("effective-config.json", config)
        p.result["effectiveDelay"] = config["config"].get("thread_unload_delay_secs")
        p.check(p.result["effectiveDelay"] == 3, "Native launch override is visible as three seconds")

        t = await p.start_thread(a, cwd=str(p.work), historyMode="paginated")
        command = f"{shlex.quote(sys.executable)} {shlex.quote(str(p.script))}"
        turn, mark = await p.turn(
            a,
            t,
            "This is an authorized bounded managed-terminal lifecycle experiment. "
            f"Run exactly this shell command with exec_command and yield_time_ms 1000: {command}\n"
            "The script is prepared already and stops itself after120seconds. "
            "When the tool yields a running session, immediately finish your turn with BACKGROUND_STARTED. "
            "Do not wait, poll, read files, kill it, start subagents or run any other tools. "
            "The external experiment owner is responsible for observing and cleaning up this process.",
        )
        done = await a.wait(
            "turn/completed", after=mark, timeout=90, predicate=lambda m: m["params"]["turn"]["id"] == turn
        )
        p.check(done["params"]["turn"]["status"] == "completed", "Real Luna completed the background-start turn")
        pid = int((p.work / "heartbeat.pid").read_text())
        process = psutil.Process(pid)
        p.check(str(p.script) in process.cmdline(), "Heartbeat PID belongs to this experiment script")
        p.identity = {"pid": pid, "create_time": process.create_time()}
        p.result["heartbeatIdentity"] = p.identity
        terminals = await a.request("thread/backgroundTerminals/list", {"threadId": t})
        p.result["terminalsBefore"] = terminals
        p.check(bool(terminals["data"]), "Native registry reports a retained background terminal")
        native_status = (await b.request("thread/read", {"threadId": t}))["thread"]["status"]
        p.check(native_status["type"] == "idle", "Thread is idle while its managed terminal is alive")
        size_before = p.heartbeat_size()
        await asyncio.sleep(3.5)
        p.check(
            p.process_alive() and p.heartbeat_size() > size_before,
            "Subscribed idle thread keeps its heartbeat alive beyond unload delay",
        )

        start = time.monotonic()
        before_close = len(a.messages)
        await a.request("thread/unsubscribe", {"threadId": t})
        async with asyncio.timeout(15):
            while t in (await b.request("thread/loaded/list"))["data"]:
                await asyncio.sleep(0.05)
        p.result["unloadMs"] = round(1000 * (time.monotonic() - start))
        p.result["threadClosed"] = [m for m in a.messages[before_close:] if m.get("method") == "thread/closed"]
        p.result["processAliveAfterUnload"] = p.process_alive()
        p.check(not p.process_alive(), "Automatic unload actually kills the managed heartbeat OS process")
        size_stopped = p.heartbeat_size()
        await asyncio.sleep(0.7)
        p.check(p.heartbeat_size() == size_stopped, "Heartbeat output stops after unload")
        p.check(not (p.work / "natural-completion").exists(), "Process did not reach its 120-second natural exit")
        p.result["terminalReadAfterUnload"] = await b.request(
            "thread/backgroundTerminals/list", {"threadId": t}, raw=True
        )

        rejected_params = {
            "threadId": t,
            "model": shared.MODEL,
            "effort": "low",
            "serviceTier": "default",
            "input": shared.text_input("Reply only RESUMED_OK. Do not call any tools."),
        }
        rejection = await a.request("turn/start", rejected_params, raw=True)
        p.result["turnOnUnloaded"] = rejection
        p.check(rejection.get("error", {}).get("code") == -32600, "Unloaded turn/start is rejected without auto-resume")
        p.check(
            rejection["error"]["message"] == f"thread not found: {t}",
            "Relay preserves exact native thread-not-found error",
        )
        p.check(t not in (await b.request("thread/loaded/list"))["data"], "Rejected turn leaves the runtime unloaded")
        p.result["launcherAfterUnload"] = await server.status()
        p.check(
            p.result["launcherAfterUnload"]["server"] == status["server"],
            "App-server process is still the same process",
        )

        resumed = await a.request("thread/resume", {"threadId": t})
        p.result["resumed"] = {"threadId": resumed["thread"]["id"], "status": resumed["thread"]["status"]}
        p.check(resumed["thread"]["id"] == t, "Explicit resume reconstructs the same conversation ID")
        after = await a.request("thread/backgroundTerminals/list", {"threadId": t})
        p.check(not after["data"], "Resuming history does not resurrect the terminal")
        second_turn, second_mark = await p.turn(a, t, "Reply only RESUMED_OK. Do not call any tools.")
        completed = await a.wait(
            "turn/completed",
            after=second_mark,
            timeout=60,
            predicate=lambda m: m["params"]["turn"]["id"] == second_turn,
        )
        p.check(
            completed["params"]["turn"]["status"] == "completed",
            "New turn succeeds after explicit resume through the same relay",
        )
        p.save("resumed-history.json", await a.request("thread/read", {"threadId": t, "includeTurns": True}))
        p.result["relayFinal"] = (await server.status())["relay"]
    # Native thread/start can legitimately persist project trust in this isolated
    # home. Test the launch override specifically, not whole-file immutability.
    p.check(
        tomllib.loads((p.profile / "config.toml").read_text()).get("thread_unload_delay_secs") == p.delay_before,
        "Unload delay override was not persisted in native profile config",
    )


async def main():
    p = Probe()
    try:
        await p.setup()
        async with asyncio.timeout(160):
            await exercise(p)
        p.result["passed"] = True
    except Exception as error:
        p.result.update(passed=False, error=f"{type(error).__name__}: {error}")
    finally:
        # Clean only the process whose identity and command were verified above.
        if p.process_alive():
            psutil.Process(p.identity["pid"]).kill()
        await p.finish()
        p.result["priceDate"] = "2026-10-19"
        p.save("result.json", p.result)
        print(
            json.dumps(
                {
                    "passed": p.result.get("passed"),
                    "checks": p.checks,
                    "unloadMs": p.result.get("unloadMs"),
                    "error": p.result.get("error"),
                }
            )
        )
    if not p.result.get("passed"):
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="Authorize up to two bounded real Luna turns")
    args = parser.parse_args()
    if not args.live:
        parser.error("--live is required; this probe uses existing login in a disposable profile")
    asyncio.run(main())

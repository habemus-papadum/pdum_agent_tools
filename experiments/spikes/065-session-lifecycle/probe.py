"""Actual provider lifecycle probes without model inputs or ordinary-profile writes."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

import psutil
from websockets.asyncio.client import connect, unix_connect

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "067-live-session-workspace/backend.py"
ARTIFACTS = ROOT / "experiments/artifacts/065-session-lifecycle"


def identity(pid: int) -> dict:
    process = psutil.Process(pid)
    return {"pid": pid, "createTime": process.create_time()}


def alive(record: dict) -> bool:
    try:
        process = psutil.Process(record["pid"])
        return process.create_time() == record["createTime"] and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


async def wait_for(check, timeout: float = 10) -> bool:
    deadline = time.monotonic() + timeout
    while not check() and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    return bool(check())


async def reap_owned(records: list[dict]) -> list[dict]:
    """Signal only recorded PID/create-time pairs, never an executable/port match."""
    signalled = []
    for signum in (signal.SIGTERM, signal.SIGKILL):
        for record in reversed(records):
            if alive(record):
                psutil.Process(record["pid"]).send_signal(signum)
                signalled.append({**record, "signal": signum.name})
        await wait_for(lambda: not any(alive(record) for record in records), 3)
    if any(alive(record) for record in records):
        raise RuntimeError("An exact-owned process did not stop")
    return signalled


def cleanup_socket_files(records: dict) -> list[str]:
    """Remove only recorded launcher socket files after their native PID exited."""
    removed = []
    for record in records.values():
        endpoint = record.get("backendEndpoint")
        if not endpoint or alive(record):
            continue
        path = Path(urlsplit(endpoint).path)
        if path.name != "app.sock" or not path.parent.name.startswith("pdum-codex-sock-"):
            continue
        for name in ("app.sock", "control.sock"):
            owned = path.parent / name
            if owned.is_socket():
                owned.unlink()
                removed.append(str(owned))
        if path.parent.exists():
            # Unexpected files are preserved rather than recursively removed.
            try:
                path.parent.rmdir()
            except OSError:
                pass
    return removed


class RPC:
    def __init__(self, socket):
        self.socket = socket
        self.sequence = 0

    async def call(self, method: str, params: dict | None = None):
        if method.startswith("turn/"):
            raise ValueError("No turn operation is allowed in the no-inference probe")
        self.sequence += 1
        await self.socket.send(json.dumps({"id": self.sequence, "method": method, "params": params or {}}))
        async with asyncio.timeout(10):
            while True:
                frame = json.loads(await self.socket.recv())
                if frame.get("id") == self.sequence and "method" not in frame:
                    if "error" in frame:
                        raise RuntimeError(frame["error"].get("message", "Native RPC failed"))
                    return frame.get("result")

    async def initialize(self):
        result = await self.call("initialize", {"clientInfo": {"name": "pdum-lifecycle-check", "version": "0.0.0"}})
        await self.socket.send(json.dumps({"method": "initialized"}))
        return result


class SDK:
    def __init__(self, process):
        self.process = process
        self.sequence = 0

    @classmethod
    async def start(cls, stderr):
        environment = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE_", "CLAUDECODE", "ANTHROPIC_"))}
        process = await asyncio.create_subprocess_exec(
            "node",
            str(HERE / "sdk-control.mjs"),
            cwd=ROOT,
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
        )
        return cls(process)

    async def call(self, operation: str, key: str, **fields):
        self.sequence += 1
        self.process.stdin.write(
            (json.dumps({"id": self.sequence, "operation": operation, "key": key, **fields}) + "\n").encode()
        )
        await self.process.stdin.drain()
        response = json.loads(await asyncio.wait_for(self.process.stdout.readline(), 20))
        if response.get("id") != self.sequence or not response.get("ok"):
            raise RuntimeError(f"SDK control failed: {response.get('error', 'invalid response')}")
        return response["result"]

    async def close(self):
        if self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 10)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()


class Owner:
    def __init__(self, process, details, directory):
        self.process, self.details, self.directory = process, details, directory
        self.record = identity(process.pid)
        self.children: list[dict] = []

    @classmethod
    async def start(cls, directory: Path, stderr):
        directory.mkdir(parents=True)
        auth, token = directory / "fake-auth.json", directory / "fake-token.txt"
        auth.write_text('{"OPENAI_API_KEY":"sk-deliberately-invalid-lifecycle-check"}\n')
        token.write_text("deliberately-invalid-no-model-input\n")
        environment = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("CLAUDE_", "CLAUDECODE", "ANTHROPIC_", "CODEX_", "OPENAI_"))
        }
        environment.update(
            PDUM_LIVE_LAB_DIR=str(directory / "lab"),
            PDUM_CODEX_AUTH_SOURCE=str(auth),
            PDUM_CLAUDE_TOKEN_FILE=str(token),
        )
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            str(BACKEND),
            cwd=ROOT,
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
        )
        try:
            details = json.loads(await asyncio.wait_for(process.stdout.readline(), 20))
            if details.get("type") != "live-lab-ready":
                raise RuntimeError("Unexpected backend readiness")
        except BaseException:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()
            raise
        return cls(process, details, directory)

    async def api(self, path, body=None):
        def read():
            request = urllib.request.Request(
                self.details["url"] + path,
                data=None if body is None else json.dumps(body).encode(),
                headers={} if body is None else {"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)

        return await asyncio.to_thread(read)

    def capture_children(self):
        if alive(self.record):
            known = {(row["pid"], row["createTime"]) for row in self.children}
            for process in psutil.Process(self.process.pid).children(recursive=True):
                try:
                    row = identity(process.pid)
                    if (row["pid"], row["createTime"]) not in known:
                        self.children.append(row)
                except psutil.NoSuchProcess:
                    pass

    def codex_record(self, run):
        port = urlsplit(run["websocketUrl"]).port
        folder = self.directory / "lab/profiles/codex/.pdum/runtime/runs"
        for path in folder.glob("*/owner.json"):
            row = json.loads(path.read_text())
            if urlsplit(row.get("endpoint", "")).port == port:
                return {
                    "pid": row["server"]["pid"],
                    "createTime": row["server"]["create_time"],
                    "backendEndpoint": row["backend_endpoint"],
                }
        raise RuntimeError("Owned native server identity was not recorded")

    async def close(self):
        self.capture_children()
        if self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 25)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        return await reap_owned(self.children)


async def connected_codex(owner: Owner):
    run = await owner.api("/sessions", {"provider": "codex"})
    socket = await connect(run["websocketUrl"], max_size=None, proxy=None)
    rpc = RPC(socket)
    initialization = await rpc.initialize()
    created = await rpc.call(
        "thread/start",
        {"cwd": run["cwd"], "model": "gpt-6-luna", "approvalPolicy": "never", "sandbox": "danger-full-access"},
    )
    thread_id = created["thread"]["id"]
    await owner.api(f"/sessions/{run['id']}/identity", {"threadId": thread_id})
    run["threadId"] = thread_id
    return run, socket, rpc, owner.codex_record(run), initialization


async def scenario(directory: Path, *, abrupt: bool) -> dict:
    stderr = (directory.parent / f"{directory.name}.stderr.log").open("wb")
    owner = await Owner.start(directory, stderr)
    sdk = None
    report = {"owner": owner.record, "mode": "abrupt" if abrupt else "graceful", "checks": [], "modelInputs": 0}
    sockets = []
    try:
        sdk = await SDK.start(stderr)
        first, ws_a, rpc_a, pid_a, version = await connected_codex(owner)
        sockets.append(ws_a)
        second, ws_b, rpc_b, pid_b, _ = await connected_codex(owner)
        sockets.append(ws_b)
        claude = await owner.api("/sessions", {"provider": "claude", "qualification": True})
        await sdk.call("open", "claude", url=claude["websocketUrl"])
        worker = await owner.api(f"/api/workers/{claude['workerId']}")
        pid_c = identity(worker["pid"])
        owner.capture_children()
        report.update(codexVersion=version, nativeProcesses={"codexA": pid_a, "codexB": pid_b, "claude": pid_c})
        assert len({pid_a["pid"], pid_b["pid"], pid_c["pid"]}) == 3
        report["checks"].append("Three independent native processes initialized with zero model inputs")
        if abrupt:
            owner.process.kill()
            await owner.process.wait()
            await asyncio.sleep(2)
            survival = {name: alive(value) for name, value in report["nativeProcesses"].items()}
            report["afterKillTwoSeconds"] = survival
            try:
                async with connect(first["websocketUrl"], max_size=None, proxy=None, open_timeout=2):
                    report["publicCodexRelayReachable"] = True
            except Exception:
                report["publicCodexRelayReachable"] = False
            if survival["codexA"]:
                try:
                    native_path = pid_a["backendEndpoint"].removeprefix("unix://")
                    async with unix_connect(native_path, max_size=None, open_timeout=2) as native:
                        await RPC(native).initialize()
                        report["nativeCodexSocketReachable"] = True
                except Exception:
                    report["nativeCodexSocketReachable"] = False
            report["sdkAfterOwnerLoss"] = await sdk.call("status", "claude")
            report["checks"].append("Abrupt owner loss observed by exact PID and separate native/relay endpoints")
        else:
            await ws_a.close()
            assert alive(pid_a)
            async with connect(first["websocketUrl"], max_size=None, proxy=None) as observer:
                read = RPC(observer)
                await read.initialize()
                report["loadedAfterCodexDisconnect"] = await read.call("thread/loaded/list")
                assert first["threadId"] in report["loadedAfterCodexDisconnect"]["data"]
            report["checks"].append("Codex connection close leaves its native server and loaded empty thread alive")
            sdk_closed = await sdk.call("close", "claude")
            assert not sdk_closed["counts"].get("assistant") and not sdk_closed["counts"].get("result")
            report["sdkWithoutInput"] = sdk_closed
            assert await wait_for(lambda: not alive(pid_c))
            worker = await owner.api(f"/api/workers/{claude['workerId']}")
            assert worker["state"] == "stopped"
            report["checks"].append("Claude SDK close ends and reaps its native worker")
            await owner.api(f"/sessions/{first['id']}/end", {})
            assert not alive(pid_a) and alive(pid_b)
            still_loaded = await rpc_b.call("thread/loaded/list")
            assert second["threadId"] in still_loaded["data"]
            report["checks"].append("Ending one owned Codex run leaves the other controllable")
            claude2 = await owner.api("/sessions", {"provider": "claude", "qualification": True})
            await sdk.call("open", "claude2", url=claude2["websocketUrl"])
            worker2 = await owner.api(f"/api/workers/{claude2['workerId']}")
            pid_c2 = identity(worker2["pid"])
            owner.capture_children()
            owner.process.stdin.close()
            await asyncio.wait_for(owner.process.wait(), 25)
            assert owner.process.returncode == 0
            assert await wait_for(lambda: not alive(pid_b) and not alive(pid_c2))
            report["checks"].append("Owner stdin EOF gracefully reaps remaining Codex and Claude processes")
            report["ownerExitCode"] = owner.process.returncode
        report["status"] = "passed"
    except Exception as error:
        report.update(status="failed", failure=f"{type(error).__name__}: {error}")
    finally:
        for socket in sockets:
            await socket.close()
        if sdk is not None:
            await sdk.close()
        report["cleanupSignals"] = await owner.close()
        report["allRecordedChildrenStopped"] = not any(alive(record) for record in owner.children)
        report["removedOwnedSocketFiles"] = cleanup_socket_files(report.get("nativeProcesses", {}))
        stderr.close()
    return report


async def main():
    directory = ARTIFACTS / f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{os.getpid()}"
    directory.mkdir(parents=True)
    reports = []
    for name, abrupt in (("graceful", False), ("abrupt", True)):
        reports.append(await scenario(directory / name, abrupt=abrupt))
        (directory / f"{name}.json").write_text(json.dumps(reports[-1], indent=2) + "\n")
        print(
            json.dumps(
                {
                    "scenario": name,
                    "status": reports[-1]["status"],
                    "checks": len(reports[-1]["checks"]),
                    "failure": reports[-1].get("failure"),
                    "cleanup": reports[-1]["allRecordedChildrenStopped"],
                }
            ),
            flush=True,
        )
    report = {
        "date": datetime.now(UTC).isoformat(),
        "modelInputs": 0,
        "providerInferenceUsd": 0,
        "scenarios": reports,
        "status": "passed" if all(r["status"] == "passed" for r in reports) else "failed",
    }
    version = await asyncio.create_subprocess_exec("claude", "--version", stdout=asyncio.subprocess.PIPE)
    report["claudeVersion"] = (await version.communicate())[0].decode().strip()
    report["nodeSdkVersion"] = "0.3.296 (existing examples/claude-client pin)"
    (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "report": str(directory / "report.json"), "modelInputs": 0}))
    return report


if __name__ == "__main__":
    report = asyncio.run(main())
    raise SystemExit(0 if report["status"] == "passed" else 1)

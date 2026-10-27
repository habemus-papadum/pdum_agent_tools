"""Bounded setup-token qualification using existing launcher APIs and the official SDK."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import socket
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import uvicorn
from pdum.claude_launcher.authentication import AuthSpec, build_environment
from pdum.claude_launcher.management import create_app
from pdum.claude_launcher.profiles import create_profile
from pdum.claude_launcher.runtime import ClaudeManager, LaunchOptions

ROOT = Path(__file__).resolve().parents[3]
STATE = ROOT / "experiments/artifacts/066-claude-setup-token"
HERE = Path(__file__).resolve().parent
INVALID = "spike-066-deliberately-invalid-no-credential"


def token_from(path: Path) -> str:
    """Read one operator-selected credential without logging its contents."""
    value = path.read_text().strip()
    if not value or any(char.isspace() for char in value) or "\x00" in value:
        raise ValueError("Expected one nonempty token without whitespace")
    return value


async def run(args: argparse.Namespace) -> dict:
    """Own isolated profiles, a temporary manager, the probe and cleanup."""
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    directory = STATE / f"{stamp}-{'live' if args.live else 'no-model'}-{os.getpid()}"
    directory.mkdir(parents=True, mode=0o700)
    workspace = directory / "workspace"
    workspace.mkdir()
    original = token_from(args.token_file) if args.live else INVALID
    current = directory / "worker-token.txt"
    current.write_text(original + "\n")
    current.chmod(0o600)
    profiles = {
        name: create_profile(
            directory / name,
            workspace=workspace,
            model="haiku",
            auth=AuthSpec("native"),
            setting_sources=("user",),
        )
        for name in ("profile-a", "profile-b")
    }
    for name, profile in profiles.items():
        commands = profile.config_directory / "commands"
        commands.mkdir()
        (commands / f"spike-{name}.md").write_text(f"This command identifies only {name}.\n")

    class ReferencedTokenManager(ClaudeManager):
        async def allocate(self, profile_id, *, resume=None, options=None):
            # This experiment resolves the reference at allocation. The existing
            # library carries the resolved environment to its native child.
            supplied = options or LaunchOptions()
            supplied = replace(supplied, environment={"CLAUDE_CODE_OAUTH_TOKEN": token_from(current)})
            return await super().allocate(profile_id, resume=resume, options=supplied)

    manager = ReferencedTokenManager(profiles)
    app = create_app(manager)
    mode = "original" if args.live else "invalid"

    @app.post("/spike/token-mode")
    async def token_mode(body: dict):
        nonlocal mode
        requested = body.get("mode")
        if requested not in {"original", "invalid"}:
            return {"error": "Choose original or invalid"}
        mode = requested
        current.write_text((original if mode == "original" else INVALID) + "\n")
        return {"mode": mode, "effect": "Only later allocations resolve the changed reference"}

    @app.get("/spike/native-status")
    async def native_status():
        profile = profiles["profile-a"]
        environment = await build_environment(profile, authenticate=False)
        environment["CLAUDE_CODE_OAUTH_TOKEN"] = token_from(current)
        process = await asyncio.create_subprocess_exec(
            "claude",
            "--setting-sources",
            "user",
            "auth",
            "status",
            "--json",
            cwd=workspace,
            env=environment,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), 15)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.communicate()
            raise
        value = json.loads(stdout)
        return {key: value.get(key) for key in ("loggedIn", "authMethod", "apiProvider")} | {
            "exitCode": process.returncode,
            "configMatches": value.get("configDirectory") == str(profile.config_directory),
            "mode": mode,
        }

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    child = None
    report = {"startedAt": datetime.now(UTC).isoformat(), "live": args.live, "status": "failed"}
    try:
        while not server.started:
            if serving.done():
                await serving
                raise RuntimeError("Probe server did not start")
            await asyncio.sleep(0.02)
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("CLAUDE_", "CLAUDECODE", "ANTHROPIC_"))
        }
        child = await asyncio.create_subprocess_exec(
            "node",
            str(HERE / "probe.mjs"),
            f"http://127.0.0.1:{port}",
            *(["--live"] if args.live else []),
            cwd=HERE,
            env=environment,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        output, errors = await asyncio.wait_for(child.communicate(), 330)
        # Only the SDK report is serialized. Child output is kept out of console
        # if parsing fails; this avoids accidentally printing token-bearing errors.
        if output:
            report.update(json.loads(output))
        report["probeExitCode"] = child.returncode
        report["clientStderrBytes"] = len(errors)
        if child.returncode:
            report["status"] = "failed"
    except Exception as error:
        report["failureType"] = type(error).__name__
    finally:
        if child is not None and child.returncode is None:
            child.kill()
            await child.communicate()
        await manager.aclose()
        report["workersAfterCleanup"] = manager.list_workers()
        report["allWorkersStopped"] = all(row["state"] == "stopped" for row in report["workersAfterCleanup"])
        server.should_exit = True
        await serving
        listener.close()
        current.unlink(missing_ok=True)
    report["tokenSource"] = "operator setup-token file" if args.live else "deliberately invalid marker; no inference"
    report["endedAt"] = datetime.now(UTC).isoformat()
    report["sourceTokenUntouched"] = not args.live or token_from(args.token_file) == original
    report["profileCredentialFiles"] = {
        name: (profile.config_directory / ".credentials.json").exists() for name, profile in profiles.items()
    }
    report["profiles"] = {name: str(profile.config_directory) for name, profile in profiles.items()}
    version = await asyncio.create_subprocess_exec("claude", "--version", stdout=asyncio.subprocess.PIPE)
    report["claudeVersion"] = (await version.communicate())[0].decode().strip()
    report["claudeExecutable"] = shutil.which("claude")
    report_path = directory / "report.json"
    serialized = json.dumps(report, indent=2).replace(original, "[credential omitted]")
    report_path.write_text(serialized + "\n")
    print(
        json.dumps(
            {
                "status": report["status"],
                "report": str(report_path),
                "requests": report.get("submittedTurns", 0),
                "reportedCostUpperBoundUsd": report.get("reportedCostUpperBoundUsd"),
                "allWorkersStopped": report["allWorkersStopped"],
            }
        )
    )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Submit at most four tiny Haiku inputs")
    parser.add_argument("--token-file", type=Path, default=STATE / "setup-token.txt")
    result = asyncio.run(run(parser.parse_args()))
    raise SystemExit(0 if result["status"] == "passed" and result["allWorkersStopped"] else 1)

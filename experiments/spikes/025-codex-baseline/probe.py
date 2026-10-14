"""Export versioned native schemas and test the experimental handshake, without inference."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KINDS = ("ClientRequest", "ClientNotification", "ServerRequest", "ServerNotification")


def command(args: list[str], **kwargs) -> str:
    return subprocess.check_output(args, text=True, timeout=90, **kwargs).strip()


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def methods(directory: Path) -> dict:
    result = {}
    for kind in KINDS:
        schema = json.loads((directory / f"{kind}.json").read_text())
        for variant in schema["oneOf"]:
            method = variant["properties"]["method"]
            name = method.get("const") or method["enum"][0]
            params = variant["properties"].get("params", {})
            if "$ref" in params:
                params = schema["definitions"][params["$ref"].split("/")[-1]]
            result[name] = {"kind": kind, "fields": sorted(params.get("properties", {}))}
    return result


async def runtime(binary: Path, env: dict, work: Path, experimental: bool) -> dict:
    settings = [
        'cli_auth_credentials_store="file"',
        'approval_policy="never"',
        'sandbox_mode="danger-full-access"',
        "analytics.enabled=false",
        "feedback.enabled=false",
        "features.apps=false",
        "features.plugins=false",
        "skills.bundled.enabled=false",
    ]
    child = await asyncio.create_subprocess_exec(
        str(binary),
        "app-server",
        "--listen",
        "stdio://",
        *[part for setting in settings for part in ("-c", setting)],
        env=env,
        cwd=work,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert child.stdin and child.stdout and child.stderr
    stderr_task = asyncio.create_task(child.stderr.read())
    events = []

    async def request(identifier: int, method: str, params: dict) -> dict:
        child.stdin.write((json.dumps({"id": identifier, "method": method, "params": params}) + "\n").encode())
        await child.stdin.drain()
        async with asyncio.timeout(15):
            while True:
                line = await child.stdout.readline()
                if not line:
                    raise RuntimeError("App-server exited before reply")
                message = json.loads(line)
                events.append(message)
                if message.get("id") == identifier and "method" not in message:
                    return message

    try:
        initialized = await request(
            1,
            "initialize",
            {
                "clientInfo": {"name": "spike025", "version": "0.0.0"},
                "capabilities": {"experimentalApi": experimental},
            },
        )
        child.stdin.write(b'{"method":"initialized","params":{}}\n')
        before = await request(2, "thread/list", {})
        process = await request(
            3,
            "process/spawn",
            {
                "processHandle": "baseline",
                "command": ["/usr/bin/printf", "BASELINE_OK"],
                "cwd": str(work),
                "streamStdoutStderr": True,
            },
        )
        if "result" in process:
            async with asyncio.timeout(10):
                while not any(x.get("method") == "process/exited" for x in events):
                    events.append(json.loads(await child.stdout.readline()))
        after = await request(4, "thread/list", {})
        assert before["result"]["data"] == after["result"]["data"] == []
        assert ("result" in process) == experimental
        return {
            "experimental": experimental,
            "initialize": initialized,
            "process": process,
            "events": events,
            "thread_count": 0,
        }
    finally:
        child.stdin.close()
        try:
            await asyncio.wait_for(child.wait(), 5)
        except TimeoutError:
            child.kill()
            await child.wait()
        await stderr_task


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=Path.home() / ".local/bin/codex")
    parser.add_argument("--label", default="installed")
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    out = ROOT / "artifacts/025-codex-baseline" / f"{args.label}-{time.time_ns()}"
    out.mkdir(parents=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="pdum-spike025-") as temporary:
        work = Path(temporary)
        home = work / "home"
        codex_home = home / ".codex"
        codex_home.mkdir(parents=True)
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(home),
            "CODEX_HOME": str(codex_home),
            "TMPDIR": temporary,
        }
        metadata = {
            "binary": str(binary),
            "sha256": digest(binary),
            "version": command([str(binary), "--version"], env=env, cwd=work),
            "source_revision": command(["git", "-C", str(ROOT / "vendor/codex"), "rev-parse", "HEAD"]),
            "source_dirty": command(["git", "-C", str(ROOT / "vendor/codex"), "status", "--porcelain"]),
            "release_source": command(["git", "-C", str(ROOT / "vendor/codex"), "rev-parse", "rust-v0.162.1^{commit}"]),
            "platform": platform.platform(),
            "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "label": args.label,
            "model_calls": 0,
        }
        exports = {}
        for experimental in (False, True):
            surface = "experimental" if experimental else "stable"
            destination = out / f"schema-{surface}"
            command(
                [
                    str(binary),
                    "app-server",
                    "generate-json-schema",
                    "--out",
                    str(destination),
                    *(["--experimental"] if experimental else []),
                ],
                env=env,
                cwd=work,
            )
            command(
                [
                    str(binary),
                    "app-server",
                    "generate-ts",
                    "--out",
                    str(out / f"types-{surface}"),
                    *(["--experimental"] if experimental else []),
                ],
                env=env,
                cwd=work,
            )
            exports[surface] = methods(destination)
        previous = json.loads((ROOT / "apps/web/public/protocol-inventory.json").read_text())
        previous_methods = {
            item["method"]: {"kind": item["kind"], "fields": sorted(f["name"] for f in item["fields"])}
            for item in previous["inventory"]
        }
        current = exports["experimental"]
        metadata["inventory_diff"] = {
            "added": sorted(current.keys() - previous_methods.keys()),
            "removed": sorted(previous_methods.keys() - current.keys()),
            "changed": {
                key: {"previous": previous_methods[key], "current": current[key]}
                for key in current.keys() & previous_methods.keys()
                if current[key] != previous_methods[key]
            },
        }
        metadata["counts"] = {
            surface: {kind: sum(x["kind"] == kind for x in entries.values()) for kind in KINDS}
            for surface, entries in exports.items()
        }
        metadata["schema_hashes"] = {
            str(path.relative_to(out)): digest(path) for path in sorted(out.glob("schema-*/*.json"))
        }
        metadata["runtime"] = [asyncio.run(runtime(binary, env, work, enabled)) for enabled in (False, True)]
        (out / "inventory.json").write_text(json.dumps(exports, indent=2) + "\n")
        (out / "result.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(
        json.dumps(
            {
                "artifacts": str(out),
                "version": metadata["version"],
                "sha256": metadata["sha256"],
                "counts": metadata["counts"],
                "inventory_diff": metadata["inventory_diff"],
                "runtime_passed": True,
                "model_calls": 0,
            }
        )
    )


if __name__ == "__main__":
    main()

"""One native CLI request to distinguish token rejection from SDK/relay behavior."""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import UTC, datetime

from pdum.claude_launcher.authentication import AuthSpec, build_environment
from pdum.claude_launcher.profiles import create_profile
from run import STATE, token_from


async def main() -> dict:
    """Submit one small direct Haiku request with the same supplied token."""
    token_file = STATE / "setup-token.txt"
    token = token_from(token_file)
    directory = STATE / f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-direct-{os.getpid()}"
    directory.mkdir(parents=True, mode=0o700)
    workspace = directory / "workspace"
    workspace.mkdir()
    profile = create_profile(directory / "profile", workspace=workspace, setting_sources=(), auth=AuthSpec("native"))
    environment = await build_environment(profile, authenticate=False)
    environment["CLAUDE_CODE_OAUTH_TOKEN"] = token
    process = await asyncio.create_subprocess_exec(
        "claude",
        "--print",
        "--model",
        "haiku",
        "--tools",
        "",
        "--max-turns",
        "1",
        "--max-budget-usd",
        "0.03",
        "--setting-sources",
        "",
        "--output-format",
        "json",
        "Reply exactly DIRECT_SETUP_TOKEN_OK. Do not use tools.",
        cwd=workspace,
        env=environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 60)
        value = json.loads(stdout)
        native_text = str(value.get("result", "")).replace(token, "[credential omitted]")
        native_text = re.sub(r"sk-ant-[A-Za-z0-9_-]+", "[credential omitted]", native_text)
        report = {key: value.get(key) for key in ("subtype", "is_error", "total_cost_usd", "usage", "modelUsage")}
        report.update(
            status="passed"
            if not value.get("is_error") and native_text.strip() == "DIRECT_SETUP_TOKEN_OK"
            else "failed",
            result=native_text,
            exitCode=process.returncode,
            stderrBytes=len(stderr),
            submittedTurns=1,
        )
    except Exception as error:
        report = {"status": "failed", "failureType": type(error).__name__, "submittedTurns": 1, "costUnknown": True}
    finally:
        if process.returncode is None:
            process.kill()
            await process.communicate()
    report["sourceTokenUntouched"] = token_from(token_file) == token
    report_path = directory / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(report_path), **report}))
    return report


if __name__ == "__main__":
    result = asyncio.run(main())
    raise SystemExit(0 if result["status"] == "passed" else 1)

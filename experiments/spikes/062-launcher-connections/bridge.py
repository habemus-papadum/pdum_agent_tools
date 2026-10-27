"""Disposable 062/063 adapter over the existing launcher libraries.

JSON on stdin/stdout. Profile writes are confined to the caller's explicit lab
root; source discovery and inspection never mutate an ordinary profile.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import re
import sys
import time
import tomllib
from pathlib import Path

from pdum.claude_launcher import profiles as claude
from pdum.claude_launcher.authentication import AuthSpec
from pdum.codex_launcher import profiles as codex
from pdum.codex_launcher.config import atomic_write
from pdum.codex_launcher.inspection import inspect_home
from pdum.codex_launcher.layout import default_codex_home

REPO = Path(__file__).resolve().parents[3]
LAB = Path(os.environ.get("PDUM_PROFILE_LAB_DIR", REPO / "experiments/artifacts/063-profile-workbench")).resolve()


def native_path(provider: str, path: Path) -> Path:
    return path / ("config.toml" if provider == "codex" else "claude/settings.json")


def editable(provider: str, path: Path) -> bool:
    root = (LAB / "profiles" / provider).resolve()
    return path.parent == root and not path.is_symlink()


def model_of(path: Path) -> str | None:
    try:
        return tomllib.loads((path / "config.toml").read_text()).get("model")
    except (OSError, ValueError):
        return None


async def describe(provider: str, path: Path, *, origin: str = "selected") -> dict:
    path = path.expanduser().resolve()
    value = {
        "id": f"{provider}:{path}",
        "provider": provider,
        "path": str(path),
        "name": path.name,
        "origin": origin,
        "editable": editable(provider, path),
        "nativePath": str(native_path(provider, path)),
    }
    try:
        if provider == "codex":
            item = await codex.inspect_profile(path)
            value.update(
                model=model_of(path),
                executable=str(item.executable),
                managed=item.managed,
                isolated=item.isolate,
                authEvidence="auth.json present" if item.auth_file_present else "No auth.json observed",
                workspace=None,
                error=item.error,
            )
        elif provider == "claude":
            item = claude.load_profile(path)
            value.update(
                model=item.model,
                executable=item.executable,
                managed=True,
                isolated=True,
                authEvidence=f"Configured: {item.auth.method} (not validated)",
                workspace=str(item.workspace),
                settingSources=list(item.setting_sources),
                error=None,
            )
        else:
            raise ValueError("Provider must be codex or claude")
    except Exception as error:
        value["error"] = str(error)
    return value


async def inventory() -> dict:
    rows = []
    seen = set()
    roots = [
        ("codex", codex.default_profiles_directory()),
        ("claude", claude.default_profiles_directory()),
        ("codex", LAB / "profiles/codex"),
        ("claude", LAB / "profiles/claude"),
    ]
    candidates = [("codex", default_codex_home(), "ordinary")]
    for provider, root in roots:
        if root.is_dir():
            for path in sorted(root.iterdir()):
                marker = path / (".pdum/launcher.toml" if provider == "codex" else "profile.json")
                if marker.is_file():
                    candidates.append((provider, path, "lab" if root.is_relative_to(LAB) else "named"))
    for provider, path, origin in candidates:
        key = (provider, str(path.resolve()))
        if key in seen or not path.is_dir():
            continue
        seen.add(key)
        rows.append(await describe(provider, path, origin=origin))
    return {
        "host": platform.node(),
        "observedAt": time.time(),
        "labRoot": str(LAB),
        "profiles": rows,
        "roots": [{"provider": p, "path": str(r), "exists": r.exists()} for p, r in roots],
        "capabilities": {
            "coordinator": False,
            "localInspection": True,
            "profileWrites": "lab only",
            "claudeGlobalWorkerDiscovery": False,
        },
    }


async def main(args: dict) -> dict:
    operation = args.get("operation", "inventory")
    if operation == "inventory":
        return await inventory()
    provider = args.get("provider")
    if provider not in {"codex", "claude"}:
        raise ValueError("Choose codex or claude")
    path = Path(args.get("path") or "/nonexistent").expanduser().resolve()
    if operation == "inspect":
        summary = await describe(provider, path)
        if summary.get("error"):
            raise ValueError(summary["error"])
        if provider == "codex":
            observed = await inspect_home(path, probe_daemon=False)
            # The native report can include private run metadata. Expose the
            # observations useful to this study rather than environment dumps.
            return {
                "profile": summary,
                "observedAt": observed["inspected_at"],
                "processes": observed["processes"],
                "processSummary": observed["process_summary"],
                "runs": [
                    {k: r.get(k) for k in ("run_id", "live", "server_alive", "owner_alive", "started_at", "ended_at")}
                    for r in observed["runs"]
                ],
                "databases": observed["databases"],
                "writers": observed["thread_writer_locks"],
                "warnings": observed["warnings"],
                "scope": "Processes using this Codex home; no daemon probe or thread subscription",
            }
        return {
            "profile": summary,
            "observedAt": time.time(),
            "processes": None,
            "runs": None,
            "scope": (
                "Profile metadata only. Claude workers are owned by individual managers; "
                "connect to one to list its workers."
            ),
            "warnings": [],
        }
    if operation == "read":
        summary = await describe(provider, path)
        if summary.get("error"):
            raise ValueError(summary["error"])
        file = native_path(provider, path)
        content = file.read_text() if file.exists() else ("" if provider == "codex" else "{}\n")
        return {
            "profile": summary,
            "text": content,
            "revision": hashlib.sha256(content.encode()).hexdigest(),
            "format": "toml" if provider == "codex" else "json",
            "observedAt": time.time(),
        }
    if operation == "create":
        name = str(args.get("name", ""))
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name):
            raise ValueError("Use 1–64 letters, digits, dots, underscores or hyphens")
        path = LAB / "profiles" / provider / name
        source = Path(args["source"]).expanduser().resolve() if args.get("source") else None
        model = str(args.get("model") or ("gpt-6-luna" if provider == "codex" else "haiku"))
        if provider == "codex":
            result = await codex.create_profile(
                path, codex.ProfileSpec(source=source, model=model, copy_auth=False, copy_skills=False)
            )
            warnings = list(result.warnings)
        else:
            base = claude.load_profile(source) if source else None
            workspace = Path(args.get("workspace") or (base.workspace if base else REPO)).expanduser().resolve()
            claude.create_profile(
                path,
                workspace=workspace,
                model=model,
                executable=base.executable if base else "claude",
                setting_sources=base.setting_sources if base else ("user", "project"),
                auth=AuthSpec("api-key", "ANTHROPIC_API_KEY"),
                native_settings=native_path(provider, source) if source else None,
            )
            warnings = ["Copied native settings only; credentials and histories were not copied."] if source else []
        return {
            "profile": await describe(provider, path, origin="lab"),
            "warnings": warnings,
            "effect": "Created a real local profile. No worker or login was started.",
        }
    if operation == "save":
        if not editable(provider, path):
            raise ValueError("This study edits only profiles created inside its lab directory. Make a lab copy first.")
        file = native_path(provider, path)
        if file.is_symlink():
            raise ValueError("Native config must be an ordinary file")
        content = str(args.get("text", ""))
        parsed = tomllib.loads(content) if provider == "codex" else json.loads(content)
        if not isinstance(parsed, dict):
            raise ValueError("Native configuration must be an object/table")
        current = file.read_text() if file.exists() else ("" if provider == "codex" else "{}\n")
        if args.get("revision") != hashlib.sha256(current.encode()).hexdigest():
            raise ValueError("The file changed since it was loaded. Reload before saving.")
        atomic_write(file, content)
        return {
            "profile": await describe(provider, path, origin="lab"),
            "revision": hashlib.sha256(content.encode()).hexdigest(),
            "effect": "Saved native configuration. No existing worker was changed or restarted.",
        }
    raise ValueError("Unknown operation")


if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(main(json.load(sys.stdin)))))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)

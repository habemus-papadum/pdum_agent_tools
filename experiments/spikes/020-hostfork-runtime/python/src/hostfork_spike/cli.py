"""Small mountable CLI over the experimental async library."""

import asyncio
import dataclasses
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from .runtime import Environment, EnvironmentSpec, Export, Mount, status_at, stop_at

console = Console(stderr=True)


def doctor_report() -> dict:
    """Probe this host without changing system configuration."""
    knobs = {}
    for name in (
        "kernel/unprivileged_userns_clone",
        "kernel/apparmor_restrict_unprivileged_userns",
        "user/max_user_namespaces",
        "user/max_mnt_namespaces",
        "user/max_pid_namespaces",
    ):
        path = Path("/proc/sys") / name
        knobs[name.replace("/", ".")] = path.read_text().strip() if path.exists() else None
    try:
        probe = subprocess.run(
            ["unshare", "--user", "--map-current-user", "--mount", "--pid", "--fork", "--mount-proc", "true"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        namespaces = {"ok": probe.returncode == 0, "stderr": probe.stderr.strip()}
    except (OSError, subprocess.TimeoutExpired) as exc:
        namespaces = {"ok": False, "error": str(exc)}
    cgroup = next(
        (line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::")), None
    )
    cgpath = Path("/sys/fs/cgroup") / cgroup.lstrip("/") if cgroup else None
    return {
        "kernel": platform.release(),
        "python": platform.python_version(),
        "uid": os.getuid(),
        "namespace_probe": namespaces,
        "sysctls": knobs,
        "cgroup_v2": cgroup,
        "current_cgroup_writable": bool(cgpath and os.access(cgpath / "cgroup.procs", os.W_OK)),
        "tools": {name: shutil.which(name) for name in ("unshare", "btrfs", "mkfs.btrfs", "systemd-run")},
        "notes": [
            "An actual namespace probe is more useful than sysctl values alone.",
            "Btrfs is optional; prepared snapshots can be supplied with --bind.",
            "The runtime does not enforce resource limits; spike 023 tests an external systemd cgroup owner.",
        ],
    }


def _pair(value: str, label: str) -> tuple[str, str]:
    if "=" not in value:
        raise typer.BadParameter(f"{label} requires SOURCE=DESTINATION")
    return tuple(value.split("=", 1))


def create_app() -> typer.Typer:
    """Create a mountable CLI without launching processes or installing handlers."""
    application = typer.Typer(help="Host-derived Linux environments for research. Trusted use; no security boundary.")

    @application.command()
    def doctor() -> None:
        """Check namespace capability and report host prerequisites as JSON."""
        report = doctor_report()
        typer.echo(json.dumps(report, indent=2))
        if not report["namespace_probe"]["ok"]:
            raise typer.Exit(1)

    @application.command()
    def status(path: Path) -> None:
        """Inspect a live environment or its durable evidence after it dies."""
        typer.echo(json.dumps(asyncio.run(status_at(path)), indent=2))

    @application.command()
    def stop(path: Path, reason: str = "external_stop") -> None:
        """Stop an environment, including recovery after supervisor loss."""
        typer.echo(json.dumps(asyncio.run(stop_at(path, reason=reason)), indent=2))

    @application.command()
    def reap(root: Path, older_than: Annotated[float, typer.Option(min=0)] = 1200) -> None:
        """Stop recorded environments older than N seconds; retain their artifacts."""
        import time

        async def reap_all() -> list[dict]:
            results = []
            for path in sorted(root.glob("env-*")):
                config = path / "config.json"
                if not config.is_file() or time.time() - config.stat().st_mtime < older_than:
                    continue
                try:
                    before = await status_at(path)
                    if before["state"] in ("closed", "failed") and before.get("cleanup", {}).get("namespace_released"):
                        continue
                    after = await stop_at(path, reason="external_age_reap")
                    results.append({"path": str(path), "state": after["state"], "reason": after.get("reason")})
                except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
                    results.append({"path": str(path), "error": str(exc)})
            return results

        typer.echo(json.dumps(asyncio.run(reap_all()), indent=2))

    @application.command(context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
    def run(
        command: Annotated[list[str] | None, typer.Argument(help="Command after --; defaults to /bin/bash -i.")] = None,
        overlay: Annotated[
            list[Path] | None, typer.Option(help="Private OverlayFS writes at an existing directory.")
        ] = None,
        read_only: Annotated[
            list[Path] | None, typer.Option(help="Read-only bind; does not include nested mounts.")
        ] = None,
        fresh: Annotated[
            list[Path] | None, typer.Option(help="Empty private directory mounted at this host path.")
        ] = None,
        bind: Annotated[list[str] | None, typer.Option(help="SOURCE=TARGET, e.g. prepared Btrfs snapshot.")] = None,
        export: Annotated[
            list[str] | None, typer.Option(help="SOURCE=RELATIVE_DEST copied at orderly teardown.")
        ] = None,
        deadline: Annotated[
            float | None, typer.Option(min=0.01, help="Seconds from supervisor start; includes setup.")
        ] = None,
        detach: Annotated[
            bool, typer.Option(help="Return after spawn; retain until deadline or external stop.")
        ] = False,
        retain: Annotated[bool, typer.Option(help="Keep environment after command exits; requires deadline.")] = False,
        logs: Annotated[
            bool, typer.Option(help="Write stdout/stderr to artifacts instead of the current terminal.")
        ] = False,
        cwd: Path | None = None,
        artifacts: Path = Path("artifacts/hostfork-runtime"),
        plan: Annotated[bool, typer.Option(help="Print configuration without creating an environment.")] = False,
    ) -> None:
        """Run a command or enter bash with selected mount substitutions.

        Paths without substitutions remain host paths. Commands share host
        networking and IPC, and use a private PID namespace. Existing terminals
        can be inherited; allocation/attachment of a new PTY is not implemented.
        """
        mounts = [
            Mount(kind, str(path.absolute()))
            for kind, paths in (("overlay", overlay), ("read_only", read_only), ("fresh", fresh))
            for path in paths or []
        ]
        for value in bind or []:
            source, target = _pair(value, "--bind")
            mounts.append(Mount("bind", str(Path(target).absolute()), str(Path(source).absolute())))
        exports = [
            Export(str(Path(source).absolute()), destination)
            for source, destination in (_pair(value, "--export") for value in export or [])
        ]
        spec = EnvironmentSpec(
            mounts=mounts, exports=exports, deadline_seconds=deadline, retain_on_owner_exit=detach or retain
        )
        argv = command or ["/bin/bash", "-i"]
        if (detach or retain) and deadline is None:
            raise typer.BadParameter("--detach and --retain require --deadline in this spike")
        if plan:
            typer.echo(
                json.dumps(
                    {
                        "spec": dataclasses.asdict(spec),
                        "command": argv,
                        "cwd": str(cwd) if cwd else None,
                        "inherited_host_mounts": True,
                    },
                    indent=2,
                )
            )
            return

        async def execute() -> int:
            environment = await Environment.create(spec, artifact_root=artifacts, inherit_stdio=not (logs or detach))
            console.print(f"Environment: {environment.path}", markup=False, soft_wrap=True)
            try:
                process = await environment.spawn(
                    argv, cwd=str(cwd.absolute()) if cwd else None, stdio="logs" if logs or detach else "inherit"
                )
                if detach:
                    environment.detach()
                    return 0
                result = await process.wait()
                state = await environment.status()
                if state.get("reason") == "deadline":
                    return 124
                rc = result.get("returncode")
                return (128 - rc if rc < 0 else rc) if rc is not None else 125
            finally:
                if retain or detach:
                    environment.detach()
                else:
                    await environment.close(reason="command_finished")

        try:
            returncode = asyncio.run(execute())
        except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
            console.print(str(exc), style="red", markup=False)
            raise typer.Exit(125) from exc
        raise typer.Exit(returncode)

    return application


app = create_app()

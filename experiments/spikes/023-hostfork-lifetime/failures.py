"""Real namespace failures with persistent reports and explicit cleanup assertions."""

import argparse
import asyncio
import json
import os
import signal
import sys
import time
import uuid
from pathlib import Path

from hostfork_spike import Environment, EnvironmentSpec, Export, Mount, status_at, stop_at
from hostfork_spike.linux import alive, identity, signal_verified

HERE = Path(__file__).resolve().parent


def members(state: dict) -> list[dict]:
    """Capture host process identities belonging to this exact PID namespace."""
    namespace = os.readlink(f"/proc/{state['namespace_init_pid']}/ns/pid")
    found = []
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            if os.readlink(path / "ns/pid") == namespace:
                found.append(identity(int(path.name)))
        except (OSError, ProcessLookupError):
            pass
    return found


async def settled(path: Path) -> dict:
    until = time.monotonic() + 9
    while time.monotonic() < until:
        state = await status_at(path)
        if state["state"] in ("closed", "failed", "lost") and not alive(state.get("namespace_init_identity")):
            return state
        await asyncio.sleep(0.03)
    raise TimeoutError(f"Environment failed to stop: {path}")


async def run_case(root: Path, case: str) -> dict:
    case_root = root / case
    case_root.mkdir()
    source = case_root / "source"
    source.mkdir()
    (source / "baseline.txt").write_text("host original\n")
    started = time.monotonic()
    owner = None
    environment = None
    path = None
    captured = []
    command_results = []
    try:
        if case in ("owner_sigkill", "retained_owner_sigkill"):
            with (
                (case_root / "owner.stdout.log").open("wb") as stdout,
                (case_root / "owner.stderr.log").open("wb") as stderr,
            ):
                owner = await asyncio.create_subprocess_exec(
                    sys.executable,
                    str(HERE / "owner.py"),
                    str(case_root),
                    *(["--retain"] if case.startswith("retained") else []),
                    stdout=stdout,
                    stderr=stderr,
                )
            until = time.monotonic() + 10
            while not (case_root / "owner.json").exists():
                if time.monotonic() > until or owner.returncode is not None:
                    raise RuntimeError("Owner failed to create environment")
                await asyncio.sleep(0.01)
            path = Path(json.loads((case_root / "owner.json").read_text())["path"])
            await asyncio.sleep(0.15)
            captured = members(await status_at(path))
            owner.kill()
            await owner.wait()
            if case.startswith("retained"):
                await asyncio.sleep(0.15)
                assert (await status_at(path))["state"] == "running"
        else:
            environment = await Environment.create(
                EnvironmentSpec(
                    mounts=[Mount("overlay", str(source))],
                    deadline_seconds=0.8 if case == "deadline" else 8,
                    exports=[Export(str(source), "workspace")],
                ),
                artifact_root=case_root / "environments",
            )
            path = environment.path
            if case == "command_outcomes":
                for code in (
                    "print('ok')",
                    "import sys; sys.exit(7)",
                    "import os, signal; os.kill(os.getpid(), signal.SIGUSR1)",
                ):
                    command_results.append(await environment.run([sys.executable, "-c", code]))
                assert [item["returncode"] for item in command_results] == [0, 7, -signal.SIGUSR1]
                await environment.close("command_outcomes_observed")
            else:
                await environment.spawn([sys.executable, str(HERE / "workload.py"), "tree", str(source)])
                await environment.spawn(["/bin/sleep", "60"])
                await asyncio.sleep(0.15)
                state = await environment.status()
                captured = members(state)
                assert len(captured) >= 4, captured
                if case == "supervisor_sigkill":
                    signal_verified(state["supervisor_identity"], signal.SIGKILL)
                elif case == "init_sigkill":
                    signal_verified(state["namespace_init_identity"], signal.SIGKILL)
                elif case == "external_stop":
                    await stop_at(path, "external_reaper")
        state = await settled(path)
        await asyncio.sleep(0.05)
        survivors = [item for item in captured if alive(item)]
        assert not survivors, survivors
        assert not list(source.glob("*.partial")), "Private writes escaped to source"
        assert (source / "baseline.txt").read_text() == "host original\n"
        assert {p.name for p in source.iterdir()} == {"baseline.txt"}
        final = path / "init-final.json"
        result = {
            "case": case,
            "elapsed_seconds": time.monotonic() - started,
            "environment_path": str(path),
            "state": state,
            "command_results": command_results,
            "observed_namespace_members": len(captured),
            "survivors": survivors,
            "partial_exports": [str(p.relative_to(path)) for p in (path / "exports").rglob("*.partial")],
            "partial_upper_files": [
                str(p.relative_to(path)) for p in path.rglob("*.partial") if "exports" not in p.parts
            ],
            "init_final_present": final.exists(),
            "log_bytes": sum(p.stat().st_size for p in path.rglob("*.log")),
            "host_source_unchanged": True,
        }
        if case in ("deadline", "retained_owner_sigkill"):
            assert state["reason"] == "deadline", result
        if case == "init_sigkill":
            assert not final.exists() and result["partial_upper_files"], result
        elif case != "command_outcomes":
            assert len(result["partial_exports"]) == 2, result
        for relative in result["partial_exports"] + result["partial_upper_files"]:
            assert (path / relative).stat().st_size > 0, relative
        assert result["log_bytes"] > 0, result
        return result
    finally:
        if owner and owner.returncode is None:
            owner.kill()
            await owner.wait()
        if path:
            await stop_at(path, "test_finally")
        if environment:
            environment.detach()
            await environment._helper.wait()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/hostfork-lifetime"))
    args = parser.parse_args()
    root = args.output.resolve() / ("failures-" + uuid.uuid4().hex[:10])
    root.mkdir(parents=True)
    results = []
    for case in (
        "command_outcomes",
        "deadline",
        "external_stop",
        "owner_sigkill",
        "retained_owner_sigkill",
        "supervisor_sigkill",
        "init_sigkill",
    ):
        try:
            result = await run_case(root, case)
        except Exception as error:
            results.append(
                {"case": case, "error": f"{type(error).__name__}: {error}", "artifact_directory": str(root / case)}
            )
            (root / "results.json").write_text(json.dumps({"results": results}, indent=2) + "\n")
            raise
        results.append(result)
        (root / "results.json").write_text(json.dumps({"results": results}, indent=2) + "\n")
        print(f"{case}: {result['state']['reason']}, {result['elapsed_seconds']:.3f}s", flush=True)
    print(root)


if __name__ == "__main__":
    asyncio.run(main())

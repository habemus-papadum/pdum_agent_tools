"""Public lifecycle objects; process ownership and filesystem retention are separate."""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from .errors import EnvironmentClosed, UnsupportedCapability
from .models import CommandResult, EnvironmentSpec, Plan, WorkspaceView, json_value, seconds
from .planner import absolute, make_plan
from .store import Store, path_identity


async def finish(awaitable):
    """Finish resource cleanup even when the surrounding task is cancelled again."""
    task = asyncio.ensure_future(awaitable)
    while True:
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.done():
                return task.result()


def owner_identity() -> dict:
    if sys.platform != "linux":
        raise UnsupportedCapability("Execution currently requires Linux")
    from .backends.linux._syscalls import identity

    return identity(os.getpid())


def owner_alive(value: dict | None) -> bool:
    if not value:
        return False
    from .backends.linux._syscalls import alive

    return alive(value)


class Hostfork:
    """Application-owned access to a persistent local environment registry.

    Parameters
    ----------
    root
        Durable state/evidence root, outside paths replaced in a HostView.
    pools
        Named allocation directories, including prepared Btrfs directories.
        The default pool is ``root / 'trees'`` unless explicitly overridden.
    """

    def __init__(self, root: str | Path, *, pools: dict[str, str | Path] | None = None):
        self.store = Store(root)
        self.pools = {name: Path(path).expanduser().resolve() for name, path in (pools or {}).items()}
        self._environments: dict[str, Environment] = {}

    async def plan(self, spec: EnvironmentSpec) -> Plan:
        """Resolve paths and storage prerequisites without allocating resources."""
        return await make_plan(spec, self.store, self.pools)

    async def register_baseline(
        self, name: str, path: str | Path, *, storage: str = "copy", stable: bool = True
    ) -> dict:
        """Register an existing borrowed input; never prepare or delete it."""
        from . import storage as trees

        source = absolute(path).resolve()
        validation = await trees.validate_source(storage, source, stable=stable)
        return self.store.register_baseline(
            name,
            {
                "path": str(source),
                "storage": storage,
                "stable": stable,
                "identity": path_identity(source),
                "validation": validation,
            },
        )

    async def create(self, spec: EnvironmentSpec) -> Environment:
        """Allocate trees and start a reusable environment, retaining failed setup evidence."""
        from . import storage

        plan = await self.plan(spec)
        if not plan.supported:
            raise UnsupportedCapability("; ".join(plan.errors))
        from .backends.linux import LinuxRuntime

        record = self.store.create_environment(plan.to_dict())
        environment_id = record["id"]
        run = self.store.run_path(environment_id)
        runtime = None
        self.store.update_environment(environment_id, operation_owner=owner_identity())
        try:
            async with self.store.lock(environment_id), asyncio.timeout(seconds(spec.lifetime.setup_timeout)):
                allocations: dict[str, dict] = {}
                for name, tree in plan.trees.items():
                    if tree["source"] and path_identity(Path(tree["source"])) != tree["source_identity"]:
                        raise ValueError(f"Source identity changed before allocation: {name}")
                    resource = self.store.reserve_resource(
                        environment_id,
                        name=name,
                        kind=tree["kind"],
                        pool=plan.storage_roots[tree["pool"]],
                        source=tree["source"],
                        baseline=tree["baseline"],
                        stable=tree["stable"],
                        expected_baseline=tree.get("baseline_record"),
                    )
                    self.store.prepare_allocation(resource)
                    self.store.update_resource(resource["id"], operation_owner=owner_identity())
                    try:
                        allocated = await storage.allocate(
                            tree["kind"],
                            Path(resource["allocation_path"]),
                            Path(tree["source"]) if tree["source"] else None,
                            stable=tree["stable"],
                        )
                        self.store.update_resource(resource["id"], state="ready", tree=allocated)
                        allocations[name] = allocated
                    finally:
                        self.store.update_resource(resource["id"], operation_owner=None)
                mounts = []
                paths = {name: value["path"] for name, value in allocations.items() if value.get("path")}
                for mount in plan.mounts:
                    item = dict(mount)
                    if item["kind"] == "tree":
                        name = item.pop("tree")
                        item = {**allocations[name]["mount"], "target": item["target"]}
                        paths[name] = item["target"]
                    mounts.append(item)
                if self.store.environment(environment_id).get("stop_requested_at"):
                    raise EnvironmentClosed("Environment was stopped during setup")
                self.store.update_environment(environment_id, paths=paths, runtime_intent=True)
                runtime = await LinuxRuntime.create(
                    environment_id,
                    run / "runtime",
                    mounts,
                    max_runtime=seconds(spec.lifetime.max_runtime),
                    grace_seconds=spec.lifetime.grace_seconds,
                    memory_bytes=spec.limits.memory_bytes,
                    cpu_cores=spec.limits.cpu_cores,
                    owner_exit="retain" if spec.lifetime.owner_exit == "continue" else "stop",
                )
                if self.store.environment(environment_id).get("stop_requested_at"):
                    raise EnvironmentClosed("Environment was stopped during activation")
                self.store.update_environment(environment_id, state="running", operation_owner=None)
                environment = Environment(self, environment_id, runtime)
                self._environments[environment_id] = environment
                return environment
        except BaseException as error:
            if runtime is not None:
                with contextlib.suppress(Exception):
                    await finish(runtime.stop("setup_failed"))
            with contextlib.suppress(Exception):
                self.store.update_environment(
                    environment_id,
                    state="setup_failed",
                    operation_owner=None,
                    errors=[f"{type(error).__name__}: {error}"],
                )
            # The failed record and exact allocation intents are retained for reap.
            if hasattr(error, "add_note"):
                error.add_note(f"Hostfork setup record: {run}")
            raise

    async def open(self, environment_id: str) -> Environment:
        """Restore management access; native process/pipe handles cannot be reopened."""
        if environment_id in self._environments:
            environment = self._environments[environment_id]
            await environment._refresh_runtime()
            return environment
        record = self.store.environment(environment_id)
        runtime = None
        if record["state"] not in ("stopped", "purged"):
            run = self.store.verify_run(environment_id)
            if (run / "runtime" / "runtime.json").exists():
                from .backends.linux import LinuxRuntime

                runtime = await LinuxRuntime.reopen(run / "runtime")
        environment = Environment(self, environment_id, runtime)
        self._environments[environment_id] = environment
        return environment

    async def list(self) -> list[dict]:
        """Return stored inventory without requiring a working systemd manager."""
        return self.store.environments()

    async def reap(self, environment_id: str | None = None) -> list[dict]:
        """Reconcile abandoned/stopped runs and apply eligible retention."""
        from .recovery import reap

        return await reap(self, environment_id)

    async def gc(
        self,
        environment_id: str | None = None,
        *,
        force: bool = False,
        discard_incomplete: bool = False,
        reclamation_timeout: float | None = None,
    ) -> list[dict]:
        """Cull eligible stopped resources; force bypasses retention, never live ownership."""
        from .recovery import gc

        return await gc(
            self,
            environment_id,
            force=force,
            discard_incomplete=discard_incomplete,
            reclamation_timeout=reclamation_timeout,
        )

    async def usage(self) -> dict:
        """Report registry, evidence, pool capacity and cleanup backlog separately."""
        from .recovery import usage

        return await usage(self)


class Environment:
    """Reusable view with an independent lifetime and multiple command trees."""

    def __init__(self, hostfork: Hostfork, environment_id: str, runtime: Any):
        self.hostfork = hostfork
        self.id = environment_id
        self._runtime = runtime

    async def _refresh_runtime(self) -> None:
        if self._runtime is None:
            path = self.evidence_path / "runtime"
            if (path / "runtime.json").exists():
                self.hostfork.store.verify_run(self.id)
                from .backends.linux import LinuxRuntime

                self._runtime = await LinuxRuntime.reopen(path)

    @property
    def paths(self) -> dict[str, Path]:
        """Tree presentation paths usable by commands in this environment."""
        return {name: Path(value) for name, value in self.hostfork.store.environment(self.id).get("paths", {}).items()}

    @property
    def evidence_path(self) -> Path:
        """Host-side manifest, logs and backend journals."""
        return self.hostfork.store.run_path(self.id)

    async def __aenter__(self) -> Environment:
        return self

    async def __aexit__(self, *_exc) -> None:
        await finish(self.stop())

    async def spawn(
        self,
        argv: list[str],
        *,
        cwd: str | Path | None = None,
        env: dict[str, str] | None = None,
        stdin=None,
        stdout="file",
        stderr="file",
    ) -> Command:
        """Start a direct asyncio child with inherited, piped or durable-file I/O.

        Parameters
        ----------
        argv
            Executable and arguments, without shell interpretation.
        cwd
            Absolute environment-visible directory. WorkspaceView defaults to its tree.
        env
            Complete child environment, following asyncio's ``env`` semantics.
        stdin, stdout, stderr
            asyncio subprocess descriptors/constants; stdout/stderr additionally accept
            ``'file'`` (default), recording directly into the evidence directory.
        """
        store = self.hostfork.store
        async with store.lock(self.id):
            record = store.environment(self.id)
            if record["state"] != "running" or self._runtime is None:
                raise EnvironmentClosed(f"Environment {self.id} is {record['state']}")
            store.verify_run(self.id)
            command_id = uuid.uuid4().hex
            spec = EnvironmentSpec.from_dict(record["plan"]["spec"])
            if cwd is None and isinstance(spec.view, WorkspaceView):
                cwd = self.paths[spec.view.tree]
            if cwd is not None:
                cwd = absolute(cwd)
            command_record = {
                "id": command_id,
                "argv": argv,
                "cwd": str(cwd) if cwd else None,
                "state": "launching",
                "created_at": time.time(),
                "exit_observed": False,
            }
            store.command(self.id, command_id, command_record)
            with contextlib.ExitStack() as files:
                child = None
                try:
                    for name, value in (("stdout", stdout), ("stderr", stderr)):
                        if value == "file":
                            path = self.evidence_path / f"{command_id}.{name}.log"
                            command_record[name + "_path"] = str(path)
                            descriptor = files.enter_context(path.open("xb", buffering=0))
                            if name == "stdout":
                                stdout = descriptor
                            else:
                                stderr = descriptor
                    store.command(self.id, command_id, command_record)
                    child = await self._runtime.spawn(
                        argv, command_id=command_id, cwd=cwd, env=env, stdin=stdin, stdout=stdout, stderr=stderr
                    )
                    command_record.update(state="running", pid=child.native_process.pid, identity=child.identity)
                    store.command(self.id, command_id, command_record)
                    return Command(self, child, command_record)
                except BaseException as error:
                    if child is not None:
                        await finish(child.stop_tree())
                    command_record.update(state="launch_failed", error=f"{type(error).__name__}: {error}")
                    with contextlib.suppress(Exception):
                        store.command(self.id, command_id, command_record)
                    raise

    async def status(self) -> dict:
        """Return recorded intent, direct exit observations and current backend facts."""
        store = self.hostfork.store
        record = store.environment(self.id)
        result = {
            **record,
            "commands": store.commands(self.id),
            "resources": store.resources(self.id),
            "events": store.events(self.id),
        }
        if record["state"] in ("stopped", "purged"):
            result["runtime"] = record.get("runtime_final")
        elif self._runtime is not None:
            result["runtime"] = await self._runtime.inspect()
        return result

    async def stop(self, reason: str = "requested") -> dict:
        """Fence launches and stop all descendants before filesystem operation locks."""
        store = self.hostfork.store
        try:
            record = store.environment(self.id)
        except Exception:
            if self._runtime is not None:
                await finish(self._runtime.stop(reason))
            raise
        if record["state"] in ("stopped", "purged"):
            return record
        await self._refresh_runtime()
        # Persistence failure must never prevent terminating already owned work.
        with contextlib.suppress(Exception):
            store.update_environment(self.id, stop_requested_at=time.time(), stop_reason=reason)
        runtime = await finish(self._runtime.stop(reason)) if self._runtime is not None else None
        record = store.environment(self.id)
        complete = runtime is None or runtime["state"] == "stopped"
        if owner_alive(record.get("operation_owner")):
            complete = False
        changes = {"state": "stopped" if complete else "cleanup_pending", "runtime_final": runtime}
        if complete:
            changes["stopped_at"] = record.get("stopped_at") or time.time()
        updated = store.update_environment(self.id, **changes)
        if complete:
            self.hostfork._environments.pop(self.id, None)
        return updated

    async def detach(self, *, until_stopped: bool = False) -> None:
        """Leave work running with its fixed deadline, or explicitly allow an unbounded run."""
        record = self.hostfork.store.environment(self.id)
        if not record["plan"]["spec"]["lifetime"]["max_runtime"] and not until_stopped:
            raise ValueError("Unbounded detach requires until_stopped=True")
        if self._runtime is None or record["state"] != "running":
            raise EnvironmentClosed(self.id)
        await self._runtime.detach()
        self.hostfork.store.update_environment(self.id, detached=True)

    async def export(self, tree: str, destination: str | Path | None = None) -> dict:
        """Export a stopped private tree, reconstructing an overlay's merged view."""
        from . import storage

        store = self.hostfork.store
        async with store.lock(self.id):
            record = store.environment(self.id)
            if record["state"] != "stopped":
                raise EnvironmentClosed("Stop and reconcile the environment before exporting")
            resource = next((item for item in store.resources(self.id) if item["name"] == tree), None)
            if resource is None:
                raise KeyError(tree)
            if resource["state"] == "released":
                raise FileNotFoundError(f"Tree already released: {tree}")
            store.verify_allocation(resource)
            export_id = uuid.uuid4().hex
            managed = destination is None
            destination = self.evidence_path / "exports" / export_id if managed else absolute(destination)
            if destination.resolve().is_relative_to(Path(resource["allocation_path"])):
                raise ValueError("Export destination must be outside its source allocation")
            exports = list(record.get("exports", []))
            intent = {
                "id": export_id,
                "managed": managed,
                "tree": tree,
                "destination": str(destination),
                "state": "exporting",
                "created_at": time.time(),
                "owner": owner_identity(),
            }
            exports.append(intent)
            store.update_environment(self.id, exports=exports)
            try:
                if managed:
                    destination.parent.mkdir(exist_ok=True)
                value = resource.get("tree") or await storage.recover_record(
                    resource["kind"],
                    Path(resource["allocation_path"]),
                    Path(resource["source"]) if resource["source"] else None,
                    stable=resource["stable"],
                )
                result = await storage.export_tree(value, destination)
                intent.update(result)
                if result["state"] == "complete":
                    intent["consistency"] = "owned-environment-writers-stopped"
                return dict(intent)
            except BaseException as error:
                intent.update(state="failed", error=f"{type(error).__name__}: {error}")
                raise
            finally:
                intent["owner"] = None
                store.update_environment(self.id, exports=exports)


class Command:
    """The actual Python-owned child plus its independent descendant group."""

    def __init__(self, environment: Environment, child: Any, record: dict):
        self.environment = environment
        self._child = child
        self._record = record
        self.id = record["id"]
        self.native_process: asyncio.subprocess.Process = child.native_process

    @property
    def pid(self) -> int:
        return self.native_process.pid

    @property
    def returncode(self) -> int | None:
        return self.native_process.returncode

    @property
    def stdin(self):
        return self.native_process.stdin

    @property
    def stdout(self):
        return self.native_process.stdout

    @property
    def stderr(self):
        return self.native_process.stderr

    def _observe(self) -> CommandResult:
        result = CommandResult(
            self.id,
            self.returncode,
            self.returncode is not None,
            self._record.get("stdout_path"),
            self._record.get("stderr_path"),
        )
        self._record.update(json_value(result), state="exited" if result.exit_observed else "running")
        self.environment.hostfork.store.command(self.environment.id, self.id, self._record)
        return result

    async def wait(self) -> CommandResult:
        """Wait for the direct command; use communicate when piped output needs draining."""
        await self.native_process.wait()
        return self._observe()

    async def communicate(self, input: bytes | None = None) -> tuple[bytes | None, bytes | None]:
        """Drain pipes with asyncio semantics and persist the observed direct exit."""
        result = await self.native_process.communicate(input)
        self._observe()
        return result

    async def wait_tree(self) -> dict:
        """Wait for descendants, independently of direct-command exit."""
        result = await self._child.wait_tree()
        self._observe()
        return result

    async def stop_tree(self) -> dict:
        """Kill descendants of this command without stopping sibling commands."""
        return await finish(self._child.stop_tree())

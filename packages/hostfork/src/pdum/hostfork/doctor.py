"""Read-only capability inspection and explicitly requested disposable probes."""

from __future__ import annotations

import asyncio
import ctypes
import json
import os
import platform
import shutil
import sys
import tempfile
import uuid
from pathlib import Path


async def _run(argv: list[str], timeout: float = 10) -> dict:
    try:
        process = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
    except OSError as exc:
        return {"returncode": None, "error": str(exc)}
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except TimeoutError:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        return {"returncode": None, "error": f"Command exceeded {timeout:g} seconds"}
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    return {
        "returncode": process.returncode,
        "stdout": stdout.decode(errors="replace").strip(),
        "stderr": stderr.decode(errors="replace").strip(),
    }


def _check(available: bool | None, evidence: str, **details: object) -> dict:
    return {"available": available, "evidence": evidence, **details}


def _read(path: str | Path) -> str | None:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def _existing_parent(path: Path) -> Path:
    while not path.exists() and path.parent != path:
        path = path.parent
    return path if path.is_dir() else path.parent


_NAMESPACE_PROBE = r"""
import ctypes, errno, json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
def mount(source, target, kind=None, flags=0, options=None):
    args = [value.encode() if value is not None else None for value in (source, str(target), kind)]
    if libc.mount(*args, ctypes.c_ulong(flags), options.encode() if options else None):
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
mount(None, "/", flags=(1 << 14) | (1 << 18))
for name in ("lower", "upper", "work", "merged", "readonly", "readonly_source", "readonly_nested"):
    (root / name).mkdir()
(root / "lower" / "input").write_text("original")
results = {"user_mount": True, "uid": os.getuid(), "gid": os.getgid(), "supplementary_groups": os.getgroups()}
try:
    mount("overlay", root / "merged", "overlay", options="lowerdir=%s,upperdir=%s,workdir=%s" % (
        root / "lower", root / "upper", root / "work"))
    (root / "merged" / "input").write_text("private")
    results["overlay"] = (root / "lower" / "input").read_text() == "original"
except OSError as exc:
    results["overlay"] = False
    results["overlay_error"] = str(exc)
try:
    source = root / "readonly_source"
    (source / "input").write_text("original")
    (source / "nested").mkdir()
    (root / "readonly_nested" / "input").write_text("nested")
    mount(str(root / "readonly_nested"), source / "nested", flags=4096)
    mount(str(source), root / "readonly", flags=4096 | 16384)
    mount(None, root / "readonly", flags=4096 | 32 | 1)
    try:
        (root / "readonly" / "input").write_text("should fail")
        results["read_only_bind"] = False
    except OSError as exc:
        results["read_only_bind"] = exc.errno == errno.EROFS
except OSError as exc:
    results["read_only_bind"] = False
    results["read_only_bind_error"] = str(exc)
try:
    class MountAttr(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ("set", "clear", "propagation", "userns_fd")]
    attributes = MountAttr(1, 0, 0, 0)
    if libc.syscall(442, -100, str(root / "readonly").encode(), 0x8000,
                    ctypes.byref(attributes), ctypes.sizeof(attributes)):
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    try:
        (root / "readonly" / "nested" / "input").write_text("should fail")
        results["recursive_read_only"] = False
    except OSError as exc:
        results["recursive_read_only"] = exc.errno == errno.EROFS
except OSError as exc:
    results["recursive_read_only"] = False
    results["recursive_read_only_error"] = str(exc)
print(json.dumps(results))
"""

_SCOPE_PROBE = r"""
import json, os, pathlib, signal, sys, uuid
signal.alarm(8)
if sys.stdin.buffer.read(1) != b"!":
    raise SystemExit(1)
line = next(line for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
root = pathlib.Path("/sys/fs/cgroup") / line[3:].lstrip("/")
leaf = root / ("doctor-" + uuid.uuid4().hex)
results = {"path": str(root), "controllers": (root / "cgroup.controllers").read_text().split()}
try:
    leaf.mkdir()
    results["subgroup_create"] = True
    (leaf / "cgroup.kill").write_text("1")
    results["empty_subgroup_kill"] = True
finally:
    if leaf.exists():
        leaf.rmdir()
results["subgroup_removed"] = not leaf.exists()
print(json.dumps(results))
"""


def _pidfd_open(pid: int) -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    call = libc.pidfd_open
    call.argtypes = [ctypes.c_int, ctypes.c_uint]
    call.restype = ctypes.c_int
    descriptor = call(pid, 0)
    if descriptor < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return descriptor


async def _probe_scope() -> dict:
    # Import only when probing the implemented Linux backend.
    from .backends.linux._manager import Manager

    manager = Manager()
    unit = "pdum-hostfork-doctor-" + uuid.uuid4().hex + ".scope"
    process = None
    descriptor = None
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            "-c",
            _SCOPE_PROBE,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        descriptor = _pidfd_open(process.pid)
        state = await manager.start(
            unit, descriptor, runtime=5, grace=0.1, delegate=True, memory_bytes=64 * 1024 * 1024, cpu_cores=0.5
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(b"!"), 7)
        if process.returncode:
            raise RuntimeError(stderr.decode(errors="replace").strip())
        observed = json.loads(stdout)
        observed["scope"] = unit
        observed["runtime_max_usec"] = state.get("RuntimeMaxUSec")
        observed["memory_max_bytes"] = state.get("MemoryMax")
        observed["cpu_quota_usec_per_second"] = state.get("CPUQuotaPerSecUSec")
        return observed
    finally:
        if process is not None:
            if process.returncode is None:
                process.kill()
            await process.communicate()
        if descriptor is not None:
            os.close(descriptor)
        try:
            await manager.stop(unit)
            await manager.release(unit)
        finally:
            await manager.close()


async def doctor(root: Path | None = None, probe: bool = False) -> dict:
    """Inspect host capabilities without changing host configuration.

    Parameters
    ----------
    root
        Intended storage location. Missing roots are inspected through their
        nearest existing parent and are not created by diagnosis.
    probe
        Exercise temporary namespaces, mounts and a transient user scope.
        No persistent unit, sysctl, permission or filesystem setup is performed.

    Returns
    -------
    dict
        JSON-compatible observations. Configured prerequisites are distinguished
        from observed probes; this is not certification of the complete runtime.
    """
    location = Path(root).expanduser().absolute() if root is not None else Path(tempfile.gettempdir())
    parent = _existing_parent(location)
    filesystem = None
    linux = sys.platform == "linux"
    if linux and shutil.which("findmnt"):
        result = await _run(["findmnt", "--json", "--target", str(parent), "--output", "FSTYPE,TARGET"])
        if result.get("returncode") == 0:
            try:
                filesystem = json.loads(result["stdout"])["filesystems"][0]
            except (ValueError, KeyError, IndexError):
                pass
    storage = _check(
        None,
        "configured",
        requested_path=str(location),
        existing_parent=str(parent),
        path_exists=location.exists(),
        parent_writable=os.access(parent, os.W_OK | os.X_OK),
        filesystem=filesystem,
        btrfs_tool=shutil.which("btrfs"),
        snapshot_creation="untested",
        reclamation="untested",
    )
    if not linux:
        unsupported = _check(False, "unsupported", reason="The implemented execution backend requires Linux")
        return {
            "schema_version": 1,
            "platform": sys.platform,
            "kernel": platform.release(),
            "probe_requested": probe,
            "capabilities": {
                "namespace": unsupported,
                "systemd": unsupported,
                "cgroup": unsupported,
                "storage": storage,
            },
        }
    policy = {
        name: _read("/proc/sys/" + name.replace(".", "/"))
        for name in (
            "kernel.unprivileged_userns_clone",
            "kernel.apparmor_restrict_unprivileged_userns",
            "user.max_user_namespaces",
        )
    }
    namespace = _check(
        None,
        "configured",
        policy=policy,
        unshare_executable=shutil.which("unshare"),
        user_mount="untested",
        overlay="untested",
        read_only_bind="untested",
        recursive_read_only="untested",
    )
    cgroup_line = next(
        (line for line in (_read("/proc/self/cgroup") or "").splitlines() if line.startswith("0::")), None
    )
    current_group = Path("/sys/fs/cgroup") / cgroup_line[3:].lstrip("/") if cgroup_line else None
    cgroup = _check(
        bool(current_group and current_group.exists()),
        "configured",
        version=2 if cgroup_line else None,
        current_path=str(current_group) if current_group else None,
        current_writable=bool(current_group and os.access(current_group / "cgroup.procs", os.W_OK)),
        controllers=(_read(current_group / "cgroup.controllers") or "").split() if current_group else [],
        delegated_scope="untested",
        workload_placement="untested",
        aggregate_limits="untested",
    )
    manager = await _run(["systemctl", "--user", "show", "--property=Version", "--value"])
    systemd = _check(
        manager.get("returncode") == 0,
        "observed",
        version=manager.get("stdout") or None,
        error=manager.get("error") or manager.get("stderr") or None,
        scope_registration="untested",
        runtime_timer="untested",
        pidfd_registration="untested",
    )
    lingering = await _run(["loginctl", "show-user", str(os.getuid()), "--property=Linger", "--value"])
    systemd["linger_configured"] = lingering.get("stdout") if lingering.get("returncode") == 0 else None
    try:
        descriptor = _pidfd_open(os.getpid())
        os.close(descriptor)
        pidfd = _check(True, "observed")
    except (AttributeError, OSError) as exc:
        pidfd = _check(False, "observed", error=str(exc))
    if probe:
        if not namespace["unshare_executable"]:
            namespace.update(available=False, evidence="observed", error="util-linux unshare is not installed")
        else:
            try:
                with tempfile.TemporaryDirectory(prefix=".pdum-hostfork-doctor-", dir=parent) as temporary:
                    result = await _run(
                        [
                            namespace["unshare_executable"],
                            "--user",
                            "--map-current-user",
                            "--keep-caps",
                            "--mount",
                            "--",
                            sys.executable,
                            "-I",
                            "-c",
                            _NAMESPACE_PROBE,
                            temporary,
                        ]
                    )
                    if result.get("returncode") == 0:
                        namespace.update(json.loads(result["stdout"]), available=True, evidence="observed")
                    else:
                        namespace.update(
                            available=False, evidence="observed", error=result.get("error") or result.get("stderr")
                        )
            except (OSError, ValueError) as exc:
                namespace.update(available=False, evidence="observed", error=str(exc))
        if systemd["available"] and pidfd["available"]:
            try:
                observed = await _probe_scope()
                systemd.update(
                    scope_registration="observed",
                    pidfd_registration="observed",
                    runtime_timer="configuration_accepted",
                )
                cgroup.update(
                    delegated_scope="observed",
                    probe=observed,
                    evidence="observed",
                    limit_configuration="configuration_accepted",
                )
            except Exception as exc:
                cgroup.update(delegated_scope="unavailable", probe_error=str(exc))
    findings = []
    if namespace["available"] is False:
        findings.append(
            {
                "capability": "namespace",
                "remedy": "Inspect user-namespace policy and LSM denials; explicitly prepare host policy if needed.",
            }
        )
    if not systemd["available"]:
        findings.append(
            {
                "capability": "systemd",
                "remedy": "Start the user manager; set matching XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS.",
            }
        )
    if cgroup["delegated_scope"] == "unavailable":
        findings.append(
            {
                "capability": "cgroup",
                "remedy": "Inspect the probe error; PIDFD scope registration and delegated cgroup v2 are required.",
            }
        )
    if not storage["parent_writable"]:
        findings.append({"capability": "storage", "remedy": "Choose a writable storage root or prepare its ownership."})
    support = _check(None, "untested")
    if root is not None:
        from .support import SupportConflictError, plan

        try:
            integration = await plan(location)
            support = _check(
                integration["installed"],
                "configured",
                state=integration["installation_state"],
                conflicts=integration["conflicts"],
                installed_python_executable=integration["installed_python_executable"],
                installed_interpreter_exists=integration["installed_interpreter_exists"],
            )
            if integration["conflicts"] or integration["installed_interpreter_exists"] is False:
                findings.append(
                    {
                        "capability": "support",
                        "remedy": "Inspect support plan for edited units or a moved interpreter; repair explicitly.",
                    }
                )
        except (SupportConflictError, OSError) as exc:
            support = _check(False, "configured", error=str(exc))
    return {
        "schema_version": 1,
        "platform": sys.platform,
        "kernel": platform.release(),
        "probe_requested": probe,
        "capabilities": {
            "namespace": namespace,
            "systemd": systemd,
            "cgroup": cgroup,
            "storage": storage,
            "pidfd": pidfd,
            "support": support,
        },
        "findings": findings,
        "qualification": (
            "Individual capability observations; complete runtime ownership and resource limits "
            "require integration tests"
        ),
    }

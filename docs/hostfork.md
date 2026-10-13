# Hostfork

`habemus-papadum-hostfork` / `pdum.hostfork` is the Linux implementation of the
[Hostfork architecture](specs/hostfork/architecture.md). It creates a reusable view
of the current host, owns its process trees, and records private storage and useful
failure evidence in an operator-selected registry. It has no dependency on the
MITM or Codex launcher packages.

This is convenience isolation for trusted operators. The default inherits host
paths, networking and PID visibility. Specify paths to copy, snapshot, overlay,
share explicitly or make read-only. A default environment is **not** a point-in-time
snapshot of every host filesystem or service.

## Requirements and diagnosis

Python 3.12+, Linux user/mount namespaces, cgroup v2, a usable systemd **user**
manager, and PIDFD-based transient scope registration are required for execution.
The qualification starting point is systemd 255; a version string alone does not
prove the required capabilities. GNU `cp` supports copies/export; Btrfs additionally
needs `btrfs-progs` and prepared writable allocation directories.

```sh
uv sync --frozen --all-packages --all-extras
uv run pdum-hostfork --root /srv/hostfork-state doctor
uv run pdum-hostfork --root /srv/hostfork-state doctor --probe
```

Inspection reports configuration and unknowns. `--probe` creates disposable
namespace/mount resources and an actual delegated PIDFD-registered scope. It does
not change sysctls, AppArmor policy, user lingering or filesystem configuration.
Use its evidence and remedies for your launch context; running a probe as root
does not prove that your experiment user can launch environments.

On hosts that restrict unprivileged user namespaces, an administrator must prepare
an appropriate policy. The relevant settings include `kernel.unprivileged_userns_clone`,
`user.max_user_namespaces`, and Ubuntu's AppArmor user-namespace restriction. There
is no automatic system-wide relaxation. Check CPU/memory controller delegation and
the user's D-Bus/systemd manager as well. A user manager surviving caller death
is different from surviving logout: enable lingering explicitly during host
preparation when needed. Machine reboot ends workloads; recovery reconciles their
records afterward, subject to the qualification limits below.

## Python lifecycle

```python
import asyncio
from pathlib import Path
from pdum.hostfork import (
    EnvironmentSpec,
    HostView,
    Hostfork,
    Lifetime,
    Limits,
    PrivateTree,
    Retention,
)


async def experiment():
    host = Hostfork("/srv/hostfork-state", pools={"fast": "/srv/hostfork-pool"})
    source = Path("/srv/experiment")
    spec = EnvironmentSpec(
        trees={"work": PrivateTree(source, storage="copy", pool="fast")},
        view=HostView(replace={str(source): "work"}, fresh=("/dev/shm",)),
        limits=Limits(memory_bytes=2 * 1024**3, cpu_cores=2),
        lifetime=Lifetime(max_runtime=1200, grace_seconds=0.5),
        retention=Retention(trees=86400, evidence=7 * 86400),
        labels={"experiment": "example"},
    )
    plan = await host.plan(spec)  # resolves paths; allocates nothing
    if not plan.supported:
        raise RuntimeError(plan.errors)
    async with await host.create(spec) as environment:
        sidecar = await environment.spawn(["python3", "service.py"], cwd=source)
        command = await environment.spawn(
            ["python3", "worker.py"],
            cwd=source,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        output, errors = await command.communicate()
        result = await command.wait()
        await command.wait_tree()
        await sidecar.stop_tree()
        print(environment.id, command.pid, result.returncode)
    exported = await environment.export("work", "/srv/results/example")
    print(exported)


asyncio.run(experiment())
```

`Hostfork(root, pools=...)` is inert on construction. `plan()` returns resolved
paths, sharing assumptions and static errors. Runtime capability checks still
happen during creation. State/evidence and allocation pools must sit outside paths
being replaced; sources must not recursively include those roots. Mount targets
must already exist and may not be `/` or symlinks. Parent mounts are applied before
children. A nested target must still exist after its parent is replaced; setup
fails visibly if it disappears.

`HostView` preserves paths. `WorkspaceView("work")` instead exposes a copy/snapshot
at its allocated path and uses that as the default working directory. It makes no
promise that software's absolute paths are relocated. Overlay trees require a
HostView presentation target. No native macOS runtime is implemented; planning
reports execution as unsupported there, without silently reducing isolation.

An environment owns one namespace keeper and multiple commands. Each `spawn()`
returns a direct child of the calling Python process with the requested program
executed in place; `native_process` is the real `asyncio.Process`. Dependencies
that fork, use `subprocess`, double-fork or call `setsid()` inherit cgroup ownership
without special Python integration. `wait()` observes the direct child's exit;
`wait_tree()` waits for descendants; `stop_tree()` kills that command's descendants
while preserving siblings. Context exit stops the environment.

Default stdout/stderr go directly to durable evidence files. Pass `PIPE`, `DEVNULL`,
`STDOUT`, a file descriptor, or `None` with asyncio semantics. Piped output must be
drained; `communicate()` does that. Pipes do not become durable logs automatically.
Namespace/setup failures before release raise from `spawn()`. An executable error
after release can instead produce helper exit code 125 and a traceback in stderr;
an application can also choose that code, so inspect the available evidence.
The `env` argument replaces the complete environment, as with asyncio. `cwd` is an
absolute path interpreted inside the environment.

## Deadlines, detachment and results

An explicit `Lifetime(max_runtime=1200)` bounds execution from environment scope
activation. Its graceful termination interval is **inside** that budget. The
systemd manager enforces it even when the calling Python process or keeper is
frozen. Fresh setup gates also have a kernel-enforced timeout before admission;
commands entering later cannot acquire a fresh environment lifetime. The clock is
monotonic and excludes time the machine is suspended. Scheduling and uninterruptible
kernel I/O can delay observable completion; this is not a realtime guarantee.

Setup has a separate cooperative timeout. Filesystem mutations finish or retain
an interrupted intent before cancellation returns, so a timeout may take longer
than its nominal value while an OS operation completes. Resource and operation
journals let a separate controller retry cleanup.

`Limits(memory_bytes=...)` sets aggregate cgroup-accounted memory enforcement (including charged cache/kernel memory) and disables
swap for that environment. CPU cores express a CPU-time quota, not affinity. These
limits include the namespace keeper and all commands. No GPU policy is implied.

Creator loss stops the environment by default. For intentional persistence, call
`await environment.detach()` with a deadline, or pass `until_stopped=True` to
explicitly allow an unbounded run. `Lifetime(owner_exit="continue")` is an explicit
creation-time policy. Closing an async context still requests stop. A later
`await Hostfork(root).open(id)` restores management and can start another command;
it cannot restore old asyncio pipe/wait handles.

`status()` preserves control decisions, manager observations and command exit
observations independently. A negative returncode identifies a signal, not its
cause. Exit code 7 is not a scope failure. Manager timeout, observed OOM, requested
stop and missing evidence remain distinct facts. If the caller died before
persisting an exit, the result remains unknown. File logs and private trees retain
whatever was written; that does not imply application consistency.

## Storage and host preparation

Choose per tree:

| Mechanism | Input | Result and trade-off |
| --- | --- | --- |
| `copy` | Existing directory | Independent directory walk; preserves GNU `cp -a` metadata where supported, not an atomic snapshot of a running application. |
| `empty` | No input | Empty private directory. |
| `overlay` | Explicitly stable lower (`stable=True`) | Fast writable layer, lower must remain available and unchanged through later export. |
| `btrfs` | Prepared read-only Btrfs subvolume | Writable native snapshot, allocated on the same Btrfs filesystem. Nested subvolumes are rejected rather than silently omitted. |

Host preparation is independent of launch. For ordinary-user snapshot deletion,
prepare the Btrfs mount with `user_subvol_rm_allowed` and suitable directory
ownership. On an **already mounted** Btrfs volume,
create the baseline once, copy the required data, mark it read-only, and make an
allocation directory writable by the experiment user. For example, as the
appropriate administrator/operator:

```sh
btrfs subvolume create /srv/btrfs/baselines/experiment
cp -a /srv/experiment/. /srv/btrfs/baselines/experiment/
btrfs property set -ts /srv/btrfs/baselines/experiment ro true
mkdir -p /srv/btrfs/allocations
# Set ownership/permissions on allocations for the actual experiment user.
```

Create the `baselines` parent first if needed. Device formatting, volume mounts,
AMI/EBS construction and population are deliberately outside the library. This
recipe does not imply the host root filesystem must be Btrfs.

```python
host = Hostfork("/srv/hostfork-state", pools={"btrfs": "/srv/btrfs/allocations"})
await host.register_baseline(
    "experiment",
    "/srv/btrfs/baselines/experiment",
    storage="btrfs",
)
spec = EnvironmentSpec(
    trees={"work": PrivateTree(baseline="experiment", storage="btrfs", pool="btrfs")},
    view=HostView(replace={"/srv/experiment": "work"}),
    lifetime=Lifetime(max_runtime=1200),
)
```

Registered baselines are borrowed; Hostfork never deletes them. Reservations pin
the exact registered input before allocation. The operator remains responsible for
not removing or mutating borrowed inputs outside Hostfork. Default operation does
not enable Btrfs qgroups or claim exact exclusive space accounting.

Stop the environment before `export()`. Btrfs/copy trees are copied into a private
partial destination; overlays are remounted in a disposable namespace so whiteouts
and opaque directories yield the correct merged view. Copying `upper/` alone is not
an export. Completed output is published without replacing an existing destination;
partial output and ownership receipts remain inspectable after interruption.
Omit the destination (`await environment.export("work")`) to keep the export and
receipt under the environment evidence directory, governed by evidence retention.
Explicit destinations belong to the caller and are inventoried but not silently
deleted by retention.

## Shared services and remaining Linux assumptions

Host networking is inherited: a service listening on host `127.0.0.1:PORT` remains
reachable. No extra binding is needed for that TCP listener. A Unix-domain socket
also works if its original socket inode remains reachable. When replacing its
parent directory, explicitly share the live directory with
`HostView(shared={"/visible/socket-directory": "/host/socket-directory"})`.
A copied socket pathname is not the listening endpoint. Sharing a directory also
handles services that unlink and replace their socket more naturally than binding
one socket inode. FIFOs and device files likewise have semantics beyond file bytes.

Pseudo-filesystems and devices are inherited unless a requested mount changes
them. `fresh=("/dev/shm",)` provides an owned **disk-backed** directory, including
named-semaphore remnants, rather than an anonymous tmpfs charged to memory. It
changes tmpfs-specific behavior. Fresh directories live under the run evidence
directory and follow evidence retention; they are not named exportable trees. Supplementary groups may not survive the chosen
single-UID mapping, affecting files and sockets accessible only through a group.
Inherited open descriptors keep their existing references even after path mounts
change. Host libraries, shared services and mutable paths can change during a run.

## CLI and installed host support

The CLI is a library adapter. Put global options before the subcommand:

```sh
pdum-hostfork --root /srv/hostfork-state shell --ttl 1200 \
  --copy /srv/experiment=/srv/experiment --cwd /srv/experiment
pdum-hostfork --root /srv/hostfork-state run --ttl 1200 \
  --fresh /dev/shm -- python3 /srv/experiment/worker.py
pdum-hostfork --root /srv/hostfork-state plan --spec environment.toml
pdum-hostfork --root /srv/hostfork-state create --spec environment.toml
pdum-hostfork --root /srv/hostfork-state exec ENVIRONMENT_ID -- /bin/bash -c 'pwd'
pdum-hostfork --root /srv/hostfork-state --json status ENVIRONMENT_ID
```

JSON/TOML files use `EnvironmentSpec.to_dict()`'s schema; there is no separate CLI
policy language. `--overlay SOURCE=TARGET` asserts a stable lower. `--read-only`,
`--fresh`, `--memory BYTES`, `--cpu CORES`, and `--pool NAME=/path` provide compact
shell-testing options. `shell` inherits the existing terminal; allocated PTYs and
remote attach/job-control management are not implemented.

```toml
[trees.work]
source = "/srv/experiment"
storage = "copy"

[view]
kind = "host"
replace = { "/srv/experiment" = "work" }
fresh = ["/dev/shm"]

[lifetime]
max_runtime = 1200

[retention]
trees = 86400
evidence = 604800
```

Install independent periodic recovery explicitly:

```sh
pdum-hostfork --root /srv/hostfork-state support plan
pdum-hostfork --root /srv/hostfork-state support install
pdum-hostfork --root /srv/hostfork-state support status
pdum-hostfork --root /srv/hostfork-state support uninstall
```

This installs registry-specific user service/timer files and a bounded finalizer
template using the current interpreter's absolute path. The scope deadline is
independent of this timer; the timer runs `reap` to reconcile records and retention.
The finalizer template is available for explicit per-environment invocation;
periodic recovery is the installed automatic path. This does not promise to
capture a scope result before systemd discards it after its last observer exits.
No resident Hostfork daemon is needed. Installation is idempotent and refuses to
overwrite edited/unowned unit files. Keep the interpreter installed at its recorded
path; reinstall support deliberately when moving it. An explicit `--unit-dir` is a
file-only staging operation and does not enable the real user manager.

Uninstall refuses active recorded runs unless explicitly forced. It removes owned
integration files, not run evidence or private data. Logout survival requires the
host's chosen lingering/session policy; installation does not change that policy.

## Recovery, retention and utilization

All resources have intent records before allocation and exact ownership markers.
`reap()` works from another process, after owner loss, and concurrently with another
reaper. It requests termination before waiting for storage-operation locks. A live
or frozen allocator, unresolved mount ownership, modified path or incomplete
export remains pending; it is not permission to recursively remove a storage pool.

```sh
pdum-hostfork --root /srv/hostfork-state reap
pdum-hostfork --root /srv/hostfork-state list
pdum-hostfork --root /srv/hostfork-state usage
pdum-hostfork --root /srv/hostfork-state gc
pdum-hostfork --root /srv/hostfork-state gc --environment ENVIRONMENT_ID --force
```

Retention defaults to keeping trees and evidence indefinitely. Configured clocks
start at confirmed execution stop. Trees and evidence have separate retention;
evidence remains while owned trees still need cleanup. `gc --force` bypasses the
retention duration but never live ownership. `--discard-incomplete` explicitly
releases an incomplete-export hold. Registry tombstones preserve inventory after
large evidence files are culled. Empty copy/overlay allocation directories are removed after owned-tree deletion.
Btrfs allocation directories remain while physical reclamation is pending; confirm
it explicitly with `await host.gc(reclamation_timeout=5)` to allow their removal.
Registry ownership records remain as tombstones.

`usage()` reports state counts, retained trees, oldest incomplete cleanup, pending
Btrfs reclamation, evidence bytes, export locations and pool filesystem capacity.
Logical bytes and block counts are not exclusive usage: reflinks/shared extents,
compression and hardlinks make naive sums misleading. Btrfs deletion acknowledgment
is distinct from physical reclamation. `storage.confirm_reclamation(record)` is an
explicit bounded wait, separate from launch/stop. No default disk quota, log
truncation or baseline garbage collection is imposed.

## Validation and limits

Real local tests exercise PID/parent/I/O preservation, command descendants,
multiple commands, stop/admission races, cancellation, owner death/freeze, keeper
loss, fixed deadlines, aggregate OOM, copy/overlay export, prepared Btrfs, retention,
wrong-path rejection and recovery. Support installation has also been checked
against a real user manager with units removed afterward. See the
[qualification record](hostfork-validation.md) for measured results and remaining
gates; research measurements do not automatically qualify production code.

Portable model/planning/registry/CLI tests run in ordinary CI. Linux integration
and Btrfs tests carry capability markers and visible skips. A separate prepared
Ubuntu 24.04 workflow requires real capabilities and provisions a disposable
loopback Btrfs filesystem. Its first GitHub-hosted execution remains a qualification
gate until these changes are pushed and that job runs; local tests cannot prove
GitHub runner policy.

Native macOS execution, private PID mode, allocated PTYs, GPU scheduling and a
FastAPI adapter remain planned extensions. Power-loss/reboot fault injection,
actual EBS/AMI performance and every supported distro's policy need their own
qualification. Uninterruptible kernel I/O and operator mutation of borrowed
resources can leave cleanup pending, with evidence rather than a false success.

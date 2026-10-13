# Hostfork architecture

**Proposed implementation baseline, 2026-10-13.** This designs
`habemus-papadum-hostfork` / `pdum.hostfork`, with a `pdum-hostfork` CLI.
A Linux production package now exists; see the [operator/API guide](../../hostfork.md)
and [qualification record](../../hostfork-validation.md). This architecture remains
the design baseline; pseudocode here is illustrative rather than the exact public API. The [spikes](spike-findings.md) supply
evidence, not an API to preserve. This document supersedes the earlier
[exploratory design notes](design-notes.md); the [implementation plan](../../plans/hostfork.md)
separates established behavior from the remaining engineering gates.

## The central decision

**An environment owns private trees, a view of the host, and a group of commands.**
These are separate resources with separate lifetimes. Finishing a command need
not stop its descendants or close the environment. Stopping the environment need
not delete its files. Deleting a snapshot need not immediately reclaim its space.

Linux is the first implementation. It inherits the host and substitutes selected
paths; host networking and host PID visibility are the defaults. Installed
software and localhost services remain available. A prepared Btrfs snapshot is
a first-class private tree; OverlayFS remains useful on other prepared layouts.
Neither storage choice determines process ownership.

Python owns ordinary process launch. An OS-backed lifetime controller owns the
deadline and resource budget. A separate, repeatable cleanup operation owns
recovery and retention. There is no mandatory Hostfork server and no dependency
on MITM, Codex, or an experiment framework. This is a trusted operator's tool,
with hygiene checks rather than a security-boundary claim.

## Components and their boundaries

| Component | Responsibility |
| --- | --- |
| Planner | Resolve requested behavior against host capabilities; describe effective sharing, storage, limits, lifetime and unsupported requests before allocation. |
| Store | Persist identities, allocation intentions, deadlines, evidence and recovery progress beneath an operator-selected root. |
| Storage implementations | Allocate, reopen, inspect and release private trees. Start with Btrfs snapshots and overlays; ordinary copies support small state trees. |
| Execution backend | Present those trees, launch commands, own their descendants and enforce the requested lifetime/resources. Initially Linux namespaces, cgroup v2 and systemd. |
| Environment coordinator | Combine the above into async create, spawn, status, stop, export and close operations. It does not need to survive for recovery to work. |
| Reaper | Reconcile recorded ownership with actual resources; finish interrupted shutdown, finalization and eligible deletion. Callable independently. |
| Adapters and host tools | Typer CLI, doctor and explicit support installation. An optional FastAPI adapter calls the same library. |

These are internal modules with small typed interfaces, not separately deployed
services or a public plugin framework. Storage and execution are distinct
interfaces, but the planner validates their combinations; arbitrary mixtures
are not assumed to work.

## Public workflow

Proposed API shape, not runnable package code:

```python
from datetime import timedelta
from pathlib import Path

from pdum.hostfork import (
    EnvironmentSpec,
    Hostfork,
    HostView,
    Lifetime,
    Limits,
    PrivateTree,
    Retention,
)

host = Hostfork(
    root=Path("/srv/hostfork"),
    storage_roots={"snapshots": Path("/mnt/btrfs/hostfork")},
)
spec = EnvironmentSpec(
    trees={"project": PrivateTree(baseline="project-v1", storage="btrfs", pool="snapshots")},
    view=HostView(replace={"/work/project": "project"}),
    limits=Limits(memory_bytes=8 * 1024**3, cpu_cores=2),
    lifetime=Lifetime(max_runtime=timedelta(minutes=20), owner_exit="stop"),
    retention=Retention(trees=timedelta(days=1), evidence=timedelta(days=7)),
)
plan = await host.plan(spec)
async with await host.create(plan) as env:
    command = await env.spawn(
        ["python", "worker.py"],
        cwd=env.paths["project"],
        output="files",
    )
    result = await command.wait()  # leader result, distinct from tree completion
    await command.wait_tree()  # library-created descendants count too
    await env.run(["python", "verify.py"], cwd=env.paths["project"])
    await env.export("project", destination=Path("/srv/results/project"))
# Context exit stops the environment; retained trees/evidence follow retention.
```

The baseline is registered during host preparation. Private trees also accept
explicit source paths; the plan states the source consistency requirements.
Creation revalidates the plan's resource identities and required capabilities;
a saved plan is not proof that the host or baseline is still unchanged.
`env.paths` gives the path a workload should use for each named tree. `cwd` is
resolved after entering the view, not inherited as an open host directory.

`Command` is a small portable handle: wait, communicate, stream access, leader
signal, tree stop, and observation metadata. On the initial Linux host-PID path,
`command.native_process` exposes the real `asyncio.subprocess.Process` for clients
that need it. Native `kill()` still kills only that process; `command.stop_tree()`
and `env.stop()` express ownership of larger groups. Other backends may use an
adapted handle, and must report that explicitly.
`wait_tree()` waits for that command's descendants; sidecars and the keeper can
remain active. Tree completion, tree stop and quiescent export are capability-gated
on backends that cannot prove descendant ownership.

Output modes are files, pipes, or inherited descriptors. File mode writes directly
to owned log files and survives reader death; pipe mode preserves normal asyncio
semantics, including descendants holding pipes open after their leader exits.
Pipe output is only durable if someone records it. A later PTY mode supplies
terminal resize, signal and session behavior without changing environment ownership.
The first shell command inherits an existing terminal; it is not a reconnectable PTY.

## Linux process ownership

Use one delegated systemd scope per environment, with a small namespace keeper
and one cgroup per command beneath it:

```text
environment.scope                 aggregate budget and independent deadline
  keeper/                         holds the reusable filesystem view
  commands/<command-id>/          command plus all its ordinary descendants
```

The keeper starts through a fresh execution boundary; the library never changes
namespaces in the calling Python process. It holds the view while commands come
and go. After setup, the scope root contains no processes, allowing the delegated
hierarchy to use domain controllers correctly. The keeper counts against the
environment's budget. Keeper loss prevents further launches; a surviving owner
or reaper initiates shutdown/recovery. The independent deadline remains the
fallback for bounded runs. The keeper is not silently recreated around commands.

Each launch is reserved durably before a fresh gated subprocess starts. Before
application code runs, the backend places the child in its command cgroup, joins
the view, sets cwd/stdio/environment, verifies readiness, then releases it to
`exec`. Descendants inherit ownership without using Hostfork. A sidecar is another
command; readiness checks and application-specific restart policies belong to
the caller. Work dispatched to an already-running external service is shared
service activity, not a descendant Hostfork can automatically own.

**Adding later commands requires more than repeating Spike 024.** On systemd 255,
PIDFD registration is available during scope creation, while existing-scope
attachment takes numeric PIDs. Merely holding a pidfd does not make that separate
numeric operation safe. The recommended path uses a temporary staging scope
created with the child's pidfd; the gated child then moves itself into the
delegated destination. It keeps its PID and original Python parent. Direct
self-placement can replace staging only where the actual delegation permits it.
[systemd 255 scope interface](https://github.com/systemd/systemd/blob/v255/src/core/dbus-scope.c)

A narrow review probe verified the staging-to-delegated-scope transfer here;
the complete hierarchy, namespace joining and failure protocol remain the first
implementation gate. Every staging scope is an owned resource with a bounded
setup lifetime and an expiry no later than the environment's deadline. No work
is released unless placement and effective deadline are verified.

Stop closes admission, revokes/reaps in-flight launch gates, stops command trees,
stops the keeper, and verifies the scope is empty. A cgroup kill alone does not
fence a process that might enter afterward. Independent deadline enforcement never waits for a
registry or storage lock; reconciliation finishes the admission/cleanup work.
Keep namespace references inside owned helpers. A frozen external caller must
not retain an open namespace descriptor that prevents mount release.

Host PID visibility permits direct exec with normal Python wait semantics.
Joining a reusable private PID namespace requires an additional fork or a broker;
it cannot quietly retain the same target-PID/direct-child promise. Private PID
mode is deferred behind an explicit adapted-process capability, not made a
prerequisite for filesystem isolation. The execution backend owns this distinction.

## Storage and the view

Preparing filesystems, copying baseline data, arranging subvolumes and starting
shared services are host preparation. Runtime launch consumes that preparation.
It neither formats devices nor imports a complete host tree on each run.

| Tree mechanism | Contract and retained state |
| --- | --- |
| Btrfs snapshot | Writable snapshot of a prepared baseline subvolume; independently usable after shutdown. Nested subvolumes must be separately described. |
| Overlay | Owned upper/work directories over an explicitly stable lower. Reopening the final view requires the lower as well as the upper. |
| Copy | Independent directory copy, useful for small state; tree-wide atomicity is not implied. Reflink acceleration is reported where qualified. |
| Shared/read-only presentation | References live host data. Read-only through one path is not a snapshot and does not freeze other writers. |

Btrfs is the recommended prepared-storage option where its semantics fit, not a
universal requirement or an assertion that it creates faster than overlays.
Selection is explicit per tree; automatic selection, if offered, may only choose
among mechanisms satisfying the requested guarantees. There is no silent
snapshot-to-live-overlay fallback. Borrowed host baselines are never deleted by
environment cleanup. Managed overlay lower dependencies remain retained until
their last dependent tree is released; external lowers require the operator to
keep them stable and available. Btrfs snapshots do not need the source baseline
to remain present merely to read their files.
[Btrfs subvolume semantics](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html)

An operator may declare a source stable without making the entire host read-only.
Record that assumption and its provenance; the library cannot prevent another
trusted host process from breaking it. Do not advertise snapshot consistency for
an operator-maintained live directory.

The Linux view starts with inherited mounts, private mount propagation, identity
and networking. Replacements, read-only paths, shared endpoint bindings and
private scratch are explicit changes. Plan output shows nested mounts, overlapping
rules, source/target aliases and inherited writable areas. It does not claim to
discover every application's dependency. Registry, helper/control and evidence
paths must remain accessible outside disposable views; reject self-shadowing
configurations unless the plan explicitly restores the required paths.
Do not silently replace `/run`, `/tmp` or `/dev/shm`. A private-scratch preset may
do so visibly, with explicit shared
bindings restored afterward.

Localhost TCP services work through shared host networking. Unix sockets need
their original endpoint visible, often by sharing a directory that also handles
socket replacement. Copying their pathname is not sharing the live service.
Services still interpret filenames in their own view; run a sidecar inside the
environment when it must see private files.

## Lifetime, recovery and forensic evidence

Treat these as separate controls: **execution deadline, termination grace,
finalization budget, tree retention, evidence retention**. Bounded runs choose a
duration explicitly. An unbounded interactive run is an explicit mode; the
library does not invent a universal twenty-minute limit.

`max_runtime` runs from first environment-scope activation to the force-stop
deadline, including termination grace. Storage/view setup after activation uses
the same budget; pre-activation setup has its own bounded operation lifetime.
New commands do not extend the deadline. Arm graceful termination earlier, and
report actual controller times; setting `RuntimeMaxUSec=max_runtime` and adding
`TimeoutStopUSec` afterward would violate this contract. Staging deadlines also
include their stop grace. Initial Linux runtime durations use
the manager's monotonic clock, excluding suspend; persisted records also carry
UTC and boot identity for recovery. No real-time claim is made about uninterruptible
kernel tasks or a paused host. Reboot ends the old workload, never resumes it
automatically, and leaves storage/evidence reconciliation to the reaper.

Owner exit defaults to stop. A keeper observes ownership-channel closure for
prompt handling; independent deadline/reaping still covers a stuck keeper.
Explicit detach allows continued execution with a recorded expiry, or an
explicit until-stopped policy. Detach does not use systemd `AbandonScope`, which
disables the scope runtime timer in the tested implementation.
Until-stopped mode has no deadline fallback; prompt unattended recovery then
depends on configured host support.

Shutdown records the initiating decision, stops writers, collects available
observations, releases live namespace resources and finalizes retained files.
Recording failures, including a full state/log filesystem, cannot prevent stop
or kill. New launches abort before release if required ownership records cannot
be persisted; already-running work must still be stopped.
If the keeper is already gone, a separately bounded finalizer can reopen a
snapshot or reconstruct an overlay view from recorded inputs. It never requires
the dying workload to perform its own export. Exports label live/inconsistent,
complete, partial or failed results; shared host data has no implied point-in-time
consistency. Reconstructing retained overlays is an implementation gate.
Volatile tmpfs contents and unrecorded pipe buffers cannot be reconstructed after
namespace/process loss; their output modes must state that limitation.

Result records keep distinct fields for requested stop reason, observed command
exit/signal, manager result, OOM evidence, exit-observation completeness, and
cleanup failures. Scope success does not imply command success; scope timeout
can also describe manual-stop escalation. Hold manager references while observing
live runs and persist evidence promptly. A collector that arrives after a unit
disappears records unknown observations, never a fabricated success or OOM.

Stopping processes does not delete semaphore files, temporary directories or
snapshots. A durable ledger records allocation intent **before** each OS mutation,
then records the resulting resource identity. After a crash, the reaper can
reconcile the exact intended destination rather than search by filename pattern.
Reserve managed input dependencies in that same allocation-intent transaction.
Create exclusively inside unique owned directories; never adopt a pre-existing
destination during ordinary allocation. Release input references only after the
dependent allocation and its finalizers have finished.
Cleanup is idempotent and checks identity; conflicting paths or possibly live
users produce pending/error state rather than deletion underneath them.

## One place to operate and inspect

The operator chooses a store root; pools can live on other filesystems:

```text
/srv/hostfork/
  registry.sqlite                 durable lifecycle/resource transactions
  runs/<id>/manifest.json          portable diagnostic snapshot of registry state
  runs/<id>/commands/              command records and selected durable output
  runs/<id>/exports/               collected results
/mnt/btrfs/hostfork/<allocation>/  recorded snapshot allocations
```

The SQLite registry is authoritative, on a local filesystem, using short durable
transactions. Manifests and ownership markers aid inspection/recovery; they are
not competing writers of lifecycle truth. Locks/reservations coordinate create,
spawn, close and concurrent reapers without holding database transactions across
OS operations. If an allocator is still running, storage deletion waits and
reports pending status; enforcing the workload deadline does not wait.

`status`, `list`, `usage`, `reap` and `gc` use this inventory across active and
retained runs. Reaping completes lifecycle work; GC applies explicit retention
or operator-selected deletion. Defaults retain evidence until a policy or
explicit deletion is supplied. Retention durations begin at confirmed environment
execution stop, not first-command exit. Required finalization/dependency holds
delay deletion. Incomplete finalization is visible and retried;
discarding its remaining evidence is explicit. This can accumulate storage, so
report it rather than hide it behind an automatic quota.

Metrics include active/retained runs, log/export bytes, pool capacity, cleanup
backlog and age, failed operations and pending reclamation. Expensive Btrfs
shared/exclusive estimates are optional and marked with their measurement time.
Do not sum apparent tree sizes as physical utilization, enable qgroups implicitly,
or call an acknowledged deletion reclaimed space.

## Doctor, installation and command-line use

The CLI exports a Typer app/factory and delegates to async library operations.
Commands below are proposed:

| Command | Purpose |
| --- | --- |
| `doctor [--spec FILE] [--probe] --json` | Report configured and actually usable capabilities, evidence level, missing prerequisites and specific remedies. Explicit probes create disposable owned resources. |
| `support plan/install/status/uninstall` | Manage optional host integration with an inspectable, idempotent installation plan. |
| `plan --spec FILE` | Resolve trees, view, effective limits and lifetime without launching. |
| `run [--spec FILE] --cwd PATH --ttl 20m -- COMMAND...` | Execute and close the environment when this foreground command finishes. |
| `shell [--spec FILE] [--cwd PATH]` | Start Bash with the same environment options and inherited terminal. |
| `create`, `exec ID`, `stop ID` | Explicit persistent-environment workflow; command exit and environment stop are separate. |
| `list`, `status ID`, `usage`, `export ID`, `reap`, `gc` | Inspect, recover, extract and retire owned resources. |

All commands accept a selected store root. Simple run/shell invocations can be
specified entirely with CLI path options; spec files are optional. `create` is
the explicit persistent/detached workflow and requires an expiry or an explicit
until-stopped policy. File-based specs and CLI overrides compile to the same
request; the CLI exposes convenient private/read-only/shared
path options without introducing another configuration model. Reopening a run
restores management access and file-based evidence, not another process's Python
wait handle or live pipe endpoints.
Reopened management handles do not replace the creation ownership policy.
Finishing `exec ID` does not close that existing environment or extend its expiry.

Doctor checks namespace policy and relevant sysctls/LSM restrictions, identity
mapping, mount behavior, cgroup delegation/controllers, actual systemd features,
selected storage roots, permissions and support installation. It reports per-plan
capabilities instead of requiring a magic universal sysctl recipe.

`support install --user` installs a versioned reaper service/timer and finite
finalizer service template for the selected registry, with stable executable and
configuration paths. Scope deadlines work through the existing manager even
without this optional installation. A periodic reaper is recovery/retention
support, not the precise deadline clock. Manager completion hooks can accelerate
finalization after qualification; the periodic pass remains a backstop.

Installation plans show exact owned files, services, permissions, changes and
uninstall behavior. They do not silently format storage, alter sysctls, enable
user lingering, or run a global root daemon. Survival across logout requires
qualified manager lifetime; an explicit administrator preparation step can
enable lingering or provide system-level support. Uninstall removes integration,
not retained data, and reports active runs before removing their recovery path.
Interpreter moves and stale helper versions are doctor findings.

## Keeping a macOS implementation possible

Portability is a design requirement for the boundaries, not a promise of feature
or performance parity. Keep specs, lifecycle operations, named paths, artifacts,
retention and outcome records portable. Keep namespace descriptors, cgroups, systemd units and
pidfds in Linux diagnostics and implementation modules.

A future native macOS backend could start with private workspace copies, using
APFS cloning where available, plus cwd/environment configuration. It would
implement a `WorkspaceView`, with `env.paths` pointing at the relocated workspace.
That is a useful workflow, but it is not Linux's same-path host view; absolute
paths and installed dependencies are not automatically rewritten. APFS clone
support alone supplies neither that presentation nor a whole-host snapshot.
[Apple's APFS documentation](https://developer.apple.com/documentation/foundation/about-apple-file-system)

Capabilities describe presentation, storage consistency, descendant-ownership
coverage, direct/adapted process handles, aggregate limit enforcement, deadline
clock/failure domain, and recoverability separately. A requested strong capability
fails clearly if unavailable. An expert can explicitly choose a weaker supported
mode; there is no silent substitution of process groups for descendant ownership,
or per-process limits for aggregate budgets.

No macOS runtime, performance or helper-installation claim is made this iteration.
macOS service integration and packaging need validation on that platform; Apple's
current helper API has its own application-bundle and OS-approval model.
[Apple SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
The common API is not reduced to the lowest common feature set: Linux-specific
options remain available and visible in its resolved plan.

## Scope of the first implementation

Deliver the Linux library, configurable store, doctor, support installation,
shell/run CLI, reusable environments with owned command trees, prepared Btrfs
and overlays, independent deadlines, aggregate CPU/memory limits, durable result
records, export and repeatable cleanup/retention. Qualify the ownership handoff
before building out the rest.

Defer private PID mode, reconnectable PTYs, a resident observer, remote HTTP
launch/streaming, macOS implementation and GPUs. A small inspection/control
FastAPI adapter can follow the local release using the same library and registry;
it does not introduce another lifetime authority. Hostfork can later be composed
by the launcher through an optional dependency; application configuration and
MITM coordination remain with that consumer.

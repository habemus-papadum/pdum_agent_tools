# Hostfork detailed design notes

**Status: earlier exploratory proposal, superseded as the implementation baseline.**
Read the [architecture](architecture.md) and [implementation plan](../../plans/hostfork.md)
for the current proposal after spikes 020–024. These notes retain earlier API and
helper alternatives as background; they are not additional implementation requirements.
The workspace still ships two production packages; Hostfork remains unimplemented.

Start with [motivation and proposed direction](motivation.md) and
[host compatibility and storage](host-compatibility.md). Those shorter documents
set the direction. These notes explore implementation choices, including an
optional private PID namespace; their API shapes and helper arrangement are not
settled contracts. There is no backward-compatibility or migration requirement.

Add **`habemus-papadum-hostfork`**, imported as **`pdum.hostfork`**, with a
`pdum-hostfork` CLI. Its purpose is to derive a convenient Linux execution
environment from the installed host: reuse executables, libraries, datasets and
toolchains, give each run its own writable state, and reliably collect its
processes and results. No image build, registry, root filesystem download or
persistent daemon is required.

The central abstraction should be an **environment that owns multiple processes
and a filesystem view**. A command finishing does not destroy that view; the
caller can run a verifier, inspect files, export results and then close it.
This follows the repository's [trusted-operation principles](../../design-principles.md).
Selected private filesystem state reduces accidental interference. Hostfork makes no
security-boundary claim and does not change an agent's own sandbox policy.
Requested CPU and memory limits are real resource controls, independent of that
trust stance.

## Design considerations

| Concern | Implication for the library |
| --- | --- |
| Namespace setup can change user identity and mount propagation. | Use private mount propagation; make identity explicit and prefer preserving the caller's numeric UID/GID for host compatibility. |
| Overlays, tmpfs replacement and writable bind mounts provide different storage behavior. | These are useful filesystem primitives, but a namespace by itself leaves every unmodified host path shared. Compile an explicit view of the whole mount tree. |
| Application imports can create threads before namespace setup. | Use a fresh interpreter boundary. Do namespace setup before application imports or helper threads. Give control its own channel so stdin remains available to the workload. |
| A workload may need private settings, a writable workspace and a subsequent verifier. | Preserve original paths and allow several commands in one environment. Keep application configuration and verification logic in the application. |
| Workloads need logs, timeouts, file extraction and partial results after SIGTERM. | Make output handling, process termination and filesystem export library operations. Session interpretation and experiment summaries remain application concerns. |
| A process tracker may discard a command leader as soon as it exits. | A surviving descendant can be forgotten, including descendants that start a new session. Environment ownership must outlive the command leader. |
| Cleanup callbacks can fail, and terminating a direct child may leave descendants alive. | Return a structured cleanup outcome, retain failed state, and provide an independent path for owner death and SIGKILL. |
| Copying overlay upper-layer files collects content without a complete change record. | Deletions, opaque directories, symlinks and metadata need explicit semantics. |

Lifecycle requirements:

- Enter the mounted view explicitly, escape it before
  unmounting, and retain directory descriptors for restoring the working directory.
- Reject namespace setup after additional threads exist.
- Provide lifecycle ownership, signal handling and a parent watchdog,
  with real subprocess tests.
- Stop the workload before mount cleanup and copy the final log
  after cleanup has had a chance to report failures.
- Separate overlay layers from mount targets and support disk storage
  alongside temporary storage.

The API should own these responsibilities. Lifecycle tests must cover direct
children, SIGTERM, and escaped or orphaned descendants.

## What a derived host means

Hostfork reuses the host's files and kernel. It does not clone running services,
Python memory, open connections or the host's process tree. A fresh Python worker
can import the same installed code after setup, including the selected virtual
environment, provided those paths are visible in the requested view.

There are two distinct filesystem guarantees:

- **Private writes:** a native snapshot, reflink copy or overlay provides writable
  state owned by the run; a read-only bind rejects writes through that mount.
- **Stable input:** a snapshot or prepared immutable source fixes what the run
  reads. A reference to the live host does not provide this guarantee.

In particular, changing an underlying tree while OverlayFS uses it has undefined
behavior. A read-only bind of that tree does not stop another host process from
changing it. Whole-host copy-on-write therefore requires a stable base or an
explicitly accepted live-base limitation. This is a substantive constraint on the
meaning of “fork,” not a security restriction.
[Linux OverlayFS documentation](https://docs.kernel.org/filesystems/overlayfs.html#changes-to-underlying-filesystems)

Start with the inherited host view, retaining its existing sharing. Apply private,
read-only and shared rules selectively; show inherited writable state in the plan.
Do not implicitly replace runtime directories or make all host paths read-only.
An experiment preset may select private workspace, configuration and scratch paths.

Treat native Btrfs snapshots as an initial candidate for private storage, alongside
reflinks, overlays and ordinary copies. A native snapshot can directly provide the
writable tree; it need not be an overlay's lower layer. Backend selection must
preserve the requested consistency guarantee. Broader copy-on-write coverage needs
an explicit plan for each filesystem and live endpoint involved. The storage
comparison and host constraints are in [host compatibility](host-compatibility.md).

## Filesystem specification

Use small typed Python specifications, serializable for the helper protocol and
CLI, with a nonmutating `plan()` operation. Do not create a general policy engine.

| Rule | Meaning |
| --- | --- |
| `ReadOnly(source, target)` | Reuse host content through a read-only mount. |
| `Cow(source, target, storage=...)` | Provide private writable state using a qualified native snapshot, reflink copy or overlay; report source consistency separately. |
| `Fresh(target, storage=...)` | Empty private directory, optionally seeded with explicitly selected files. |
| `Copy(source, target)` | Materialize an independent initial copy for small mutable configuration. |
| `Shared(source, target)` | Deliberately writable host binding, for results or a coordinated shared cache. |
| `Hide(target)` | Omit a path from the derived view. |

`source` always names the host-side input; `target` always names the path seen by
the workload. File bindings as well as directory bindings are useful. The plan
shows effective rules, writable shared paths, storage locations, nested mounts,
required capabilities and compatibility warnings. Duplicate targets conflict;
explicit descendant rules override ancestors, applied from parents to children.

The Linux implementation should inherit the host mount topology into a private
mount namespace, then apply the requested view. A separately assembled root is
an implementation option when the requested transformation needs it. Preserve symlinks such as `/bin`
and symlinked workspaces. Apply read-only behavior recursively where requested,
including child mounts; failing to do so must be a planning/setup error. Create
missing mount points only in private scaffolding. Resolve and retain source
references before covering their paths, and change directory only after mounting.
Close inherited working-directory and source descriptors before workload exec.

Keep runtime storage outside the copied source trees, or explicitly carve it out
of the view. Reject recursive source/upper/work arrangements and ambiguous aliases
that could write back to the source. Overlay upper/work directories are unique to
one run and live on the same filesystem when using OverlayFS. Native snapshot
storage instead needs ownership of the created subvolumes and their lifecycle.
Do not silently replace failed private storage with a writable source binding.
The overlay backend has backing-filesystem constraints
and represents deletions with whiteouts and opaque directories.
[OverlayFS storage semantics](https://docs.kernel.org/filesystems/overlayfs.html)

Default private writable storage should be disk-backed under an operator-selected
state root, because many concurrent experiments and post-failure recovery matter.
Tmpfs remains an explicit fast, disposable option; its memory consumption and
loss when the namespace disappears must be visible. No implicit per-run storage
quota is proposed. Report bytes, inodes, capacity and actual write failures.
Choose tmpfs size limits only when requested; document the kernel's effective
mount limit even when the application did not supply one.

The compatibility baseline uses a private mount namespace while preserving host
networking, process visibility, IPC and runtime endpoints. User-namespace setup
depends on backend privileges and must diagnose any identity/access differences.
Private PID, IPC, UTS or network namespaces are explicit options, independent of
filesystem rules. A selected private PID namespace needs a matching `/proc`.
Treat `/dev`, `/sys`, resolver files and `/dev/pts` as live facilities. If selected
runtime directories become private, preserve required endpoints and adapt `TMPDIR`
and XDG paths. Resolve `/etc/resolv.conf` correctly when it links into `/run`.

Host networking preserves upstream connectivity and simple MITM integration, but
also shares ports, loopback services and abstract Unix sockets. Prefer dynamic
port allocation by the actual server; finding a free port and closing it does
not reserve it. Offer private loopback networking later, followed separately by
an outbound networking adapter if needed. Neither mode is an authorization policy.

Preserving numeric UID/GID needs a tested user-namespace mapping. Single-user
mapping does not reproduce arbitrary ownership or supplementary groups; surface
incompatible group-owned datasets and devices. Mapping the operator to namespace
root can remain an explicit alternative. No automatic sudo escalation is needed.

## Python API shape

This sketch illustrates the proposed contracts, not executable package APIs:

```python
import sys
from pathlib import Path

from pdum.hostfork import Cow, EnvironmentSpec, HostView, Limits, Output, open_environment


async def experiment(project: Path, results: Path) -> None:
    spec = EnvironmentSpec(
        view=HostView.from_host(
            rules=[Cow(source=project, target=project, storage="disk")],
        ),
        limits=Limits(memory_bytes=8 * 1024**3, cpu_cores=2.0),
        network="host",
        retain_on_error=True,
    )

    async with open_environment(spec) as env:
        worker = await env.spawn(
            [sys.executable, "-m", "my_experiment.worker"],
            cwd=project,
            stdout=Output.spool(),
            stderr=Output.spool(),
        )
        result = await worker.wait(timeout=900, on_timeout="stop_tree")

        check = await env.run(
            ["my-verifier", "result.txt"],
            cwd=project,
            timeout=120,
        )
        await env.stop_workloads()
        export = await env.fs.export_tree(
            project / "results",
            destination=results,
        )
        # result, check and export have independent success/failure fields.
```

`HostView.from_host()` preserves the host view except for explicit rules. Requested limits are
mandatory for this invocation: failure to enforce them prevents workload launch.
Omitting `limits` means no new application-imposed CPU/memory limits.

`spawn()` returns a `ProcessHandle` with stable run/process IDs, host and namespace
PIDs, stdin, output access, exit information and process-tree control. `run()` is
the convenience form that starts and waits. `wait()` observes exit without closing
the environment; cancelling a waiter alone does not kill the workload. Timeout
actions are explicit. Leaving the environment context always initiates its
idempotent close operation, shielded from cancellation and bounded by deadlines.

Expose lifecycle states such as `preparing`, `ready`, `stopping`, `exporting`,
`closed` and `cleanup_failed`. Workload exit is a process event within a ready
environment. `stop_workloads()` establishes a quiescent view for inspection;
closing releases the environment. Retained disk artifacts are separately tracked
and do not imply a still-running namespace.

For Python functions, provide an eventual convenience wrapper over the same
subprocess contract: an importable `module:function` plus JSON input/result or
explicit files. Import application code only after isolation is ready. Do not
promise transparent execution of closures, existing interpreter state or arbitrary
pickled objects. Ordinary `python -m` and arbitrary executable argv are sufficient
for the first slice.

The process API should support named sidecars and a simple readiness
contract with a timeout. An essential sidecar failing becomes an environment
event; the caller selects whether to stop the workload. Shutdown order can be an
explicit list, with consumers stopping before their dependencies. Automatic
restart and a general dependency scheduler are unnecessary initially.

## Process ownership and cleanup

Keep namespace work out of the application's interpreter, including threaded
notebooks and ASGI processes. `CLONE_NEWUSER` requires a nonthreaded caller, and
creating a PID namespace affects subsequently created children.
[Linux unshare semantics](https://man7.org/linux/man-pages/man2/unshare.2.html)

```text
Python application or foreground CLI
    EnvironmentHandle and optional Controller
            |
            | private control socket and owner-lifetime pipe
            v
    small host-side supervisor
            |
            v
    filesystem keeper (also PID 1 when private PID mode is selected)
            +-- worker and descendants
            +-- named sidecar and descendants
            +-- verifier or inspection helper
```

This arrangement sketches the private PID option. For the host-compatible process
view, use validated cgroup ownership and a filesystem keeper without PID isolation;
do not depend on namespace-init death to collect descendants. Missing delegation
is a capability failure for that ownership contract, not permission to silently
weaken cleanup or change process visibility.

For private PID mode, start with a minimal exec-launched helper and a namespace init process. The outer
supervisor watches owner loss and init failure; init reaps descendants and holds
the mounted view. Keep the helper stdlib-only with no application imports or
threads before namespace setup. A fork performed by that deliberately
single-threaded helper is different from a pre-exec callback in a threaded host
application. Benchmark the two helper processes before adding a native component
or attempting to collapse their responsibilities.

Use a separate control socket, passing output/file descriptors where practical.
Workload output must never be parsed as control messages. The owner-lifetime pipe
is closed in workload children, so a surviving grandchild cannot keep ownership
alive accidentally. Use pidfds for live identities and a journal containing run
ID, boot ID, PID/start identity, owned paths, namespace identity and cgroup identity
for recovery. PID numbers alone are insufficient authority to stop or remove.

A private PID namespace supplies a final containment mechanism: when its init
exits, the kernel kills the other processes in that namespace. Keep init alive
through ordinary workload shutdown so exports can still read the mounted view.
PID-namespace ownership does not automatically disappear merely because the
external caller died; the supervisor must react to the owner-lifetime channel.
[Linux PID namespace semantics](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)

Use delegated cgroup v2 membership when available, even without numeric limits.
Keep init/supervision outside the workload subtree so killing all workloads or
their OOM group does not intentionally destroy the export mechanism. Each named
process can own a child cgroup, so stopping its tree remains possible after its
leader exits. Move the child into its group before exec, using a startup handshake
that prevents it from spawning descendants first. All workload groups share an
aggregate parent for run limits.

In private PID mode without delegation, retain PID-namespace-wide cleanup and label narrower
per-command tree control as reduced capability. Namespace init can reap orphans
and perform whole-workload termination before exporting; if it cannot establish
quiescence by the deadline, terminate init and report the artifact limitation.
Never advertise a process group as equivalent to arbitrary descendant ownership.

Normal close follows a fixed order:

1. Reject new spawns and serialize concurrent stop/close operations.
2. Signal workloads in the requested dependency order; continue draining output.
3. After grace expires, kill remaining workload groups and wait for empty groups
   and reaping. Preserve the keeper while possible.
4. Export configured artifacts from a quiescent view, drain output and record
   command results separately from export and cleanup errors.
5. Close workload descriptors, unmount in reverse dependency order, stop the keeper,
   close namespace descriptors and remove empty owned cgroups.
6. Remove or retain private storage according to the selected policy. Keep
   recovery metadata whenever teardown is incomplete.

Every acquisition immediately registers its reversal, including partial startup.
Return a `CleanupReport` listing remaining processes, mounts, cgroups, paths and
errors. A deadline can bound waiting; it cannot guarantee immediate removal of
tasks stuck in uninterruptible kernel I/O. A lazy unmount is not evidence of
complete release. Never recursively delete a directory while its mount ownership
is uncertain, or remove backing storage while live users may still hold it.

On external owner death, the supervisor initiates the same bounded shutdown.
In private PID mode, init death terminates workloads through namespace teardown.
With host process visibility, recovery must instead collect the owned cgroups.
Disk storage and journals support later inspection. Loss of all helpers, machine failure or an unmount
failure may require `recover`. Recovery first verifies ownership and reports a
plan, then removes only proven stale resources. It does not adopt an arbitrary
existing process as a managed environment. Tmpfs artifacts cannot be promised
after loss of the keeper, and disk layers need stable matching lower inputs for
faithful reconstruction.

## Output and artifact access

Provide explicit output modes: inherited descriptor, caller-owned pipe, direct
file, discard and managed spool. Managed spool drains stdout and stderr
independently into host-side run files; asynchronous subscribers read by offset.
This eliminates `tail` subprocesses and lets a UI reconnect without owning pipe
drainage. Bytes are the primary interface; line decoding is optional. A caller
choosing pipes owns drainage. Waiting while pipe buffers fill can deadlock.
[Python subprocess guidance](https://docs.python.org/3/library/asyncio-subprocess.html#asyncio.subprocess.Process.wait)

Disk exhaustion and failed subscribers become visible status/events. Do not add
silent truncation or implicit capture quotas. Spooling avoids tying a child's
progress to a slow subscriber, but physical storage can still block or fail;
there is no lossless, nonblocking, finite-resource guarantee. Choose and report
the action on an actual spool failure. Child exit, stream EOF and completed
spooling are distinct states, especially when descendants inherit descriptors.

Keep three filesystem operations distinct:

| Operation | Contract |
| --- | --- |
| `read` / `list` / `stat` | Inspect the merged view through the keeper. Live reads may race with writers. |
| `export_tree` / `export_files` | Copy selected final visible content to a host destination, normally after stopping workloads. |
| `changes` / `export_changes` | Describe added, modified and removed paths with file types and metadata; copy visible content for changed files and represent deletions explicitly. |

Export from the mounted view. Treat overlay metadata as an implementation detail
of that backend used to find candidates, not as a portable patch format. Native
snapshot backends can compare retained baselines and final trees without an overlay
upper directory; efficient backend-specific change discovery is a separate choice.
A complete change export
must account for opaque directories, replacement of file types, rename behavior,
whiteouts and metadata-only changes. Qualify a restricted set of overlay options
first; disable or reject unimplemented metadata features. Preserve symlinks by
default, define hardlink behavior, and report unsupported sockets/devices. A
read-only remount is not a substitute for coordinating writers or shared mounts.

Host-side outputs have an explicit destination independent of namespace paths.
Use a temporary destination plus publication by rename where possible; refuse
accidental overwrite unless requested. Failed exports retain recoverable state.
Export does not merge changes back into the source tree. Source writeback, with
conflict handling, can be a separate later operation.

PTY support fits as another process I/O mode later: allocate a PTY and private
devpts, establish a controlling terminal and process session, forward resize and
signals, and handle disconnects explicitly. PTY mode normally combines stdout and
stderr; it cannot promise the separate-stream semantics of pipes. None of this
requires importing code to change the caller's terminal or install signal handlers.

## Resource controls and doctor

Resource limits apply to the whole workload subtree, including sidecars, helper
commands and descendants. Document supervisor overhead and keeper-created storage
charges separately: a workload limit is not a ceiling on the entire runtime.
An optional outer budget can include both control and workload groups, with the
explicit consequence that an OOM may also remove the keeper and prevent export.
Prefer a delegated cgroup v2 subtree supplied by the application or a transient systemd
user unit with delegation. Namespace privileges do not grant arbitrary authority
over the host cgroup hierarchy. Respect systemd's ownership instead of writing
into unrelated service trees.
[systemd delegation guidance](https://systemd.io/CGROUP_DELEGATION/)

| Requested setting | Kernel mechanism |
| --- | --- |
| Aggregate CPU allowance, including fractional cores | `cpu.max`; a time allowance, not dedicated physical cores. |
| Relative CPU share | `cpu.weight`; separate from a hard cap. |
| Memory ceiling | `memory.max`; expose `memory.high` separately if requested. |
| Swap ceiling | `memory.swap.max`; memory and swap choices are distinct. |
| Optional task count or CPU placement | `pids.max` and `cpuset`, when delegated. |
| Whole workload kill and completion | `cgroup.kill`, then verify `cgroup.events` population. |

Report effective ancestor restrictions, CPU throttling, memory usage and OOM
events. An OOM event is distinct from a generic exit code; accounting can include
file cache and tmpfs rather than just summed process RSS. Requested unavailable
limits fail before workload exec. An omitted limit never means unlimited host
resources. Keep internal cgroup nodes empty where controllers require it.
[Linux cgroup v2 interfaces](https://docs.kernel.org/admin-guide/cgroup-v2.html)

`pdum-hostfork doctor` should report **capabilities for this invocation and storage
location**, with `available`, `unavailable` and `untested` states. Its optional
`--probe` exercises disposable resources using the same backend as real launch.
Without probes, report inferred prerequisites separately from verified capability.

| Check | Evidence and useful diagnosis |
| --- | --- |
| Namespace creation | Actual user/mount/PID/IPC/UTS setup, not just a kernel-version guess. Check namespace count limits and relevant sysctls where present. |
| Host restrictions | Inspect `kernel.unprivileged_userns_clone` and `kernel.apparmor_restrict_unprivileged_userns` when available; distinguish missing settings from disabled capabilities and report other observed denial causes. |
| Filesystem behavior | Probe overlay, tmpfs, bind and recursive read-only behavior on representative disposable directories on the intended filesystems; check upper/work compatibility, space and inodes. |
| Cgroups | Discover a delegated subtree, test creation and cleanup of a child, controller availability and workload placement. A read-only cgroup listing does not prove delegation. |
| Ownership and I/O | Check pidfds, owner-loss handling, file descriptor headroom and later PTY support. |
| Requested plan | Validate executable, interpreter, cwd, source paths, nested mounts and all mandatory capabilities; revalidate immediately before launch. |

Doctor prints concise remediation matched to the actual failure. Individual
sysctl settings are useful clues, but not universal prerequisites. Ubuntu's
AppArmor restrictions can depend on application profiles as well as the global
setting. Display relevant local configuration options without rewriting sysctls,
profiles or service units during diagnosis.
[Ubuntu AppArmor documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/)

GPU support should begin later with device selection and explicit reporting of
shared access. Visibility variables do not enforce fractional compute or memory.
MIG, MPS or another provider-specific allocator needs a separate adapter and
measured guarantees. Avoid adding a pretend generic GPU percentage to `Limits`.

## Controller and package composition

An application-owned `Controller` holds environment handles and offers create,
inspect, list processes, spawn, stop, export and close. Status includes effective
filesystem sharing, process identities, resource usage, output offsets, artifact
state, capability gaps and cleanup progress. Typed lifecycle events can carry
sequence numbers for observation without requiring an external telemetry system.

Keep FastAPI in an optional `management` extra. `create_app(controller)` or an
`APIRouter` delegates to the same owner; application import and router mounting
create no processes or signal handlers. The host application owns controller and
HTTP lifetimes. Long exports/stops return operation IDs and progress; a client
disconnect does not abandon cleanup. Initially there is no daemon, detached
launch, automatic restart or attach-to-arbitrary-environment mode.

Candidate routes are `GET /environments`, `GET /environments/{id}`,
`POST /environments/{id}/processes`, `POST /environments/{id}/stop`,
`POST /environments/{id}/exports`, output reads by byte offset, and event streams.
Mutations serialize against close, and repeated close requests share one result.
Creation retries use request identity to avoid starting duplicate workloads.
Follow the trusted-network defaults, including configurable all-interface TCP
listeners, without introducing mandatory client grants.

Use Typer with exported `app` and `create_app()` for `doctor`, `plan`, foreground
`run`, `status` and verified `recover`. Rich renders plans and reports; JSON output
serves automation. The core is async and independently useful. Put it under
`packages/hostfork/src/pdum/hostfork/` only after the proposal is accepted, sharing
the root uv workspace, compatibility policy and human-managed release process.

The Codex launcher can depend on a future optional `hostfork` extra. Its adapter
translates the chosen profile and working directory into a view, while native
configuration and authentication remain launcher concerns. Hostfork owns the OS
process tree; the launcher owns app-server protocol readiness and the profile
lease. In that mode the launcher stops through the environment handle rather
than independently killing the same PID/group. Keep profile lease/journal state
outside any private copy of profile content so concurrent ownership remains clear.

Initially keep MITM and the client relay on the host side, where existing capture
and readiness APIs already work. Host networking makes their endpoints reachable;
the view must also expose scoped CA files and configuration paths as needed. A
sidecar that needs private filesystem access can later run inside the environment.
Hostfork never imports MITM or Codex; their application adapter coordinates
readiness and stops the consumer before draining its proxy. Do not introduce a
shared supervisor abstraction into both existing packages merely for symmetry.

## Implementation sequence and acceptance gates

| Stage | Deliverable | Required evidence |
| --- | --- | --- |
| 0 | Doctor, view planner and storage comparison. | Investigate native Btrfs snapshots and overlays from the start; qualify inherited mounts, live endpoints, identity and cgroup delegation before freezing API details. |
| 1 | Async environment, fresh helper, filesystem rules, multiple execs, basic output and selected-file export. | Qualify the host-compatible process view and optional private PID mode separately; concurrent private trees preserve sources and existing software can reach selected host services. |
| 2 | Cgroup accounting/limits, reliable tree stop, owner-death recovery and complete cleanup reports. | Detached descendants, exited leaders, forced owner/helper death, OOM and busy mounts have verified outcomes. Requested limits never silently disappear. |
| 3 | Managed output subscriptions, named sidecars, change manifests and portable artifact export. | Slow readers, inherited descriptors, disk failure, deletion/rename/symlink regressions and failed export retention. |
| 4 | Controller, thin FastAPI adapter and Codex-launcher integration. | One lifecycle owner, concurrent stop requests, disconnect during export, profile ownership and host-side MITM composition. |
| 5 | PTY, broader root copy-on-write, optional private networking and GPU adapters. | Qualify each capability separately; no general host-clone or GPU-fraction guarantee based on an API sketch. |

Stages 1 and 2 form the first dependable experiment runtime. Evaluate bubblewrap as a possible mount/bootstrap helper
during stage 0: it already addresses namespace setup and PID reaping, but adopting
it still leaves our environment API, persistent view, exports and resource
ownership to solve. Compare that concrete path against a small private syscall
helper; avoid starting with a public multi-backend framework.
[Bubblewrap project documentation](https://github.com/containers/bubblewrap/blob/main/README.md)

Experiment scheduling, prompts, application configuration, result validation and
session interpretation remain application responsibilities. Namespace setup,
process ownership, output and extraction belong to Hostfork.

Performance qualification should reproduce the intended scale: measure 1, 10,
100 and several hundred concurrent lightweight environments, followed by repeated
create/close cycles. Record startup/teardown latency, aggregate proportional memory,
CPU, descriptor count, mount/namespace/cgroup counts and storage use, including
after injected failures. Assert return to baseline for owned resources and no
cross-run file changes. Avoid per-environment polling threads, full filesystem
scans on startup or eager copies of toolchains. Initial measurements of the
research runtime appear in [spike findings](spike-findings.md); the proposed
production implementation still needs its own qualification.

## Local investigation evidence

On 2026-10-13, this host reported Linux `7.0.0-31-generic`,
`kernel.unprivileged_userns_clone=1`,
`kernel.apparmor_restrict_unprivileged_userns=0` and
`user.max_user_namespaces=115535`.

A disposable `unshare --user --map-current-user --mount --pid --fork
--mount-proc` probe succeeded with UID 1000 and namespace PID 1. That establishes
basic facilities, not the proposed supervisor or root-view implementation.

Cgroup v2 was present; the current session exposed `cpu memory pids` controllers,
but neither its directory nor `cgroup.procs` was writable by the caller. Direct
delegation from this session is unavailable. Subsequent transient user systemd
service tests did enforce memory/CPU limits and external deadlines. No sysctls or
persistent machine configuration were changed.

Subsequent [spikes 020–023](spike-findings.md) exercised a research supervisor,
selective filesystem views, prepared Btrfs storage, 200 concurrent environments
and forced failures. These findings do not qualify the entire proposed API or
host-PID backend.

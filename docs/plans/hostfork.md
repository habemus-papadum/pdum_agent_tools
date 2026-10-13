# Hostfork implementation plan

**Design baseline, 2026-10-13; Linux implementation now delivered.**
See the [operator/API guide](../hostfork.md) and [qualification record](../hostfork-validation.md)
for implemented behavior, actual test results and outstanding host-specific gates.
Use the [architecture](../specs/hostfork/architecture.md) as the design baseline.
This is a new library, not a migration of the research helper arrangement. All
interfaces shown there are proposed until their implementation gates pass.

## Delivery order

Prove one complete ownership/lifetime path first. Build storage and operational
tools around that path, then qualify failure recovery and scale. Keep stages
usable and observable, but do not label a stage the complete library.

| Stage | Deliverable | Exit condition |
| --- | --- | --- |
| 0 | Runtime handoff qualification | Multiple direct Python children safely enter one delegated environment, retain normal I/O/wait, and cannot survive stop via an admission race. |
| 1 | Small Linux library and shell | Own a reusable view, run multiple commands, bound runtime, stop descendants, retain an honest result and recover a killed owner. |
| 2 | Private storage and export | Prepared Btrfs, stable overlays and small copies have recoverable allocation/release and correct retained-view export. |
| 3 | Host and operations tools | Doctor, explicit systemd support installation, retention, inventory and utilization work without the original caller. |
| 4 | Reliability and scale qualification | Crash/full-disk/churn tests pass; actual capacity and supported platform matrix are published. |
| Later | Additional backends/adapters | Private PID, PTY, FastAPI, macOS and GPUs meet their own contracts without changing resource ownership. |

Runtime, storage and tooling authors can work in parallel after stage 0 fixes the
resource records and backend contracts. One coordinator owns manifests, lockfile,
documentation navigation and integration tests.

## 0. Resolve the remaining Linux handoff questions

Spike 024 proved fresh-scope adoption, ordinary asyncio handles, arbitrary
descendant inheritance and deadlines after owner kill/freeze. It did **not**
qualify reusable namespace joining, command subgroups, or concurrent close during
handoff. Do these as a bounded prototype before stabilizing the public API.

- Create one delegated environment scope with keeper and command leaves. Verify
  controller enablement, recursive accounting, aggregate CPU/memory behavior,
  OOM-group semantics, command-level kill and environment-level stop.
- Spawn a fresh direct asyncio child for each command. Adopt by pidfd into a
  staging scope where needed, self-place in its destination leaf, join the
  keeper's user/mount namespaces, report readiness, then exec. Preserve PID,
  parent, stdin/stdout/stderr, cwd and environment for the host-PID mode.
- Use a verified keeper identity/pidfd for namespace entry where supported;
  do not hold long-lived mount-namespace FDs in the outside caller. Test a frozen
  caller to prove namespace resources can be released after workload death.
- Prove gate EOF abort, exact identity checks, no leaked control descriptors,
  cancellation at each transition, and no application execution after a failed
  registration or an expired/revoked reservation.
- Every staging scope must have its own bounded, manager-acknowledged deadline
  within the environment force-stop budget, including its termination grace.
  Test slow registration and near-expiry launches;
  a handoff must not reset or lengthen the environment's lifetime.
- Race spawn against normal stop, deadline and a second reaper. Revoke in-flight
  gates before claiming the environment empty; a surviving outside gate must
  never repopulate a cgroup after the shutdown check.
- Verify monotonic clock/start semantics and arm graceful termination before
  force-stop. Pre-activation setup is separately bounded; a rejected or stalled
  setup must not silently create an unbounded allocation worker.

A narrow architecture-review probe on the existing systemd 255 host confirmed
that direct self-placement from the caller's session scope can fail with EACCES,
while PIDFD staging followed by self-placement into a delegated scope works.
This establishes a candidate mechanism, not completion of the above matrix.
Existing-scope numeric-PID attachment is not an acceptable identity shortcut.

If the combined path fails, keep the public lifecycle model and revise this
Linux mechanism before advancing. Do not silently substitute a broker/wrapper
while claiming a native target-process handle.

## 1. Build the smallest complete library

Create `packages/hostfork/src/pdum/hostfork/`, tests and a `py.typed` marker;
distribution `habemus-papadum-hostfork`, Python 3.12+. Use the root uv workspace
and existing release conventions; do not promote research dependencies wholesale
or hand-edit versions. Imports and CLI mounting start no processes or handlers.

Suggested internal organization:

```text
models.py, planner.py             requests, resolved plans, capabilities, outcomes
environment.py, command.py       public async lifecycle and process handles
store.py, recovery.py             durable ownership and reconciliation
storage/                         private-tree implementations
backends/linux/                  manager, cgroup, namespace and fresh-exec helpers
doctor.py, support.py             host diagnosis and explicit integration setup
cli.py                           mountable Typer app/factory
```

Keep these as modules, not a framework of installable plugins. Use one small
keeper per environment and short-lived launch helpers; start in Python where
correctness allows. A native helper is a measured optimization, not a prerequisite.
Use a persistent async D-Bus transport for FD passing and unit references rather
than shelling out on the final launch path. The transport choice must work on
the supported Python versions; the research dependency is not automatically
the production choice.

Implement the store's allocation/reservation ledger before allocating resources.
Record IDs, backend versions, owner/process identities, manager units, intended
paths, operation state, clocks, retention and observations. SQLite transactions
must remain short; use generation/claim records for OS operations outside them.
Persist manifest snapshots for inspection, and recover interrupted transitions
instead of treating a missing final write as a successful cleanup.

Deliver inherited host view plus explicit shared/read-only/private-empty paths,
multiple commands and sidecars, direct process/pipe access, durable file output,
aggregate limits, fixed lifetime, owner-exit policy, explicit detach, and command
vs environment stop. Ordinary context exit stops the environment even after
an exception; cancellation cannot silently abandon already-created resources.
Reopening an environment restores management, not native wait/pipe handles from
its prior owner. Begin CLI `plan`, `run`, `shell`, `create`, `exec`, `stop`, `status`.

**Gate:** a worker and sidecar run concurrently, the worker creates library/native
descendants, a verifier follows, and cleanup succeeds after normal completion,
application error, owner SIGKILL, frozen owner, keeper loss, timeout and real OOM.
Per-command tree stop must preserve the other command and keeper. Preserve raw
returncode, control decision and incomplete observations independently.

## 2. Complete private storage and forensic extraction

Implement the storage interface against prepared Btrfs subvolumes, stable overlay
lowers and ordinary copies. Accept separately configured allocation roots; record
filesystem/subvolume identity as well as paths. Baseline registration records
whether inputs are borrowed or managed and how they must be retained.

Do not add automatic device formatting. Provide a host-preparation recipe and
inspect/register commands for existing pools and baselines. An AMI/EBS preparation
pipeline can construct this layout outside Hostfork. Namespace presentation then
mounts the selected private trees at requested paths without copying host services.

Implement reopening and export of stopped trees, including reconstructing an
overlay's merged content with whiteouts/opaque directories interpreted correctly.
Upper-directory copies are not final-view exports. Export into a temporary owned
destination, publish completed results distinctly, and retain partial output with
an explicit manifest when interrupted. Stop/finalization budgets are separate.

**Gate:** baseline preservation, hardlink/symlink/metadata behavior, nested mounts
and subvolumes, socket directory sharing, native snapshot survival, private
`/dev/shm` leftovers, stable-lower dependencies, source disappearance, and export
after keeper loss. Inject crashes before/after each allocation and record update;
recovery finds the exact resources without deleting borrowed inputs or wrong paths.

## 3. Installable host support and routine operations

Doctor has inspection mode and explicit disposable probes. Report capability
dimensions and their evidence: observed here, inferred from configuration,
unsupported, or untested. Verify the actual requested storage roots and launch
context, not just kernel/systemd version strings. Inspect relevant sysctls,
LSM restrictions, identity mapping, delegation, CPU/memory controls and runtime
timer support. Provide specific remedies without changing policy during diagnosis.

Implement `support plan/install/status/uninstall --user` using owned, versioned
files and stable interpreter/configuration paths. Names include the registry
identity to avoid collisions between stores. Install a periodic reaper and finite
finalizer template, reload the user manager and verify units. Repeat installation
must be idempotent; edited or conflicting files produce a visible conflict.
No implicit sysctl, device, lingering or system-service changes. Document explicit
administrator preparation for those needs and the difference between surviving
caller exit, logout and machine reboot. Keep recovery code compatible with stored
schema/helper versions during package upgrades.

The same reaper works as a Python call, CLI one-shot or timer invocation. It stops
expired work independently of storage locks, recovers incomplete finalization,
applies eligible retention, deletes only owned resources and tracks pending
reclamation. A busy allocator or uncertain live mount becomes a retryable pending
resource. It is not permission to recursively remove a configured storage root.
Uninstall reports active runs and preserves retained files; forced removal of
integration is an explicit operator choice, not silent deletion of data.

Expose JSON and Rich presentation for list/status/usage. Measure pool capacity,
Btrfs data and metadata pressure, logs/exports, retained counts, oldest incomplete
cleanup and deletion backlog. Expensive shared/exclusive accounting is requested
or sampled separately, with unknown values kept unknown. No default qgroups,
disk quotas, forensic truncation or automatic baseline garbage collection.

**Gate:** kill the caller and run recovery from a new process; run two reapers;
freeze a storage operation; interrupt install/uninstall; move the interpreter;
restart the user manager; and perform a reboot-recovery test on a disposable host.
Verify bounded cleanup jobs, configured retention, stale/conflicting paths and
systemd result collection after owner death. When final status is unrecoverable,
the stored result must say so.

## 4. Qualify the release and its operating envelope

Run real integration tests on supported Linux hosts with cgroup v2 and a usable
systemd manager. Start qualification at the tested systemd 255 feature set, then
publish the actual minimum feature/version matrix; do not infer support from one
version comparison. Include Python 3.12, 3.13 and 3.14. Capability skips in ordinary
CI must be visible and cannot replace required prepared-host qualification.

Measure warm/cold launch, registration/handoff, private-tree creation, first-write
cost, shutdown, export and eventual reclamation separately. Exercise serial and
concurrent runs at 1, 10, 100 and 200 environments, then sustained churn with
retention/reaping enabled. Record throughput, percentiles, CPU, PSS/RSS, FDs, tasks,
mounts, manager units, SQLite contention and pool consumption; compare like-sized
workloads with the spikes. The keeper/helper count is a measurement, not a target
to optimize before lifecycle correctness.

Use both ordinary ext4-overlay hosts and prepared Btrfs storage. Real EBS/AMI
numbers require a provisioned host and are a separately recorded qualification;
the disposable loopback image results are not cloud-volume performance evidence.
Exercise allocation-pool full, metadata pressure, log/state-write failures,
inaccessible roots, interrupted export/deletion and repeated owner crashes.
Assert that failed ownership persistence prevents new workload release, while
failed stop-event persistence never prevents terminating an existing workload.

**Release gate:** no live owned processes, cgroups, staging units or namespaces
after each completed cleanup audit; retained artifacts and pending reclamation
are explicitly accounted for. Fault-injected incomplete cleanup remains visible
and recoverable. Run lint, strict documentation, package builds and wheel-based
integration checks. Update implementation status and examples only for behavior
actually delivered. Release execution stays human-operated.

## Follow-on work and portability gate

- **Private PID mode:** implement namespace init/reaping and an explicitly adapted
  process handle; verify exit/signal propagation and library descendants again.
- **PTY:** qualify job control, resize, Ctrl-C, EOF, detach and output persistence.
  Existing-terminal shell inheritance does not prove this feature.
- **FastAPI:** begin with inspection/status/stop/reap over an existing store.
  Remote launch and streaming require an explicit I/O ownership contract; the
  adapter must not invent another supervisor or namespace owner.
- **macOS:** on actual hardware, qualify private-tree creation, relocated workspace
  presentation, process ownership, manager integration and packaging separately.
  Publish supported and weaker modes. APFS cloning, process groups and per-process
  rlimits are not substitutes for same-path presentation or aggregate enforcement.
- **GPUs:** design allocation and accounting after a real device/partition backend
  exists; reserve namespaced backend options, not a speculative fractional-GPU API.

Core model tests may use a test backend that explicitly lacks Linux capabilities
to catch accidental assumptions. Such tests prove negotiation behavior only;
they are not macOS runtime validation. Avoid POSIX path identities, pidfds or
systemd property dictionaries in the portable public lifecycle contract.

## Review incorporated

Independent runtime, storage and portability reviews shaped this proposal.
The main resulting decisions are PIDFD-safe staging for later direct children;
explicit admission fencing; separate direct/adapted process contracts; allocation
intent before mutation; storage recovery independent of workload death; and
workspace relocation as a distinct future presentation capability. These are
design conclusions with the validation gates above, not new production claims.

# Python-owned launch with an independent systemd deadline

This spike asks whether Python can keep its normal subprocess API while systemd
owns lifetime enforcement for the entire descendant tree. **Yes, on the tested
host, provided the workload waits until scope registration finishes.**

Read the [measured report](../../docs/spikes/024-hostfork-scope.md). This is research
code, not a supported Hostfork package or the final architecture.

## Run

From `experiments/`, with a working systemd user manager and cgroup v2:

```bash
uv sync --frozen --all-packages
uv run --frozen python spikes/024-hostfork-scope/probe.py
# Optional: select a NEW directory for all retained evidence.
uv run --frozen python spikes/024-hostfork-scope/probe.py --output artifacts/my-scope-run
uv run --frozen pytest -q spikes/024-hostfork-scope/python/tests
```

The matrix takes about 22 seconds on the measured host. It creates only owned,
uniquely named user scopes. Workload fixtures self-expire within 20 seconds as a
secondary backstop. No sudo, Btrfs setup, paid model call, or host configuration
change is required. The namespace integration case also needs the unprivileged
namespace/OverlayFS capabilities documented in Spike 020.

## The proposed client experience, exercised by the spike

```python
import asyncio
from pathlib import Path
from hostfork_scope_spike import launch_scoped

owned = await launch_scoped(
    ["/bin/bash", "-c", "printf 'hello\\n'"],
    cwd=Path("/tmp"),
    artifact_root=Path("artifacts/example-environment"),  # must not already exist
    deadline_seconds=20 * 60,
    stdout=asyncio.subprocess.PIPE,
    stderr=asyncio.subprocess.PIPE,
)
try:
    process = owned.process  # an actual asyncio.subprocess.Process
    stdout, stderr = await process.communicate()
    print(process.returncode, stdout)
finally:
    evidence = await owned.close()  # whole scope, including surviving descendants
```

Python starts a small fresh interpreter that blocks on a pipe. The library asks
systemd to adopt that child into a transient **scope**, using its pidfd. It arms
`RuntimeMaxUSec`, verifies actual cgroup membership, then releases the pipe. The
gate `exec`s the target, preserving PID, parentage and standard streams. No
application import or fork occurs before adoption. EOF without release exits 125.

Afterward, ordinary subprocesses, shell commands, native grandchildren,
`ProcessPoolExecutor`, multiprocessing helpers and double-fork daemons inherit
ownership without calling the library. Python still waits on its direct child;
the scope remains alive while any member survives. `process.kill()` retains its
usual single-process meaning; `owned.close()` stops the scope. For longer-lived
environments, command completion and environment closure must be separate API
operations. Existing libraries can spawn freely **inside** the scoped process;
spawning directly in the unscoped controller is outside this ownership boundary.

## Ownership and evidence details

- `probe.py` runs real OS assertions and records membership, injected failures,
  partial logs and a final unit/process/cgroup audit. The negative control adopts
  a parent too late, verifies its existing child survives outside the scope, and
  then kills that exact recorded child. `workloads.py` supplies the mixed trees.
- `python/src/hostfork_scope_spike/` is the small research adapter. Its D-Bus
  connection passes `PIDFDs` and requests `AddRef` so completed unit metadata
  remains readable. It releases the reference after persisting final observations.
  Scope names and PID start times/boot IDs are recorded before release.
- There is no `Controller` callback or `AbandonScope` call. Disconnecting the
  client preserves the runtime deadline; `AbandonScope` disables that timer in
  systemd 255. The manager, rather than a Python sleep/task, enforces termination.
- Scope `Result` and leader returncode describe different events. Application
  exit 7 can coexist with scope success; leader exit 0 can precede a descendant
  timeout. Explicit stop of TERM-resistant tasks can also yield `Result=timeout`
  when the stop grace expires. Record the initiating decision, observed signal,
  available manager evidence, and unknown observations separately.
- Killing the process tree does not unlink filesystem resources. The harness
  records and unlinks only fixture-owned POSIX semaphore names left in host
  `/dev/shm`. The namespace test instead mounts private `/dev/shm`; those files
  remain under its artifact directory along with the overlay upper and logs.
  It recovers overlay scratch after namespace loss. Artifact retention/deletion
  remains a separate operation; this spike adds no general storage reaper.

The adapter exposes only the options needed by this experiment. It has not
qualified cancellation at every instruction, shared-broker dispatch, PTYs,
cross-user adoption, alternate systemd versions, manager restarts, or long-run
churn. Ordinary inherited pipes can remain open in descendants after their
leader exits; disk logs are used for the orphan-tree checks. Processes deliberately
launched through another service manager are not necessarily descendants in the
same cgroup. This is convenience isolation for trusted software.

Primary references: [systemd scope semantics](https://github.com/systemd/systemd/blob/v255/man/systemd.scope.xml),
[PIDFD registration](https://github.com/systemd/systemd/blob/v255/src/core/dbus-scope.c),
[scope lifecycle and abandonment](https://github.com/systemd/systemd/blob/v255/src/core/scope.c),
[unit references](https://github.com/systemd/systemd/blob/v255/src/core/dbus-unit.c),
[cgroup inheritance and migration](https://docs.kernel.org/admin-guide/cgroup-v2.html#organize-once-and-control),
[async D-Bus FD transport](https://python-dbus-next.readthedocs.io/en/latest/message-bus/aio-message-bus.html).

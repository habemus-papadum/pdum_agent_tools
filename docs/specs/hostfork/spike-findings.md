# Hostfork: what the first spikes tell us

**Measured research, 2026-10-13.** Five runnable spikes now exercise storage,
host compatibility, concurrency and failure handling. They support the host-first
design, but the prototype's helper arrangement should not become the final
architecture unchanged. This is research code under `experiments/`, separate from
the distributable packages.

The resulting [architecture](architecture.md) and [implementation plan](../../plans/hostfork.md)
are the proposed next step. This page records the experiments, not completion of
that design.

## Recommended direction

**Make prepared Btrfs storage a first-class option and retain OverlayFS.** On a
prepared host, a read-only baseline subvolume plus writable snapshots is a useful
default for private projects and application state. Preparation can happen while
building an AMI or volume. Runtime launch should consume that layout, rather than
format storage or copy the host each time.

Btrfs earns its place through filesystem semantics and independent retained
trees, rather than an assumption that it is always faster. The tested snapshots
preserved hardlink updates that the simple overlay configuration did not. Their
contents survive namespace teardown without reconstructing a merged overlay.
Overlays remain useful for inexpensive views over stable input. Reflink copies
remain useful for directories that do not align with snapshot boundaries.

**Keep four responsibilities separate:** preparing storage, creating an owned
private tree, composing its mount view, and managing process lifetime. Tree
deletion and actual space reclamation also need separate status. An application
or systemd can supply the lifetime controller; an eventual FastAPI adapter should
expose that same owner rather than implement another runtime.

## What actually worked

| Area | Observed result | What it means |
| --- | --- | --- |
| Host compatibility | Existing Python, Bash and git ran at their host paths; selected TCP, Unix-socket and FIFO services remained usable. | Inherit the host, then explicitly replace selected paths. |
| Prepared Btrfs | A writable snapshot mounted into the Python runtime accepted private writes without changing its baseline or the host target. | Host preparation and ordinary unprivileged launch can be separate. |
| Storage cost | Serial clone medians: Btrfs snapshot 8.9 ms, Btrfs overlay 1.4 ms, ext4 overlay 2.0 ms. | Snapshot fidelity has value even when an overlay creates faster. |
| First write | A 4 KiB overwrite copied a 64 MiB file into an ext4 overlay upper; the Btrfs upper shared extents and had 4 KiB exclusive storage. | The backing filesystem matters even when using overlays. |
| Scale | 200 simultaneous environments cleaned up; at 100, roughly 200 launches/s and 22 MiB PSS per environment. | This is feasible, but helper overhead deserves attention. |
| External control | Real memory OOM, CPU quota and timeout tests passed; an external timer stopped an environment with its supervisor frozen. | Lifetime/resource ownership should survive failure of the application and inner controller. |
| Python-owned launch | Python retained a real asyncio subprocess handle while a systemd scope killed library/native descendants, even after the caller died or froze. | Systemd can enforce lifetime without launching the workload; register a waiting child before releasing it. |

These are small, warm local measurements. Btrfs ran inside a disposable image
on ext4, not on EBS. Storage figures include command startup; concurrent lifetime
throughput differs from serial clone latency. The scale workload was idle, with
small private projects. The detailed reports preserve measurement boundaries.

## Footguns we can now demonstrate

**A pathname is not a live service.** Both overlays and Btrfs snapshots reproduced
socket/FIFO names whose original services could no longer be reached. Explicitly
binding the original service directory repaired the overlay case. Even when a
service is reachable, it resolves a supplied filename in its own filesystem view:
the worker saw a private file while the host service read the original. This
should be visible in planning and documentation, without prohibiting expert use.

**Cheap deletion is not proof that storage has been reclaimed.** Btrfs deletion
acknowledgement was fast; reclamation confirmation could wait for transaction
commit. Ordinary users could manage owned snapshots but could not perform every
reclamation-inspection operation. A host-prepared reaper can handle that separately.
Nested subvolumes also require explicit treatment; a parent snapshot did not
include their contents.

**A timer needs someone alive to enforce it.** Owner death, supervisor death,
init death, TERM-resistant descendants and external reaping were tested. A frozen
supervisor could not enforce its own deadline; systemd could. Separate the time
work must stop, termination grace, cleanup/export budget and artifact retention.
The current spike's deadline begins shutdown, so its grace follows that deadline.
A final hard-stop contract should state the latest permitted workload stop time.

**Keep reasons and evidence outside the dying workload.** Exit code, signal,
controller decision and OOM counters explain different things. In one timeout,
the inner runtime reported a received signal while the external controller
recorded the actual timeout. Init SIGKILL prevented final export, but logs and
partial private files survived. Missing exit observations remain unknown.

**Adopt before the workload can create children.** Spike 024's negative control
moved an already-running parent into a scope: its existing child stayed outside
and survived the deadline. A small launch gate fixes the ordering. Descendants
created afterward—including library process pools, shell grandchildren and
double-fork daemons—inherit ownership without extra registration. Python keeps
its ordinary direct-child API; command completion and environment termination
remain separate. The same scope also killed a tree inside private namespaces.

**An empty cgroup does not mean all resources are gone.** Killing a multiprocessing
resource tracker left named semaphores behind. A private `/dev/shm` confined them
to the retained artifact tree. Filesystem cleanup still needs a separate owner.
Likewise, scope `Result=timeout` can mean that an explicit stop exhausted its TERM
grace, and application exit 7 can coexist with scope success. Preserve the stop
decision, application exit status and manager result separately.

## What to change before settling the architecture

The Python prototype holds three helper processes per environment. A minimal
`unshare` control was about ten times faster and used far less memory, although
it lacked the prototype's management features. One hundred idle environments
also consumed about 0.26–0.29 CPU cores. Measure a smaller init, remove the waiting
interpreter, and compare shared supervision with per-environment supervision.
Preserve independent deadlines and forensic reporting while reducing this cost.

Keep process visibility separate from ownership. Spike 024 exercised cgroup
ownership with both host PIDs and a private PID namespace; broader host-PID
compatibility and scope churn still need qualification. A systemd scope with a
Python-owned gated launch is now a tested lifetime option, independent of the
storage choice. Next storage gates are a representative prepared
host tree, real-volume performance, sustained snapshot churn, full-disk behavior
and interrupted reclamation. Complete PTY handling, HTTP control and GPUs remain
later work.

The [research index](../../research.md) links to the workspace. Start with the
[runtime and shell instructions](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/spikes/020-hostfork-runtime/README.md),
then the detailed reports:
[020 runtime](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/020-hostfork-runtime.md),
[021 storage](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/021-hostfork-storage.md),
[022 compatibility and scale](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/022-hostfork-compatibility.md),
[023 lifetime and evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/023-hostfork-lifetime.md),
[024 Python-owned launch](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/024-hostfork-scope.md).

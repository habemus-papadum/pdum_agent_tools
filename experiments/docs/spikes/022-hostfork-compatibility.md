# Spike 022: host compatibility and concurrent environments

**Question.** Can a host-derived view keep installed software and shared services
usable while making project state private, and what does a few hundred such views
cost? This uses [Spike 020's runtime](020-hostfork-runtime.md), not another launcher.

**Observed result, 2026-10-13.** Selective private state works with ordinary host
tools, and 200 concurrent environments cleaned up successfully. The larger costs
come from this prototype's Python helpers. A significant compatibility trap is
already concrete: live sockets and FIFOs underneath an overlay can have the right
pathname yet no usable connection. Explicitly binding the original service
directory restores both.

## Compatibility findings

The real local probe ran Python, bash and git from their existing host paths;
read `/proc` and `/sys`; used `/dev/null` and `/dev/urandom`; wrote and deleted
private project files; and connected to actual host TCP, Unix-socket and FIFO
services. The original project and reference files remained unchanged after
shutdown. A selected read-only directory rejected writes with `EROFS`. An
explicit nested bind and an absolute symlink resolved to the intended files.

| Experiment | Observed behavior | Architectural consequence |
| --- | --- | --- |
| TCP/Unix/FIFO endpoints outside the private project | All usable from the worker. | Host networking and original filesystem endpoints can remain shared. |
| Unix socket and FIFO in the overlay's lower project directory | Socket connection refused; nonblocking FIFO writer got `ENXIO`, although the host peers were running. | Visible pathnames do not prove endpoint continuity. |
| Bind the original endpoint directory inside the private project | Socket and FIFO both worked. | Let callers restore selected live dependencies after applying private storage. |
| Ask the host service to read the worker's absolute project filename | Service read `host-original`; worker read `private-write`. | A shared service resolves filenames in its own view; put a service inside the environment when it must read private files. |
| Independently recreate a FIFO with the same node type | No reader; nonblocking open returned `ENXIO`. | Copying endpoint metadata does not recreate its service. |

[Spike 021](021-hostfork-storage.md) independently observed the same socket/FIFO
failure in a Btrfs snapshot. Preserving live endpoints is a separate decision
from choosing the storage backend.

The worker retained UID/GID 1000. Its `/proc` correctly showed namespace PID 2
and the environment's Python init as PID 1, while `/sys` still described the
host's 32 CPUs. This prototype always isolates PID visibility; that is a deliberate
experimental choice, not evidence that every installed host tool will behave
identically. Host services remained outside that process view.

## Measured scale and cost

Warm local runs on ext4, Linux `7.0.0-31-generic`, Python `3.14.6`, an Intel
i9-13900HX with 32 logical CPUs and approximately 31 GiB RAM. The project fixture
contained 100 small files. Every environment held one idle `/bin/sleep` command;
this is a control-plane benchmark, not an application or storage-write benchmark.
Rows below report the median of each metric across three measured batches.

| View | Concurrent | Environment ready p50 / p95, ms | Stop p50 / p95, ms | Launches/s including worker spawn | PSS MiB/environment |
| --- | ---: | ---: | ---: | ---: | ---: |
| Host mounts | 1 | 73 / 73 | 48 / 48 | 13 | 26.5 |
| One overlay | 1 | 72 / 72 | 51 / 51 | 13 | 26.5 |
| Host mounts | 10 | 88 / 107 | 53 / 60 | 87 | 22.4 |
| One overlay | 10 | 87 / 103 | 65 / 66 | 92 | 22.4 |
| Host mounts | 100 | 295 / 352 | 205 / 233 | 199 | 21.7 |
| One overlay | 100 | 299 / 349 | 192 / 220 | 203 | 21.7 |

At 100 environments, each held four processes: supervisor, waiting namespace
precursor, namespace init and workload. This totaled 400 processes and 2,600 open
descriptors. RSS was approximately 58 MiB per environment; it counts shared pages
repeatedly, so PSS is the more useful aggregate here. Measured CPU cost, including
controller measurement and waited children, was about 0.19–0.20 CPU-seconds per
environment for the full create/measure/stop cycle. A final run after runtime
cleanup fixes allocated about 24 KiB per host-only environment or 36 KiB with
the overlay for retained records, including each artifact directory itself.
Those are retained evidence files, not leaked mounts or process state.

A separate single stress batch per mode at **200 environments** also passed:
800 processes, approximately **4.23 GiB PSS**, and 189–202 launches/s. All 666
environments in the repeated table batches and all 400 in the stress batches
returned the caller to its original descriptor count, mount count and zero
descendants. No sampled PID/start-time identity survived cleanup. Retained
filesystem artifacts were intentionally not deleted.

A final source-fingerprinted run repeated compatibility and both modes at 100
environments after the runtime's cleanup fixes. It again recovered every process,
descriptor and caller mount, with 196–199 launches/s and 350–356 ms startup p95.
A two-second idle sample consumed approximately **0.26–0.29 CPU cores total for
100 environments**. This short sample includes tick quantization and is not a
long-duration idle-cost qualification; it does identify polling as another
worthwhile control-plane optimization.

For a lower-bound comparison, util-linux `unshare 2.39.3` running just one sleeping
command achieved about **1,896 launches/s** at concurrency 100, with about
**0.24 MiB PSS per view** and two processes per view. A plain subprocess achieved
about 2,268 launches/s. These controls lack reusable lifetime, logs, export,
deadline enforcement and recovery APIs, so they are not alternative complete
implementations. They show that most measured prototype cost is above the Linux
namespace primitive. The extra overlay mount was not a meaningful startup penalty
in this workload.

## Implications and remaining questions

Keep the host-first filesystem model and explicit service bindings. Do not
silently assume sockets inside copied/private trees still reach the original
service. Doctor/plan output can identify such endpoints without preventing the
operator from choosing the layout.

Before settling the supervisor architecture, measure a smaller per-environment
init, remove unnecessary waiting interpreters, and compare shared supervision
against one Python supervisor per environment. Preserve the independent deadline
and failure evidence properties while doing so. The current prototype is quite
usable for hundreds of idle views on this machine, but its approximately 22 MiB
baseline matters when scaling further.

These runs do not establish long-duration idle CPU cost, cold-cache performance,
large-write throughput, open-handle alias behavior, group-based service access,
or arbitrary-application compatibility. PSS is sampled after startup, not a peak
measurement. Only a small synthetic project was overlaid. Btrfs choice and host
preparation are investigated separately in [Spike 021](021-hostfork-storage.md).
This spike did not exercise Btrfs or impose cgroup resource limits.

## Reproduce and inspect

Run from `experiments/` after its normal uv setup:

```sh
uv run --frozen python spikes/022-hostfork-compatibility/probe.py compatibility
uv run --frozen python spikes/022-hostfork-compatibility/probe.py benchmark --rounds 3
uv run --frozen python spikes/022-hostfork-compatibility/probe.py benchmark --concurrency 200
uv run --frozen python spikes/022-hostfork-compatibility/probe.py all --concurrency 100 --idle-seconds 2
uv run --frozen python spikes/022-hostfork-compatibility/primitive_control.py
```

The [source README](../../spikes/022-hostfork-compatibility/README.md) describes
metric boundaries and commands. Ignored local evidence is under
`artifacts/022-hostfork-compatibility/`: compatibility run
`run-20261013-083329-1413977`, repeated batches `run-20261013-083329-1414003`,
stress batches `run-20261013-083517-1422532`, and control
`primitive-20261013-083521-1424740.json`. Final verification and the short idle
sample are in `run-20261013-084310-1451156`, which records Git HEAD and SHA-256
hashes of the runtime sources. Each environment retains its lifecycle record
and output files. These measurements used the contemporaneous uncommitted spike
code rather than a released package.

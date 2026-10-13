# Hostfork compatibility and concurrency

This experiment consumes the async runtime from Spike 020. It does not implement
another namespace launcher. Its host services and workload are real local
processes/endpoints; it makes no model calls and uses temporary synthetic data.

From `experiments/`:

```sh
uv run --frozen python spikes/022-hostfork-compatibility/probe.py compatibility
uv run --frozen python spikes/022-hostfork-compatibility/probe.py benchmark --rounds 3
uv run --frozen python spikes/022-hostfork-compatibility/probe.py benchmark --concurrency 200
uv run --frozen python spikes/022-hostfork-compatibility/probe.py benchmark --concurrency 100 --idle-seconds 2
uv run --frozen python spikes/022-hostfork-compatibility/primitive_control.py
```

The default benchmark compares inherited host mounts with one project OverlayFS
mount at concurrency 1, 10 and 100. Each environment keeps one `/bin/sleep` worker
alive while measurements are taken. Source projects contain 100 small files;
there are no large writes, networking load or model workloads in this benchmark.
Every environment has a 120-second deadline; ordinary completion closes it sooner.

The compatibility probe exercises:

- Real host TCP, Unix socket and FIFO services, plus endpoints within an overlay's lower tree
  and explicit bindings of the original endpoints inside the private project.
- A private project, a read-only directory, a nested bind and an absolute symlink.
- Python, bash, git, `/proc`, `/sys`, `/dev/null` and `/dev/urandom`.
- The same absolute project filename read by the worker and a host service.
- An independently recreated FIFO without a reader, using nonblocking open.
- Host source contents after private writes, creation and deletion, and shutdown.

Metrics include per-environment ready/worker-launch/stop latencies, batch
throughput, process RSS and PSS, file descriptors, namespace count, CPU time,
retained artifact storage, and process/descriptor/mount cleanup. PSS excludes
unreadable process entries and reports how many were available. PID plus start
time checks distinguish owned survivors from reused numeric PIDs. Startup means
the namespace init is ready; worker-launch completion means the runtime accepted
and spawned the command, not that an arbitrary application became healthy.

Raw output, logs and state are retained under
`artifacts/022-hostfork-compatibility/run-*/`. The caller's mount namespace should
not change. Artifact retention is intentional and separate from process cleanup.
See [the report](../../docs/spikes/022-hostfork-compatibility.md) for observations
and architectural implications.

`primitive_control.py` is a separate lower-bound control: a plain subprocess,
then util-linux `unshare` running one command, with its built-in kill-child option.
It provides neither reusable environment lifetime nor an API, export, recovery,
or a deadline supervisor. Its measurements help separate namespace costs from
the Python control-plane costs of the richer prototype. They are not equivalent
implementations. The control reports waited-child CPU counters; killed orphaned
children need not contribute to those counters.

# Spike 023: deadlines, failures, resource limits and forensic evidence

**Question.** Can an environment outlive its caller while retaining a bounded
lifetime, can another owner kill it reliably, and can we distinguish why it died?

**Observed, 2026-10-13.** Seven namespace failure scenarios and five external
cgroup scenarios passed. The experiments support a separate lifetime controller,
explicit termination reasons and storage that survives process death. They also
show why a runtime's own watchdog is insufficient if that watchdog stops running.

## Process failure results

The workload writes continuously, ignores TERM and creates a `setsid()` child.
The test captures host identities of members of its private PID namespace and
checks they no longer exist after termination. Source files remain unchanged.

| Trigger | Recorded outcome | Evidence remaining |
| --- | --- | --- |
| Ordinary commands | Exit 0, exit 7, signal 10 kept distinct. | Per-command stdout/stderr and exit records. |
| Environment deadline | `deadline`, followed by TERM/KILL escalation. | Both partial files exported; logs and private write layer retained. |
| External stop | Caller-supplied `external_reaper` reason. | Partial exports and process results. |
| Owner SIGKILL, default policy | `owner_lost`; all descendants stopped. | Partial exports and logs. |
| Owner SIGKILL, retained policy | Environment remained usable, then `deadline`. | Partial exports and logs. |
| Supervisor SIGKILL | Init noticed control-channel loss; `supervisor_lost`. | Init's own final record and partial exports, despite stale supervisor journal. |
| Init SIGKILL | `init_lost`; kernel removed the namespace's processes. | Logs and upper-layer partial files; no final export or invented command exit status. |

The measured 0.8-second deadline case completed in 1.18 seconds including
setup, TERM grace, export and verification. Retained mode's 1.2-second deadline
completed in 1.66 seconds including owner setup and verification. These timings
demonstrate a bounded teardown sequence, not exact kill-at-deadline semantics.

## Independent cgroup controller

Transient user systemd services owned the test process trees, using separate,
uniquely named slices so hierarchical OOM counters survived long enough to copy.
Services and slices were removed after evidence collection; their cgroups were
verified absent. This host's ordinary session cgroup was not writable, but its
user systemd manager could enforce the requested limits without sudo.

| Experiment | Measured result |
| --- | --- |
| CPU busy loop, 1.6 seconds | About 1.60 CPU-seconds without quota; **0.40 CPU-seconds at 25%**. Service accounting, which includes interpreter overhead, was 1.65 versus 0.49 CPU-seconds. |
| 96 MiB memory limit, swap disabled | Actual OOM; `Result=oom-kill`, signal 9 and `memory.events: oom_kill=1`. Allocation logs survived. |
| 1.5-second outer deadline, 0.3-second stop grace | `Result=timeout`, signal 9, no TERM-resistant parent or detached child survived. Full probe took 1.92 seconds. Both partial files remained. |
| Hostfork supervisor deliberately frozen | Its 1.2-second internal timer could not run. A 1.8-second external timer stopped the environment; full probes took 1.87–2.14 seconds. No runtime helpers survived. |

In the frozen-supervisor test, systemd's stop resumed the process and the inner
record said `supervisor_signal_15`, while systemd recorded `timeout`. One run
completed its final export during the outer grace; a later run retained partial
upper files without a final export. **Keep both records**: a
signal number does not explain the controller's decision, and a final export is
not guaranteed under forced termination. Cgroup counters provide OOM evidence
that an exit code cannot supply. See the [kernel's cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html)
for the underlying accounting and lifecycle primitives.

## Architectural implications

Define execution expiry, termination grace, export/cleanup budget and artifact
retention separately. A hard workload stop must not wait indefinitely for export.
Keep an independently operated cgroup owner or reaper available; it can be
systemd or an embedding application's controller, without an obligatory new daemon.
Place lifecycle evidence outside private mounts and retain storage after the
process tree disappears. Merge external reasons with inner exit observations
without overwriting either or labeling every SIGKILL as OOM.

These are local crash/timeout tests, not machine power-loss durability, persistent
database consistency, kernel-hang handling, disk-full qualification or a
20-minute soak. Process cleanup and retained artifact deletion are separate.
The inner runtime has no integrated cgroup resource API yet. An external owner
outside a workload's memory limit is desirable for production forensic reliability;
these service tests do not establish that final cgroup layout.

## Reproduce and evidence

From `experiments/`:

```sh
uv run --frozen python spikes/023-hostfork-lifetime/failures.py
uv run --frozen python spikes/023-hostfork-lifetime/cgroups.py
```

See the [source README](../../spikes/023-hostfork-lifetime/README.md) for prerequisites
and a 20-minute shell recipe. Local evidence: `artifacts/hostfork-lifetime/`, runs
`failures-8a1f20ca29` and `cgroups-5ef2f30abf`, including per-case logs and structured
results. Final reruns after cleanup fixes also passed: `failures-a5b9966efc` and
`cgroups-f396769dc8`. Environment: Linux 7.0.0-31-generic, Python 3.14.6, systemd 255.4 on ext4,
UID 1000. No paid API calls or persistent system configuration changes.

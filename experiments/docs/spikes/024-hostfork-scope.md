# Spike 024: Python owns launch; systemd owns the deadline

**Question.** Can Python retain its normal subprocess API while an independent
controller cleans up descendants created by arbitrary libraries and native code?

**Result, 2026-10-13: yes, with registration before workload execution.** Twelve
real OS scenarios passed. Python launched a waiting child, registered it in a
systemd scope, then let it `exec` the workload. The returned object was an actual
`asyncio.subprocess.Process`: PID, parentage, stdin/stdout/stderr, cwd, environment
and application exit status were preserved. Systemd did not launch the workload.

| Experiment | Observed result |
| --- | --- |
| Mixed process tree | Shell/native grandchildren, a spawn process pool, forkserver, resource tracker and detached double-fork daemon inherited the scope. A snapshot contained 9–10 processes. |
| Runtime deadline and external stop | Every observed scope member died, including TERM-resistant tasks. |
| Leader exits first | Python observed exit 0; surviving descendants remained owned and subsequently died at the deadline. |
| Python launcher killed or frozen | The systemd deadline still stopped all workload members. |
| Launcher dies before registration/release | The waiting gate aborted on EOF; no workload ran. |
| Registration rejected | An invalid real systemd property failed startup; gate exited 125; no workload ran. |
| Adoption after descendants already exist | **Expected failure:** the earlier child stayed outside the scope and survived its parent's deadline. The harness rescued it by verified identity. |
| Nested user/mount/PID namespaces | All 14 observed members died under the outer deadline. The source remained unchanged and a private overlay write survived for inspection. |

An additional regression test injected a post-spawn journal failure. Review had
found that it could leak the waiting gate; the fixed adapter closed the gate and
reaped exit 125. The matrix and this fault-injection test both passed.

**The architecture implication is small but important:** keep application-owned
launch, put a gate before application execution, and give the scope independent
lifetime ownership. Descendants need no special Python API or registration.
Track command exit and environment termination separately. This supports the
direction suggested after Spike 023 without requiring a systemd service to spawn
the command. It does not decide the storage backend.

Two additional footguns were measured. First, `Result=timeout` also appeared for
an explicit stop whose TERM grace expired, while application exit 7 left the
scope result successful. Save the initiating decision as well as raw exit and
scope status. Hold a unit reference until evidence is collected; successful
transient scopes otherwise disappear quickly. Second, hard-killing the Python
resource tracker left five named semaphore files. The harness unlinked its exact
owned names; a private `/dev/shm` in the namespace case confined the retained
files to the artifact tree. Process cleanup and storage cleanup remain separate.

**Measurements and limits.** Linux 7.0.0-31-generic, systemd 255.4-1ubuntu8.17,
Python 3.14.6, dbus-next 0.2.3, cgroup v2, ordinary UID 1000; no sudo used.
Ten successful registrations took 13.5–30.4 ms, median 24.8 ms, including D-Bus
connection and a `systemctl` verification subprocess, excluding gate startup.
These are small functional samples, not a throughput benchmark. Three-second
runtime tests took roughly 3.45–3.56 seconds end-to-end with a configured 200 ms
stop grace. This is independent enforcement, not an exact real-time hard-stop
guarantee. The nested-namespace case took 4.23 seconds for a four-second deadline.

Final audit: **12 units checked; no live owned processes, remaining units or
cgroup directories.** Logs and private files were intentionally retained.
No new Btrfs measurement or twenty-minute soak was performed. See the
[runnable code, API example and remaining gates](../../spikes/024-hostfork-scope/README.md).

Reproduce from `experiments/`:

```bash
uv sync --frozen --all-packages
uv run --frozen python spikes/024-hostfork-scope/probe.py
uv run --frozen pytest -q spikes/024-hostfork-scope/python/tests
```

Local ignored evidence: `artifacts/024-hostfork-scope/pytest-matrix-2/test_scope_matrix0/evidence/`
contains `results.json`, `audit.json`, per-case records and partial logs.
`artifacts/024-hostfork-scope/pytest-journal-failure/` holds the additional test.
The earlier `run-1791900149805595950` preserves the initial incorrect expectation
that manual-stop escalation would report scope success; cleanup still passed.
Results record source hashes and base Git revision
`0e07158d410468b7ad3164b8d551593d837c09f5`; the spike itself was uncommitted.

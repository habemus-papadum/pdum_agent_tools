# Bounded lifetime, failure evidence and external resource ownership

Run from `experiments/` after `uv sync --frozen --all-packages`:

```sh
uv run --frozen python spikes/023-hostfork-lifetime/failures.py
uv run --frozen python spikes/023-hostfork-lifetime/cgroups.py
```

`failures.py` tests real command outcomes, deadlines, external stop, caller SIGKILL
with both retention policies, supervisor SIGKILL and namespace-init SIGKILL.
Workers fork a new session and ignore TERM. It checks namespace membership,
process identities, original source contents, partial files, final exports and
logs. Evidence is retained under `artifacts/hostfork-lifetime/failures-*`.

`cgroups.py` needs a running user systemd manager with memory/CPU controllers.
It creates uniquely named transient services and slices, and checks real CPU
throttling, a 96 MiB memory OOM, external timeout, and timeout with the Hostfork
supervisor deliberately SIGSTOPed. It copies service results and hierarchical
memory events before removing each owned unit/slice. No root access or edits to
the launching session cgroup are needed. Logs and results remain under
`artifacts/hostfork-lifetime/cgroups-*`.

The systemd controller is outside the failing workload. With `KillMode=control-group`,
it owns the environment's helpers and descendants as well as the initiating
application. This is an experiment in a possible backend, not a resource-limit
option already integrated into `EnvironmentSpec`.

For an operator-controlled 20-minute shell experiment, the same building blocks
can be composed explicitly (the following is a usage recipe, not a measured
20-minute soak test):

```sh
systemd-run --user --pty --wait --unit=hostfork-manual-demo \
  --property=RuntimeMaxSec=20m --property=TimeoutStopSec=2s \
  --property=KillMode=control-group --property=MemoryMax=2G \
  --property=MemorySwapMax=0 --property=CPUQuota=200% \
  "$PWD/.venv/bin/hostfork-spike" run --deadline 1195 -- bash --noprofile --norc -i
```

Use a unique unit name for concurrent invocations. Add the desired filesystem
options to `hostfork-spike run`; the example inherits writable host paths.
`CPUQuota=200%` means two CPUs of time. The inner deadline gives orderly shutdown
a head start. The outer timer begins termination at 20 minutes and can add its
two-second stop grace. For a hard stop budget of 20 minutes, begin termination
earlier by that grace; scheduling and uninterruptible kernel I/O remain outside
a userspace timing guarantee. A user manager's survival across logout also depends
on the host's login/session policy; AMI preparation should decide that explicitly.

An external operator can stop the unit with `systemctl --user stop UNIT`. Inspect
`systemctl --user show UNIT -p Result -p ExecMainCode -p ExecMainStatus` and the
environment's artifacts before resetting/removing a failed unit. A numeric
SIGKILL exit alone does not identify OOM or timeout. The executable probe records
both controller and inner-runtime evidence because their explanations differ.

See [the result](../../docs/spikes/023-hostfork-lifetime.md) for observations and
limitations. The scripts keep test logs unbuffered where partial output matters;
application data never flushed from userspace cannot be recovered by the runtime.

# Hostfork runtime spike

A library-first experiment in deriving a Linux environment from the current host.
It preserves host paths, networking and IPC, then applies requested mount changes.
This version always creates a private user/mount/PID namespace and matching `/proc`.
It is a trusted-operator tool, not a security boundary or the final package API.

Run all commands from `experiments/`:

```sh
uv sync --frozen --all-packages
uv run --frozen hostfork-spike doctor
mkdir -p artifacts/hostfork-demo/project
uv run --frozen hostfork-spike run \
  --overlay "$PWD/artifacts/hostfork-demo/project" \
  --cwd "$PWD/artifacts/hostfork-demo/project" --deadline 1200 \
  --export "$PWD/artifacts/hostfork-demo/project=project" \
  -- bash --noprofile --norc -i
```

Omit the command to enter `/bin/bash -i` using the existing terminal. Actual Bash
input and background jobs were tested through a PTY. Allocating a new PTY,
reconnecting a terminal, and complete terminal signal behavior remain future work.
`--plan` prints the chosen configuration without creating the environment.

Filesystem options are repeatable:

| Option | Effect |
| --- | --- |
| `--overlay PATH` | Private writes over the live host directory. |
| `--read-only PATH` | Read-only bind of this mount; nested mounts are not recursively protected. |
| `--fresh PATH` | An empty private directory, backed by retained artifacts. |
| `--bind SOURCE=TARGET` | Place an existing tree, including a prepared writable Btrfs snapshot, at a host path. |
| `--export SOURCE=RELATIVE_DEST` | Copy a final path to `ENVIRONMENT/exports/RELATIVE_DEST` during orderly shutdown. |

Targets must exist. Changes are applied in the runtime spec's list order; the CLI
groups them as overlay, read-only, fresh, then bind. Thus a bind can restore a live
service directory inside an overlay. Paths without substitutions remain shared
and writable according to the host's permissions. See [Spike 022](../../docs/spikes/022-hostfork-compatibility.md)
for the measured socket/FIFO and filename-resolution traps.

The CLI prints its unique environment directory. Commands normally inherit the
terminal; `--logs` captures stdout/stderr in per-command files. `--detach` returns
immediately after spawn and records output; `--retain` waits for that command and
keeps the environment. Both require `--deadline` in this spike. A later command's
launch never extends the environment deadline.

```sh
uv run --frozen hostfork-spike status /absolute/path/to/env-ID
uv run --frozen hostfork-spike stop /absolute/path/to/env-ID --reason manual_reap
uv run --frozen hostfork-spike reap artifacts/hostfork-runtime --older-than 1200
```

`reap` is an explicit external operation based on recorded environment age. It
uses the control channel or verified process identities, retains evidence, and
does not register a scheduler. An operator can invoke it periodically.

## Python API

```python
from pathlib import Path
from hostfork_spike import Environment, EnvironmentSpec, Export, Mount

project = Path("artifacts/hostfork-demo/project").resolve()
spec = EnvironmentSpec(
    mounts=[Mount("overlay", str(project))],
    deadline_seconds=1200,
    exports=[Export(str(project), "project")],
)

async def experiment():
    async with await Environment.create(spec, artifact_root="artifacts/hostfork-runtime") as environment:
        sidecar = await environment.spawn(["/bin/sleep", "600"])
        result = await environment.run(["/bin/bash", "-c", "echo hello > result.txt"], cwd=str(project))
        print(result["returncode"], environment.path)
        # Further commands see the same private files; leaving the context stops
        # every workload, including the sidecar, and attempts configured exports.
```

Output goes directly to ordinary files, so a slow observer cannot fill a pipe and
deadlock a worker. Consumers can read those files while commands run. Disk space
and filesystem stalls still matter. This is not yet a streaming-output API.
`Environment.create(..., inherit_stdio=True)` enables explicit
`spawn(..., stdio="inherit")`; otherwise the helper releases the caller's stdio.

## Lifetime and evidence

An exec-launched supervisor stays outside the workload namespaces. An init inside
the PID namespace owns/reaps commands. An owner pipe selects cleanup on caller
loss; `retain_on_owner_exit=True` allows survival until deadline or external stop.
The supervisor records the initiating reason before requesting termination.
Init also reacts to supervisor-channel loss, and external recovery checks boot ID,
PID start time and a pidfd before signalling.

The deadline **starts shutdown**, including setup time. Default TERM grace is
0.25 seconds; the supervisor forces init termination after a separate 5-second
cleanup budget. It is not an exact wall-clock kill instant. An external cgroup
owner can provide a deadline independent of a frozen supervisor; see
[Spike 023](../../docs/spikes/023-hostfork-lifetime.md). Neither method defeats
uninterruptible kernel I/O or a stalled host.

`config.json`, `state.json`, per-process logs, `init-final.json` when possible,
private storage and final exports remain after teardown. Exit codes, signals,
termination reasons and missing observations are separate fields. Killing init
can prevent final export; the upper layer still contains partial changes but is
not itself a complete merged tree. Keep the matching lower tree for recovery.
Artifact retention is intentional and separate from stopping processes/mounts.

The spike does not implement a host-PID mode, resource-limit API, recursive
read-only trees, filesystem-root replacement, FastAPI controller, GPU scheduling,
or durable recovery after machine failure. Btrfs preparation and lifetime are
separate experiments, rather than implicit privileged setup in this library.

```sh
uv run --frozen pytest spikes/020-hostfork-runtime/python/tests -q
```

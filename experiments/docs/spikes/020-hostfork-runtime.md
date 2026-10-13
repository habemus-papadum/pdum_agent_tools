# Spike 020: library and shell runtime

**Question.** Can a small generic Python API maintain a host-derived filesystem
view across several commands, expose a useful shell, and own cleanup independently
of the original caller?

**Observed, 2026-10-13.** Yes, on this Linux host. The implemented research package
`hostfork-spike` provides an async `Environment`, declarative mount substitutions,
multiple commands, disk-backed stdout/stderr, selected-path export, a separate
supervisor deadline, and external status/stop/reap. The Typer CLI supports doctor,
planning and entering Bash. This is experimental code, not an implementation of
the proposed production package or a frozen API.

## What was established

Real tests created private overlays and empty directories, read-only mounts and
shared binds. Later commands saw earlier private writes; source trees stayed
unchanged. Normal exit, application exit 7 and signal termination remained
distinguishable. Commands could leave `setsid()` descendants behind; environment
shutdown still killed/reaped them. Invalid command startup did not destroy a
usable environment. Loss of the caller selected immediate cleanup or continued
lifetime according to the configured policy.

The final suite passed **17 tests**: 14 library integration tests and three CLI
subprocess checks. It also covers cancellation, frozen-init escalation, precursor
death, safe relative working directories, and removal of OverlayFS scratch
directories after mounts disappear. Forensic upper layers remain intentionally.

A real Bash session inherited a PTY, accepted input, ran a background job and
waited for it. CLI subprocess tests cover exit-code propagation, timeout exit 124,
and detached launch releasing the caller's captured output pipes. The default
library output path uses files rather than caller-owned pipes.

The implementation uses fresh exec helpers rather than forking application Python
state. It preserves host networking, IPC and mount paths; creates user/mount/PID
namespaces; maps the caller's UID/GID to the same numbers; and mounts matching
`/proc`. Private PID visibility is a tested backend choice, **not a decision that
the eventual host-compatible mode must hide host processes**.

## Lifetime contract and limitations

An environment can survive its first command or its owner, but retained mode
requires a finite deadline in this spike. The timer starts during setup, and new
commands do not reset it. Deadline expiry initiates TERM, followed by the configured
grace and bounded cleanup escalation. It is not an instantaneous kill guarantee.
State records the initiating reason before teardown, and missing command exit
observations remain explicitly unknown.

Private storage and logs remain available after processes/mounts disappear.
Orderly termination attempts exports; init SIGKILL can prevent that step. The
separate [failure and cgroup spike](023-hostfork-lifetime.md) tests external timers,
OOM attribution and partial evidence. The [compatibility/scale spike](022-hostfork-compatibility.md)
measures the helper footprint and service path semantics.

Important limits: paths outside declared substitutions remain shared; read-only
mounts do not recursively protect submounts; OverlayFS lower input stays live;
exports are ordinary filesystem copies, not a consistency protocol for external
services. A supervisor cannot enforce its own timer while frozen. The prototype
does not yet offer resource limits, host-PID mode, PTY allocation/reattachment,
an HTTP adapter or GPU controls.

## Reproduce

From `experiments/`, using its Python 3.14.6 uv workspace:

```sh
uv sync --frozen --all-packages
uv run --frozen hostfork-spike doctor
uv run --frozen hostfork-spike run --deadline 1200 -- bash --noprofile --norc -i
uv run --frozen pytest spikes/020-hostfork-runtime/python/tests -q
```

See the [source README](../../spikes/020-hostfork-runtime/README.md) for private
workspace, Btrfs bind, library and external-reap examples. Local evidence is under
`artifacts/hostfork-runtime/` and the neighboring spike artifact directories.
Test data is synthetic; no model calls, system configuration changes or production
package changes were required. Host: Linux 7.0.0-31-generic, ext4, UID 1000,
unprivileged user namespaces enabled and AppArmor's user-namespace restriction off.

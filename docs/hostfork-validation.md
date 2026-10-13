# Hostfork validation

Production implementation qualification, 2026-10-13. These results apply to
`packages/hostfork`; the earlier [spike results](specs/hostfork/spike-findings.md)
remain separate research evidence.

## Local evidence

The final Python 3.14 workspace run passed **261 tests**, with two Btrfs tests
skipped because that ordinary run had no prepared pool. Both Btrfs tests passed
separately on the disposable prepared volume. Hostfork measured **85.8% line
coverage** in the workspace run; its public lifecycle module measured 92%, Linux
runtime 90%, and namespace helper 92%. The coverage report includes uncovered
error paths and storage helpers that run under isolated interpreters; it does not
pretend those executions were measured. The prepared-volume runs were separate
functional checks and were not combined into this coverage measurement.

The package suite also passed on Python 3.12 and 3.13 (116 tests each; prepared
Btrfs checks ran separately). Ruff lint/format checks, lockfile
consistency, strict MkDocs, all three distribution builds, and an actual runtime
launched from the extracted Hostfork wheel passed. No release was dispatched.

The development host provides Linux 7.0.0-31-generic, systemd 255.4 and cgroup v2,
with an operational user manager and namespace policy. The package suite exercises
actual namespace entry, mount presentation, PIDFD scope registration, native child
handles, library/native descendants, multiple commands, actual aggregate CPU throttling, stop races, cancellation,
fixed deadlines under SIGSTOP, owner SIGKILL, keeper loss, real OOM and storage
recovery. Public API tests also cover managed export retention, failures during
log creation, concurrent recovery during activation and stop during activation.

A disposable loop-mounted Btrfs image was prepared independently, and allocation,
copy-on-write preservation, export, subvolume identity and release were tested as
the ordinary experiment user and as root. The helper creates a new regular-file
image, formats that image, mounts it with `user_subvol_rm_allowed`, tests it, then
unmounts and releases the loop device. This is functional evidence, not EBS/AMI
performance evidence. It does not format an existing device.

Actual user-systemd support installation, timer activation, reaper execution and
uninstallation passed with registry-specific units. A path containing spaces,
percent signs, dollar signs and quotes exercised real ExecStart escaping. All
units created for that check were removed.

Reproduce local checks from the root workspace:

```sh
uv run python scripts/check_hostfork_capabilities.py --probe --require-linux \
  --output artifacts/hostfork-capabilities.json
PDUM_HOSTFORK_REQUIRE_LINUX=1 uv run pytest packages/hostfork/tests
uv run pytest -m 'not live'
uv run python scripts/benchmark_hostfork.py --counts 1,10,100,200
uv run python scripts/benchmark_hostfork.py --counts 10 --rounds 10 \
  --output artifacts/hostfork-churn.json
```

Set `PDUM_HOSTFORK_TEST_BTRFS_ROOT` to an explicitly prepared disposable directory
on a writable Btrfs filesystem and `PDUM_HOSTFORK_REQUIRE_BTRFS=1` to require Btrfs
qualification. `packages/hostfork/tests/storage_fixtures/btrfs_runner.py` is a
self-cleaning local fixture when privileged loop mounting is available. No paid
provider calls are involved.

## Throughput and resource cost

A first production benchmark launched one `/bin/true` command per environment,
waited for descendants, stopped each environment and applied retention. It used
inherited host views with no copied payload, one caller, local storage and a
120-second deadline. Other tests were running on the host during this first
measurement, so these are development measurements, not isolated performance
claims.

| Concurrent environments | Create p50 / p95 | Command p50 / p95 | Batch stop | Complete lifecycle throughput |
| --- | --- | --- | --- | --- |
| 1 | 0.125 / 0.125 s | 0.101 / 0.101 s | 0.035 s | 3.66 environments/s |
| 10 | 0.389 / 0.615 s | 0.435 / 0.544 s | 0.341 s | 5.75 environments/s |
| 100 | 3.910 / 6.217 s | 4.040 / 4.400 s | 2.799 s | 5.90 environments/s |
| 200 | 8.357 / 9.945 s | 8.301 / 8.499 s | 5.776 s | 5.93 environments/s |

Keeper RSS summed to about 3.90 GB at 200 environments (about 19.5 MB each).
RSS double-counts shared pages; this is not unique physical consumption. The
measurement includes durable registry writes, Python helpers, systemd handoff and
cleanup. It does not measure large tree-copy cost or cloud storage performance.

Ten batches of ten environments completed in the churn check. After deterministic
connection cleanup was added, a final three-batch check returned to **nine caller
file descriptors after every batch**, with 4.52–5.08 complete lifecycles/second
while the coverage suite was also running. The final unit audit found no remaining
Hostfork scopes, and the disposable Btrfs mount audit was empty.

Scale testing found and corrected two issues: systemd start-job acknowledgment
preceding activation, and SQLite connections left open until garbage collection.
The D-Bus adapter now deterministically closes its stream/socket instead of
waiting for garbage collection. A GC-disabled descriptor test verifies that.
Python 3.12 testing caught asyncio transport finalization killing a detached
keeper; only the internal keeper now uses Popen plus asynchronous polling. Public
commands retain their real asyncio handles. Concurrent recovery testing also caught a reaper treating an as-yet-unpublished
keeper identity during live creation as keeper death. Regression tests now cover
these transitions. Benchmark scripts retain journals if cleanup remains pending.

## CI coverage

Ordinary CI covers Python 3.12–3.14 on Linux and Python 3.14 on macOS. Hostfork's
inert imports, models, registry and portable CLI/planning cases can run there;
Linux storage/runtime cases explicitly skip on unsupported hosts. A skip is not
proof of runtime support.

The new `Hostfork prepared Linux` workflow pins Ubuntu 24.04, prepares a user
manager and a disposable Btrfs image, and requires actual capability probes before
running tests on Python 3.12 and 3.14. Its sysctl/lingering adjustments are explicit
**disposable-runner preparation**, with restoration in cleanup; they are not
library defaults. On 2026-10-13, the first
[prepared GitHub run](https://github.com/habemus-papadum/pdum_agent_tools/actions/runs/38430170771)
passed **118 tests with no skips on each Python version**, including real Btrfs
allocation/export/recovery, descendant cleanup, deadlines, OOM and CPU limits.
The observed hosted kernel was `6.17.0-1022-azure`, with systemd
`255.4-1ubuntu8.17`. Capability reports and JUnit results are attached to that run.

The corresponding [ordinary CI run](https://github.com/habemus-papadum/pdum_agent_tools/actions/runs/38430170973)
passed all four matrix jobs: **205 passed / 58 skipped** on each Linux Python
version and **175 passed / 61 skipped** on macOS. These ordinary runners do not
receive Hostfork preparation; unsupported runtime/storage checks and absent Codex
binary checks skip explicitly. The prepared workflow supplies the Linux runtime
qualification. macOS coverage establishes portable API/import behavior only;
there is no native macOS execution backend yet.

The prepared workflow also builds Hostfork and launches an actual environment
from the extracted wheel, verifying packaged helper files and cleanup. Every
push to `main` runs both CI workflows, and the human-operated release workflow
requires both to succeed for its selected commit. The disposable image validates
Btrfs functionality; it is not a cloud-volume performance benchmark.

The image selection follows the official [Ubuntu 24.04 runner manifest](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).
Runner images change, and GitHub documents their [fresh-VM lifecycle](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners).
Ubuntu documents the relevant [24.04 user-namespace restrictions](https://github.com/ubuntu/ubuntu-release-notes/blob/main/docs/24.04/index.md).
These sources explain why the workflow probes capabilities instead of relying
only on an OS label.

## Remaining qualification boundaries

Native macOS execution, private PID mode, allocated PTYs, FastAPI management and
GPU allocation are future work. They are not silently emulated by the Linux API.
Actual reboot/power-loss tests, user-manager restart across package upgrades,
full-device/Btrfs-metadata exhaustion and EBS/AMI performance require dedicated
hosts and remain unqualified. Injected persistence failures and recovery tests
cover narrower transitions; they do not replace those system-wide tests.

Uninterruptible kernel operations, operator changes to borrowed inputs, unexpected
nested subvolumes and failed ownership persistence can require manual inspection.
Cleanup reports pending work rather than deleting an unverified path. The tests
validate observed failure modes, not an unconditional cleanup guarantee.

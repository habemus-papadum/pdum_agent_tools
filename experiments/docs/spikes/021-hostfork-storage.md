# Spike 021: prepared Btrfs storage versus overlays and copies

## Question and result

**Should Hostfork exploit a filesystem prepared ahead of time? Yes.** A real
Btrfs snapshot worked as an independently writable tree mounted by spike 020's
Python runtime, with ordinary process execution and clean teardown. Preparation
can belong to an AMI/volume workflow. It does not belong in each environment
launch. **Keep both Btrfs snapshots and overlays as candidates:** snapshots gave
more faithful filesystem behavior, but overlays were faster in this small test.

This is local evidence, not a production implementation or an EBS benchmark.
The [runnable harness and preparation notes](../../spikes/021-hostfork-storage/README.md)
explain the commands and scope.

## Measured on 2026-10-13

Linux 7.0.0-31-generic, Python 3.14.6, coreutils 9.4, Btrfs tools 6.6.3. The host
is ext4 on NVMe; Btrfs used a disposable 2 GiB sparse image on that filesystem,
mounted in a private namespace with `user_subvol_rm_allowed`, without compression
or quotas. Binaries were extracted locally; no package installation, existing
device formatting, global mounts, or sysctl changes were required.

The baseline held 67.9 MiB of real random data: a 64 MiB file and 1,000 small
files, plus a hardlink, symlink and FIFO. Each method ran 12 lifecycles at each
concurrency. One lifecycle clones, overwrites 4 KiB of the large file and calls
`fsync`, changes several directory entries, then deletes the clone.

| Filesystem / method | Clone median, 1 worker | First write + fsync | Delete median | Lifecycles/s, 1 worker | Lifecycles/s, 4 workers |
| --- | ---: | ---: | ---: | ---: | ---: |
| ext4 ordinary copy | 41.32 ms | 11.98 ms | 8.16 ms | 15.9 | 39.2 |
| ext4 overlay | 2.04 ms | 27.28 ms | 8.80 ms | 24.4 | 51.1 |
| Btrfs ordinary copy | 57.23 ms | 30.60 ms | 14.32 ms | 9.2 | 11.4 |
| Btrfs reflink tree copy | 29.83 ms | 4.02 ms | 12.74 ms | 21.3 | 53.6 |
| Btrfs overlay | 1.40 ms | 3.26 ms | 5.97 ms | 88.2 | 235.5 |
| Btrfs subvolume snapshot | 8.86 ms | 4.13 ms | 3.39 ms | 59.2 | 131.1 |

These include utility startup and warm caches. Copy completion is buffered;
cloning is not a crash-durable checkpoint. The machine was shared with other
research work. The two main reported runs were issued sequentially. Small
samples and the loopback stack limit comparisons, especially with real volumes.
The ext4 reflink operation failed as unsupported; it did not fall back to copying.

One-time image formatting took 38.9 ms and mounting 10.2 ms. Generating and
`fsync`ing the fixture took 4.16 s on Btrfs and 1.98 s on ext4; this is synthetic
ingestion cost, **not** a measured copy of the host. Image unmount took 37.6 ms.
The JSON separates caller CPU from child utility CPU: for the 12 serial Btrfs
snapshot cycles these were 0.031 s and 0.083 s; overlay used 0.014 s and 0.038 s.
Kernel background CPU is not fully attributed. No cloud/API dollars were spent
or estimated.

## Findings that affect the design

- **Btrfs also improves an overlay's first write.** On ext4, a 4 KiB overwrite
  caused the overlay upper to allocate the whole 64 MiB file. On Btrfs, the upper
  shared the original extents: `btrfs filesystem du` reported only 4 KiB exclusive
  at the measurement point. Snapshot and reflink copies likewise reported 4 KiB
  exclusive. Summing `st_blocks` would have misleadingly counted shared bytes as
  if each clone consumed them independently.
- **Hardlinks exposed a concrete overlay incompatibility.** In the simple tested
  mount configuration, two names initially referred to the same lower inode, but
  writing one left the other name showing old content. This occurred on ext4 and
  Btrfs. Snapshot and reflink copies preserved the alias update. This does not
  qualify every OverlayFS option; it identifies a required compatibility test.
- **A snapshot does not reproduce live services.** Its socket pathname existed,
  but connection failed with `ECONNREFUSED`; its FIFO writer failed with `ENXIO`.
  The original listener and reader remained usable. Original service directories
  need explicit shared bindings when those live peers should remain reachable.
- **Nested subvolumes are a boundary.** The parent snapshot contained the nested
  directory but none of its contents. Baseline preparation needs an explicit
  layout. This matched the [Btrfs subvolume documentation](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html).
- **Deletion and reclamation are separate events.** Initial `subvolume sync`
  attempts waited about 30 seconds for transaction commit. Calling `filesystem
  sync` first reduced measured root-run batch reclamation to about 6–13 ms.
  The throughput table excludes that separate batch wait. Deleting many retained
  snapshots may behave differently; keep a reclamation queue and measure it.
- **Unprivileged operations and inspection differ.** UID 1000 could create,
  snapshot and delete its writable subvolumes. The prepared-root benchmark worked
  inside a user/mount namespace, but confirming reclamation with `subvolume sync`
  failed with B-tree-search `EPERM`. The harness reports that as unconfirmed,
  leaving confirmation to a suitably privileged reaper. An owned read-only
  temporary baseline had to be made writable before its unprivileged deletion.

The separate 16-worker burst measured 383 overlay lifecycles/s (352 including
reclamation) and 540 snapshot lifecycles/s acknowledged. The snapshot batch then
waited 1.008 s for reclamation confirmation, reducing end-to-end throughput to
22.8/s. `btrfs subvolume sync` polls at one-second intervals, so that observed
wait does not establish that actual reclamation needed a full second. It does
show why a fast deletion acknowledgment must not be advertised as completed
storage recovery, and why the runtime should not synchronously wait for that
utility after every environment.

The official [OverlayFS documentation](https://docs.kernel.org/filesystems/overlayfs.html)
also constrains mutation of mounted lower trees. A prepared immutable baseline
removes that particular dependency on a changing host tree. Neither mechanism
is a coherent snapshot of running processes or databases, and a Btrfs snapshot
remains in the same filesystem failure domain as its source.

## Architecture implication and remaining work

Keep **storage preparation**, **per-environment tree ownership**, **namespace
mount composition**, and **reclamation** separate. Make Btrfs snapshots a real
storage option from the start, particularly when faithful native tree semantics
and retained forensic state matter. Overlay remains a useful inexpensive view
over stable lower data. Reflink tree copying is useful where snapshot boundaries
do not match the selected directory, but it still walks the tree's metadata.

The integration test launched real Python through a writable snapshot binding,
observed exit code 0, verified baseline and host target were unchanged, then
closed the environment before deleting storage. No scratch paths, mounts, or
loop mappings remained. A root launch beneath a private UID-1000 directory
initially failed after user-namespace creation removed host DAC privileges;
launching as the intended operator UID fixed it. The failed setup and the normal
UID check are useful doctor cases.

Evidence is in ignored `artifacts/021-hostfork-storage/`: `ext4-final.json`,
`btrfs-final.json`, `prepared-user.json`, `btrfs-concurrency.json`, and `runtime.json`.
The concurrency run uses 24 cycles with at most 16 simultaneous clones. This is
not proof of hundreds of long-lived, heavily modified snapshots. Remaining gates
include a representative prepared host tree, real EBS storage, long-lived snapshot
churn, metadata exhaustion/ENOSPC, crashes during deletion, and retention policy.
The namespace/runtime deadline and process-tree failure experiments are separate.

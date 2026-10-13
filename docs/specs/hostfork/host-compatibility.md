# Hostfork host compatibility and storage

**Architecture proposal.** Reproducing the host's paths is inexpensive. Making
files independently writable needs a storage mechanism. Reproducing running
services is a separate problem. Hostfork should make these distinctions explicit.

Read [motivation and proposed direction](motivation.md) first for the overall design.

## What a complete clone can mean

| Requested behavior | Difficulty and consequence |
| --- | --- |
| See the same files at the same paths. | Straightforward starting point: inherit the host mount layout. Files are still shared until a rule changes that. |
| Read host data but prevent writes through selected paths. | Usually straightforward with read-only mounts. Other host processes may still change that data. |
| Write privately while starting from the same file contents. | Practical with snapshots, reflinks or overlays, subject to the storage layout. |
| Keep using a host database, agent socket or named pipe. | Often practical by preserving access to the actual endpoint. Operations still affect the shared service. |
| Get an independent copy of every running service and connection. | Requires service-specific recreation or a much broader machine checkpoint. Filesystem isolation alone cannot provide it. |

Our target should be **the same usable host environment with selected independent
state**. Support a broad private-files mode where storage allows it, while making
shared services explicit. Avoid calling an inherited writable filesystem an
independent clone.

Preserve familiar paths, identity and networking. A private process namespace
changes what `/proc` shows; private networking changes what `localhost` reaches.
Neither should be an automatic consequence of requesting a private directory.

## Treat Btrfs as an initial design option

A Btrfs snapshot creates an independent tree while initially sharing storage
blocks. Changes in either tree do not affect the other's files. Snapshots operate
on subvolumes, so existing directories may need layout preparation. Nested
subvolumes require separate handling.
[Btrfs snapshot documentation](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html)

For suitable hosts, prefer a writable snapshot mounted at the original path.
Repeated experiments can derive from one retained baseline. The application asks
for a “private writable copy”; it need not know about overlay layers.

The inspected root, repository and temporary paths use ext4 as of 2026-10-13.
Btrfs would require suitable storage or a prepared local baseline. Copying inputs
there once may suit repeated experiments, but refreshing that baseline is real
work; it does not instantly snapshot the ext4 host.

## Choose mechanisms by their guarantees

| Mechanism | Best use | Main tradeoff |
| --- | --- | --- |
| Native Btrfs snapshot | Repeated private trees on a prepared host. | Requires suitable subvolumes and permission to manage them. |
| Reflink copy | Independent files on a filesystem that supports shared-block copies. | Still walks the directory tree; a tree-wide copy is not one atomic snapshot. |
| OverlayFS | Private writes over a suitable stable source without reorganizing it into subvolumes. | Depends on the source remaining stable and has special change-tracking semantics. |
| Ordinary copy | Small configuration trees and a broadly available fallback. | Pays the copying cost up front. |
| Shared or read-only host mount | Installed tools, intentionally shared services and reference data. | Continues to reference live host state. |

Reflinks create independent files with shared data blocks, unlike hard links.
They require compatible support and cannot share blocks across filesystems.
[Btrfs reflink documentation](https://btrfs.readthedocs.io/en/latest/Reflink.html)

OverlayFS does not freeze its source: changes underneath a mounted overlay have
undefined behavior. A snapshot can provide a stable source; often a writable
snapshot alone is simpler.
[OverlayFS documentation](https://docs.kernel.org/filesystems/overlayfs.html#changes-to-underlying-filesystems)

Allow different mechanisms for different paths, while preserving the requested
guarantees. Substituting a live overlay for an independent snapshot changes the
meaning of the fork and must be explicit.

## Preserve dependencies that are not ordinary files

`/usr`, virtual environments and toolchain directories mostly contain ordinary
files. `/proc`, `/sys`, `/dev`, `/run` and parts of a user's home can also describe
live processes, devices and services. They require different treatment:

| Dependency | Compatibility rule |
| --- | --- |
| Absolute paths, symlinks and interpreter locations | Preserve nested mounts and paths outside the project; decide whether later host mounts should appear. |
| Unix sockets and named pipes | Preserve the original endpoint when sharing its service. A copied pathname does not recreate the listening process or pipe peer. |
| `/proc`, `/sys` and `/dev` | Provide a view consistent with the selected process/device environment. Copying their apparent contents is not meaningful. |
| `/run`, shared memory and temporary directories | Preserve required endpoints; provide private scratch selectively. Replacing the whole directory can break working software. |
| User identity, groups and credentials | Preserve expected access where possible; diagnose mapping limitations rather than silently changing the program to run as root. |

A named pipe is a rendezvous with live readers and writers, and a Unix socket can
address a live service. Our design consequence is to treat them as shared or
recreated connections, independently of the storage-copy choice.
[Linux FIFO semantics](https://man7.org/linux/man-pages/man7/fifo.7.html),
[Unix socket semantics](https://man7.org/linux/man-pages/man7/unix.7.html)

For example, a private home may need the original SSH-agent socket restored at
its expected path. An independent service instead needs its own sidecar and
endpoint. A read-only socket directory does not make service requests read-only.

A shared service also resolves paths in its own filesystem view. Passing a private
project's path to a host language server may make it read the original project.
Run the service inside the fork when it must see the fork's private files.

## Footguns the architecture must address

The architecture should address these failure modes:

- **A protected project still has shared neighbors.** Agent homes, caches and
  paths reached through aliases may still write to the host. Show effective
  sharing for the whole view, including nested mounts and alternate paths.
- **The command exits but its children survive.** Tracking only the command or
  its process group can miss descendants. Own the whole workload independently
  of its original parent, and verify process identity during recovery.
- **Cleanup destroys the evidence or fails silently.** Stop writers, collect
  results, then release mounts and storage. Report incomplete cleanup; retain
  recoverable state. Memory-backed temporary storage can disappear after a crash.
- **Setup depends on import order.** Namespace changes inside the experiment can
  fail after libraries create threads. Prepare the environment in a fresh helper
  before starting application code.
- **A mount changes the path, but not an already-open handle.** An old working
  directory or file descriptor can still refer to the original tree. Start the
  workload after setting up its view and deliberately choose inherited handles.
- **Collected files misrepresent the result.** Copying overlay upper files can
  omit deletions and mishandle metadata. Export final visible content; represent
  changes as a separate operation with defined semantics.

Two broader traps remain. **One path is not one filesystem**: a root snapshot may
omit separate mounts and nested subvolumes. **Copied files may not be consistent
application state**: separately timed snapshots are not one machine-wide instant,
and databases can need their own snapshot procedures. Running installed software
and cloning its live state are different promises.

Finally, copy-on-write moves costs rather than eliminating them. Budget for writes,
retained baselines and cleanup under hundreds of runs. Btrfs can reclaim deleted
snapshot storage asynchronously, so “removed from the run list” and “space has
been reclaimed” are distinct observations.
[Btrfs snapshot lifecycle](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html#performance)

The [spikes](spike-findings.md) exercised inherited host views, private storage,
shared endpoints and worker/owner crashes. The resulting [architecture](architecture.md)
and [implementation plan](../../plans/hostfork.md) describe the proposed design
and remaining qualification gates.

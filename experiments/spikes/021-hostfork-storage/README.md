# Spike 021: prepared storage for Hostfork

Question: when host preparation is allowed, should each environment use a Btrfs
snapshot, a reflinked tree, an overlay, or an ordinary copy?

[`storage.py`](storage.py) runs real filesystem operations on a synthetic tree.
It does not copy the host, install packages, format an existing device, modify
sysctls, or provide the production storage API. It separates baseline preparation,
clone acknowledgment, first write plus `fsync`, deletion, and Btrfs reclamation.
See the [measured result](../../docs/spikes/021-hostfork-storage.md).

## Run on the current filesystem

From `experiments/`:

```sh
uv run --frozen python spikes/021-hostfork-storage/storage.py benchmark \
  --root artifacts/021-hostfork-storage \
  --output artifacts/021-hostfork-storage/ext4.json
```

The script creates a unique scratch directory under `--root` and runs inside a
private user/mount namespace. The default fixture is one 64 MiB random file,
1,000 files of 4 KiB, a hardlink, symlink and FIFO. Each method runs 12 lifecycles
at concurrency 1 and 4. Unsupported methods are recorded, without silently
falling back to a different copy implementation. Nothing under an existing
`--root` is treated as a disposable baseline.

The fixture is generated once, then cloned repeatedly. All data are synthetic.
Timings are warm-cache, include utility startup, and are not crash-durability
guarantees. Ordinary copies explicitly disable reflinks; reflink mode requires
them. CPU is split between the Python caller and waited child utilities; it does
not include all kernel background workers or whole-machine CPU. Space inspection
is outside the timed lifecycle. The full samples and percentile summaries are
written to JSON. The JSON can contain local paths and belongs under `artifacts/`.

## Run on a prepared Btrfs filesystem

An operator can provide an already mounted Btrfs directory:

```sh
uv run --frozen python spikes/021-hostfork-storage/storage.py benchmark \
  --root /prepared-btrfs/operator-owned-scratch \
  --btrfs /path/to/btrfs \
  --runtime-check \
  --output artifacts/021-hostfork-storage/prepared-btrfs.json
```

Mount preparation and initial data ingestion belong outside environment launch.
The filesystem needs writable space, an operator-owned destination, and a way to
delete the operator's subvolumes. `user_subvol_rm_allowed` was sufficient in this
experiment. The normal-UID probe checks creation, snapshots, deletion and the
prepared-root benchmark inside a user/mount namespace. In this environment,
confirming reclamation through `btrfs subvolume sync` required more privilege
than deleting owned snapshots. That limitation is recorded as unconfirmed
reclamation, not silently counted as completed cleanup. Utility warnings about
reading the default subvolume can occur despite successful owned-subvolume
deletion; stderr is surfaced rather than hidden.

For an AMI or attached volume, a useful layout is a flat set of versioned,
read-only baseline subvolumes and a separate directory of writable run snapshots.
During image preparation, populate each baseline with the operator's chosen
trees, preserving needed ownership, modes, hardlinks and extended attributes;
then mark the baseline read-only. Cloning the baseline is a per-run operation.
Versioning or refreshing it is preparation. A snapshot must stay on the same
Btrfs filesystem; a bind mount makes it visible at the desired path in the
environment. Live service sockets and other intentionally shared endpoints can
remain separate host bindings. A copied socket pathname does not clone a server.

Nested subvolumes need explicit treatment: taking a snapshot of their parent
does **not** copy their contents. Quiescing mutable source data is also an
operator preparation choice, not something implied by the word "snapshot".

## Disposable local Btrfs image

This mode requires passwordless sudo, Btrfs kernel support, loop devices, and
`btrfs`/`mkfs.btrfs` binaries. It creates a new sparse **regular file**, formats
only that file, and mounts it inside a child private mount namespace. It unmounts,
checks that no loop mapping remains, and removes the image on completion. The
2 GiB default is virtual size; it does consume real backing storage as written.
The raw timings are evidence for mechanisms, not EBS latency or cloud pricing.

If the binaries are not installed, on Ubuntu they can be extracted locally:

```sh
mkdir -p artifacts/021-hostfork-storage/tools
(
  cd artifacts/021-hostfork-storage/tools
  apt download btrfs-progs
  dpkg-deb -x btrfs-progs_*.deb root
)
uv run --frozen python spikes/021-hostfork-storage/storage.py image-run \
  --root artifacts/021-hostfork-storage \
  --btrfs artifacts/021-hostfork-storage/tools/root/bin/btrfs \
  --mkfs artifacts/021-hostfork-storage/tools/root/sbin/mkfs.btrfs \
  --runtime-check \
  --output artifacts/021-hostfork-storage/btrfs.json
```

The `--runtime-check` flag uses spike 020's Python library to bind a writable
snapshot at an existing path, launch ordinary Python, verify its result exists
only in the snapshot, close the environment, and delete the snapshot. Image
mounting runs as root, but this integration runs as the invoking UID. A root
process that then creates a user namespace may lose its ability to traverse
private directories owned by a different host UID; using the intended operator
identity avoids that particular failure.

An additional bounded storage concurrency probe is:

```sh
uv run --frozen python spikes/021-hostfork-storage/storage.py image-run \
  --root artifacts/021-hostfork-storage \
  --btrfs artifacts/021-hostfork-storage/tools/root/bin/btrfs \
  --mkfs artifacts/021-hostfork-storage/tools/root/sbin/mkfs.btrfs \
  --methods overlay snapshot --workers 16 --iterations 24 \
  --output artifacts/021-hostfork-storage/btrfs-concurrency.json
```

Only run the benchmark on disposable scratch capacity. Btrfs metadata and shared
data consume a common pool; this harness does not implement quotas, ENOSPC
recovery, crash-proof ownership journals, or production reaping. Each utility has
a 90-second timeout. The ordinary outer benchmark has a 600-second timeout;
the privileged image runner uses a 600-second `timeout` with five seconds of
termination grace before forced kill, and a 615-second parent timeout.
Private namespace teardown is a second line of mount cleanup, not a claim that
an uninterruptible kernel operation can always finish within a deadline.

For retained forensic state in a real implementation, stop/reap the workload,
retain its snapshot or export its merged files, and only then queue storage
deletion. Keep that queue and the reason for death outside disposable storage.
Snapshot deletion acknowledgment and eventual space reclamation are different
states; an idle reaper can batch the latter instead of making every launch wait.

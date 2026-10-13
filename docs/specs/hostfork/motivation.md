# Hostfork motivation and proposed direction

**Architecture proposal.** Hostfork would run ordinary installed software in a
derived view of the host, with selected private state and reliable cleanup.

The first runnable experiments are summarized in [spike findings](spike-findings.md).
The resulting [architecture](architecture.md) and [implementation plan](../../plans/hostfork.md)
are the proposed implementation baseline; the production library remains unimplemented.

Hostfork is an independent library design with no backward-compatibility or
migration requirement.

## Start with the host

Preserve the host's paths, installed software and connections to local services.
The caller then describes the differences: which directories become private
copies, which are read-only, and which remain shared.

Linux provides the starting point: a new mount namespace inherits the caller's
mount layout. Configure subsequent mount changes to stay local. The underlying
files initially remain shared; copying the view does not copy their contents.
[Linux mount namespace documentation](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html)

That distinction defines the default: **full host visibility, followed by explicit
changes to sharing**. An experiment preset can make its workspace and application
state private. The library should not silently replace `/run`, hide services, or
make everything read-only. The plan shows what remains shared, including writable
paths. This is separation for convenience, with no security-boundary claim.

## Responsibilities moved into Hostfork

| Application-managed approach | Proposed Hostfork |
| --- | --- |
| Experiment code performs setup and teardown. | An environment owner manages lifetime; the experiment supplies the view and commands. |
| Mount choices are embedded in application logic. | Describe differences from the host independently of any agent or experiment. |
| Private writes mean OverlayFS. | Choose native snapshots, reflinks or overlays according to the required guarantees. |
| Cleanup tracks command leaders and process groups. | Own descendants and sidecars even after the original command exits. |
| Every experiment manages logs, extraction and timeout recovery. | Make output, export and cleanup reporting ordinary library operations. |

The environment owner remains outside the workload. A failed worker therefore
does not also destroy the code responsible for stopping it or preserving results.

## Three independent choices

The public model should separate three choices:

1. **What the software sees.** Preserve host paths and services, then select
   private, read-only or shared areas. Process visibility and networking are
   separate choices; owning a process tree does not require hiding host processes.
2. **How private files are stored.** Prefer native copy-on-write snapshots where
   the host supports them. Keep other methods useful on ordinary installations.
   Report whether inputs are stable snapshots or references to live host files.
3. **Who owns the run.** One owner handles commands, sidecars, requested resource
   limits, output and cleanup. A Python handle, CLI and optional HTTP controller
   all operate through that owner.

An environment can outlive its first command. That allows a worker to finish, a
verifier to examine its changes, and the caller to export results before releasing
the environment. Retaining files after shutdown is a separate choice from keeping
processes alive.

Environment lifetime can also survive the launching application. Give retained
runs an explicit expiry and an independently usable reaper. Execution expiry,
termination grace, cleanup/export time and retained evidence are separate choices;
an external controller must be able to stop a run whose own supervisor is stuck.

## What using it should feel like

For a typical experiment, the caller should be able to express this:

```text
Start with this host, at the same paths.
Give me a private writable copy of the project and this application's state.
Keep the installed toolchains and selected host services available.
Make the reference dataset read-only.
Run this Python worker and its sidecar within the requested resource budget.
Run a verifier, collect the results, then close the entire run.
```

Doctor checks whether the choices work here. Planning explains sharing and storage
before launch. Status shows running processes, changes and cleanup progress.

## What to establish first

Prove host compatibility, independent writable state and reliable cleanup together.
Investigate Btrfs snapshots and OverlayFS from the start, including installed
software that depends on a host socket or named pipe. Test repeated runs at scale
and forced worker/owner failure before settling the helper arrangement. FastAPI,
PTYs and GPU allocation can follow.

The proposed package remains `habemus-papadum-hostfork` / `pdum.hostfork`, independent
of MITM and Codex. See [host compatibility and storage](host-compatibility.md) for
the limits of a complete clone, the filesystem choices and the main footguns.
The [architecture](architecture.md) defines the components and public contracts.
The earlier [design notes](design-notes.md) remain exploratory background.

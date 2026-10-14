# Research and spikes

The original `agent-spike` work is imported under `experiments/`, alongside the
workspace's four Python packages. Continue new investigations there; historical
probe code remains separate from implementations of the architecture proposals.

The import preserves runnable source, current reports/tutorials, the Vite protocol
guide, and pnpm/uv workspace locks. It does not copy credentials, captured traffic,
authentication profiles, virtual environments, dependencies, compiled binaries,
Git history, or generated build output. The original checkout is left intact.
Historical artifact links may therefore point to evidence that exists only in the
original checkout. Findings are preserved, not newly verified by the import.

## Read the findings

Start with the [combined Codex client findings](codex-client-findings.md), completed
14 October 2026. Spikes 025–034 cover history/replay, session administration,
late joins, remote files/processes, images and shared health/cost analysis.
The overview links every individual report and records the recommendation,
measured usage and remaining checks. No new library was introduced. The
[original proposal](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/proposals/codex-client-feasibility-spikes.md)
preserves the questions and scope.

The follow-on [API design](specs/codex-client.md) and
[implementation plan](plans/codex-client.md) translate those findings into a
proposed TypeScript client. They are ready for review; construction has not begun.

The [Hostfork spike findings](specs/hostfork/spike-findings.md) summarize the current
storage, compatibility, scale and lifetime experiments. Their runnable code and
individual reports are under `experiments/spikes/020-*` through `024-*`; these are
research implementations, separate from the distributable packages.
The resulting [Hostfork architecture](specs/hostfork/architecture.md) and
[implementation plan](plans/hostfork.md) distinguish proposed delivery from those
measured experiments.

Claude spikes 014–016 led to the separate Python launcher. The
[current guide](claude.md), [qualification report](claude-validation.md) and
[checkpoint/follow-up](claude-handoff.md) describe that implementation, including
real browser/Node checks. The research reports retain their earlier TypeScript
architecture and evidence; their pending work is not the current package status.

Local checkout paths below have corresponding repository links for site readers:

- [`experiments/README.md`](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/README.md): setup and available commands.
- [`experiments/IMPORT.md`](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/IMPORT.md): provenance, exclusions, and migration notes.
- [`experiments/plans.md`](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/plans.md): original motivation and system goals.
- [`experiments/docs/README.md`](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/README.md): index of all spike results.
- [`experiments/docs/tutorials/codex-upstream-auth.md`](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/tutorials/codex-upstream-auth.md): historical upstream authentication tutorial.
- [`experiments/vendor/README.md`](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/vendor/README.md): Codex source pin, checkout instructions, and preserved browser-Origin patch.

Repository links reflect the changes only after they are committed and pushed.
The main MkDocs site indexes the research rather than maintaining duplicate copies
of every historical report. The separate Vite application remains its protocol guide.

## Work in the research workspace

From the repository root:

```sh
cd experiments
pnpm install --frozen-lockfile
uv sync --all-packages --locked
pnpm typecheck
pnpm build
pnpm dev:web
```

Use the research workspace's Node/Python pins and declared pnpm version. Some
spikes additionally need the pinned Codex source, a compiled binary, private
historical captures, or explicitly selected live authentication; follow their
individual reports. Type-checking/building does not run live model experiments.
Do not copy the old environment or captures just to make missing-evidence probes
appear reproducible.

The root Python CI configuration covers the four distributable packages and the
separate official Claude client example. It does not install research dependencies
or automatically run paid experiments.
Research validation and live probes are explicit commands. A separate no-secret
research CI job can be introduced later without widening the package release job.

## Add the next spike

Read `experiments/AGENTS.md`, then use the next unused numbered directory under
`experiments/spikes/` and write its one-page result in `experiments/docs/spikes/`.
Update the research result index. Record the question, versions, reproduction,
evidence, limitations and whether behavior was observed live or inferred from
source. Keep generated evidence in ignored local paths and normal developer
configuration untouched.

Use small inexpensive live calls for actual provider behavior, bounded by the
research instructions. Local services and fixtures remain useful for deterministic
failure tests, but do not establish real provider authentication or transport
behavior. Promote useful findings into the package proposals deliberately rather
than importing experimental code into their public APIs without review.

# pdum_agent_tools

This repository contains six Python packages being developed together in a uv
workspace. The first local implementation is working, with real network/process
tests and a live native-Codex-client interoperability check.

| Package | Intended purpose |
| --- | --- |
| [habemus-papadum-mitm](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/packages/mitm/README.md) | A general-purpose MITM sidecar for traffic recording, independent of AI agents. |
| [habemus-papadum-codex-launcher](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/packages/codex-launcher/README.md) | Named Codex profiles and app-server launch configuration. |
| [habemus-papadum-hostfork](hostfork.md) | Host-derived Linux environments, private storage, process ownership and recovery. |
| [habemus-papadum-claude-launcher](claude.md) | Isolated Claude profiles and independent workers for official browser/Node SDK clients; new, unreleased package. |
| [habemus-papadum-agent-history](agent-history.md) | Native-history ingestion, shared analytical schema and local/MotherDuck publication, paired with the TypeScript analysis library. |
| [habemus-papadum-orchestrator](orchestrator.md) | Foreground coordinator identity/management foundation and isolated browser development workflow; provider launching follows. |

Start with [implementation status](implementation-status.md) for commands, APIs,
observed results and remaining limitations. The [testing guide](testing.md) separates
ordinary real local tests from explicitly enabled small paid provider probes.
The [profile setup guide](profiles.md) covers Rich/Questionary interviews,
selective native imports, editable TOML and upstream authentication workflows.

## Architecture and implementation proposals

- [Full system and library proposal](plans/agent-orchestrator/system-design.md):
  the current review entry point, with library responsibilities, design decisions
  and [implementation dependencies](plans/agent-orchestrator/system/implementation.md).
- [Agreed design principles](design-principles.md): trusted-network operation,
  practical hygiene, thin native configuration, foreground ownership, asynchronous
  inspection without initial capture quotas, and reusable Typer CLIs.
- [Architecture overview](architecture.md)
- [Runtime contracts and gotchas](runtime-contracts.md): versioned behavior that
  client, coordinator and background-job implementations must account for.
- [Codex launcher](specs/codex-launcher.md)
- [Codex client API design](specs/codex-client.md) and
  [implementation plan](plans/codex-client.md), with follow-up refinements from the HP Agent spikes
- [Claude launcher](claude.md), [architecture](specs/claude-launcher.md),
  [delivery plan](plans/claude-launcher.md), [qualification report](claude-validation.md)
  and [checkpoint/follow-up](claude-handoff.md)
- [MITM sidecar](specs/mitm.md)
- [Hostfork](hostfork.md), Linux environments with private storage and independent deadlines
- [Hostfork architecture](specs/hostfork/architecture.md) and [implementation plan](plans/hostfork.md)
- [Hostfork compatibility and storage](specs/hostfork/host-compatibility.md)
- [Joint implementation sequence](plans/implementation.md)
- [Launcher implementation plan](plans/codex-launcher.md)
- [MITM implementation plan](plans/mitm.md)
- [Research and spikes](research.md)
- [Codex client feasibility findings](codex-client-findings.md): combined results
  from spikes 025–034, before designing new client libraries.
- [Agent orchestrator component map](plans/agent-orchestrator/index.md): the
  proposed multi-provider web application, with twenty-two component stubs and
  two throwaway web studies informing later specifications and live slices.
- [HP Agent findings](hp-agent-findings.md): browser/Node execution, SDK choice,
  faithful prompt records and implications for shared client/history code.
- [HP Agent behavioral findings](hp-agent-behavior.md): host tools, skills/MCP,
  real compaction, model-selected delegation and a first coding comparison.
- [HP Agent parallel work](hp-agent-work.md): parallel tools, independent jobs,
  client lifetimes and the [AIUI integration contract](specs/hp-aiui-integration.md).
- [HP Agent power-user parity](hp-agent-parity.md): source-linked feature inventory,
  shared runtime structure and advanced control edge cases.

The proposals recommend concrete architecture, interfaces, defaults, and phased
acceptance criteria. They are broader than the first implementation, with remaining
compatibility checks and deferred features distinguished from working functionality.

Start with the [development guide](development.md) for environment setup, conventions,
validation, and releases. Repository instructions for coding agents are maintained in
[AGENTS.md](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/AGENTS.md),
with [CLAUDE.md](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/CLAUDE.md)
pointing to the same guidance.

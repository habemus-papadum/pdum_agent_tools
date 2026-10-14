# pdum_agent_tools

This repository contains four Python packages being developed together in a uv
workspace. The first local implementation is working, with real network/process
tests and a live native-Codex-client interoperability check.

| Package | Intended purpose |
| --- | --- |
| [habemus-papadum-mitm](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/packages/mitm/README.md) | A general-purpose MITM sidecar for traffic recording, independent of AI agents. |
| [habemus-papadum-codex-launcher](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/packages/codex-launcher/README.md) | Named Codex profiles and app-server launch configuration. |
| [habemus-papadum-hostfork](hostfork.md) | Host-derived Linux environments, private storage, process ownership and recovery. |
| [habemus-papadum-claude-launcher](claude.md) | Isolated Claude profiles and independent workers for official browser/Node SDK clients; new, unreleased package. |

Start with [implementation status](implementation-status.md) for commands, APIs,
observed results and remaining limitations. The [testing guide](testing.md) separates
ordinary real local tests from explicitly enabled small paid provider probes.
The [profile setup guide](profiles.md) covers Rich/Questionary interviews,
selective native imports, editable TOML and upstream authentication workflows.

## Architecture and implementation proposals

- [Agreed design principles](design-principles.md): trusted-network operation,
  practical hygiene, thin native configuration, foreground ownership, asynchronous
  inspection without initial capture quotas, and reusable Typer CLIs.
- [Architecture overview](architecture.md)
- [Codex launcher](specs/codex-launcher.md)
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

The proposals recommend concrete architecture, interfaces, defaults, and phased
acceptance criteria. They are broader than the first implementation, with remaining
compatibility checks and deferred features distinguished from working functionality.

Start with the [development guide](development.md) for environment setup, conventions,
validation, and releases. Repository instructions for coding agents are maintained in
[AGENTS.md](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/AGENTS.md),
with [CLAUDE.md](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/CLAUDE.md)
pointing to the same guidance.

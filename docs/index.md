# pdum_agent_tools

This repository contains two Python packages being developed together in a uv
workspace. Their infrastructure is in place, and architecture proposals and plans are
available for review. Implementation has not begun.

| Package | Intended purpose |
| --- | --- |
| [habemus-papadum-mitm](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/packages/mitm/README.md) | A general-purpose MITM sidecar for traffic recording, independent of AI agents. |
| [habemus-papadum-codex-launcher](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/packages/codex-launcher/README.md) | Named Codex profiles and app-server launch configuration. |

Neither package exposes functional APIs or commands yet. These scope descriptions
are not specifications or promises of existing features.

## Architecture and implementation proposals

- [Agreed design principles](design-principles.md): trusted-network operation,
  practical hygiene, thin native configuration, foreground ownership, asynchronous
  inspection without initial capture quotas, and reusable Typer CLIs.
- [Architecture overview](architecture.md)
- [Codex launcher](specs/codex-launcher.md)
- [MITM sidecar](specs/mitm.md)
- [Joint implementation sequence](plans/implementation.md)
- [Launcher implementation plan](plans/codex-launcher.md)
- [MITM implementation plan](plans/mitm.md)
- [Research and spikes](research.md)

The proposals recommend concrete architecture, interfaces, defaults, and phased
acceptance criteria. They remain subject to review, with compatibility checks and
deferred features distinguished from implemented functionality.

Start with the [development guide](development.md) for environment setup, conventions,
validation, and releases. Repository instructions for coding agents are maintained in
[AGENTS.md](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/AGENTS.md),
with [CLAUDE.md](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/CLAUDE.md)
pointing to the same guidance.

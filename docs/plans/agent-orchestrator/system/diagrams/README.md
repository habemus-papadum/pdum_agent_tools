# System diagrams: Mermaid source

Generated previews accompany the review documents so diagrams remain readable in
Markdown viewers without a Mermaid extension. These sources are the editable
record; regenerate the SVG after changing a diagram. Rendered and checked with
the research workspace's Mermaid 12.2.0 in a real browser on 26 October 2026.

## Runtime layout

```mermaid
flowchart TB
    App[Orchestrator web application] --> UI[Reusable agent UI and AIUI]
    App --> Management[Management client]
    App --> Clients[Codex and Claude clients / HP client]
    App --> Local[HP browser Worker]
    UI --> Facts[Shared view contracts and history analysis]
    Clients --> Facts
    Management -->|management HTTP and status| Coordinator[One Python coordinator per host]
    Coordinator -->|existing launcher libraries| Runtimes[Codex / Claude / HP Node processes]
    Clients -->|direct session connections| Runtimes
    Coordinator --> Data[Native history and ingestion services]
    Data --> Analytics[Local DuckDB or MotherDuck]
```

## Implementation dependencies

```mermaid
flowchart LR
    S0[S0 Contracts and isolated dev flow] --> S1[S1 Codex vertical slice]
    S1 --> Review[Review first real workflow]
    Review --> S2[S2 Persistent Claude integration]
    Review --> S3[S3 Portable HP extraction]
    Review --> S4[S4 Analysis and ingestion]
    S2 --> S5[S5 Daily orchestrator integration]
    S3 --> S5
    S4 --> S5
    S5 --> S6[S6 Selected extensions]
```

## Client library dependencies

```mermaid
flowchart TD
  app["Orchestrator app and component lab"] --> ui["agent-ui · Solid and AIUI slices"]
  app --> management["orchestrator-client · host management"]
  app --> codex["codex-client"]
  app --> claude["claude-client"]
  app --> hp["hp-agent"]
  app --> analysis["agent-history /analysis and /sql"]
  ui --> core["agent-core · pure contracts"]
  management --> core
  codex --> core
  claude --> core
  hp --> core
  analysis --> core
  ui --> aiui["AIUI public libraries and HP design system"]
  app --> prompts["AIUI structured prompts and inspector"]
```

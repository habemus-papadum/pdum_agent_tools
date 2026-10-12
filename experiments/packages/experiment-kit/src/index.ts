export interface Experiment {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: "planned" | "running" | "complete";
}

export const experiments: readonly Experiment[] = [
  {
    id: "process-control",
    title: "CLI process control",
    description: "Explore starting, stopping, and observing Claude Code and Codex processes.",
    status: "planned",
  },
  {
    id: "event-streams",
    title: "Structured event streams",
    description: "Explore how CLI input and output can be consumed by another application.",
    status: "planned",
  },
  {
    id: "remote-sessions",
    title: "Remote sessions",
    description: "Explore controlling a session from a separate process or machine.",
    status: "planned",
  },
];

import type { CoordinatorStatus } from "@habemus-papadum/agent-core";
import { OrchestratorClient } from "@habemus-papadum/orchestrator-client";

export type RunList = Awaited<ReturnType<OrchestratorClient["runs"]>>;
export interface ConnectionObservation {
  phase: "idle" | "loading" | "ready" | "unavailable";
  status: CoordinatorStatus | null;
  runs: RunList | null;
  observedAt: string | null;
  error: string | null;
}

export const initialObservation: ConnectionObservation = {
  phase: "idle",
  status: null,
  runs: null,
  observedAt: null,
  error: null,
};

/** Owns read requests independently of graph remounts; failure retains last-known facts. */
export class ConnectionOwner {
  private generation = 0;
  private request: AbortController | null = null;
  private observation: ConnectionObservation = initialObservation;

  constructor(
    private readonly client: Pick<OrchestratorClient, "status" | "runs"> = new OrchestratorClient(),
  ) {}

  async refresh(publish: (value: ConnectionObservation) => void): Promise<ConnectionObservation> {
    const mine = ++this.generation;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.observation = { ...this.observation, phase: "loading", error: null };
    publish(this.observation);
    try {
      const [status, runs] = await Promise.all([
        this.client.status({ signal: request.signal }),
        this.client.runs({ signal: request.signal }),
      ]);
      if (mine !== this.generation) return this.observation;
      this.observation = {
        phase: "ready",
        status,
        runs,
        observedAt: new Date().toISOString(),
        error: null,
      };
    } catch (error) {
      if (mine !== this.generation) return this.observation;
      this.observation = {
        ...this.observation,
        phase: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    publish(this.observation);
    return this.observation;
  }
}

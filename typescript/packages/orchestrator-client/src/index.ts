import {
  type CoordinatorStatus,
  MANAGEMENT_API_VERSION,
  type RunsResponse,
} from "@habemus-papadum/agent-core";

export type { CoordinatorStatus, RunsResponse } from "@habemus-papadum/agent-core";

export class ManagementError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly outcome: "not-sent" | "rejected" | "unknown",
  ) {
    super(message);
    this.name = "ManagementError";
  }
}
export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}
export interface RequestOptions {
  signal?: AbortSignal;
}

/** Management only. Import/construction never launches or connects to a provider. */
export class OrchestratorClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private async request<T>(path: string, options: RequestOptions, body?: unknown): Promise<T> {
    if (options.signal?.aborted)
      throw new ManagementError("Request cancelled before send", null, "not-sent");
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: options.signal,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      // No automatic retry after possibly dispatching a mutation.
      throw new ManagementError(String(cause), null, "unknown");
    }
    if (!response.ok)
      throw new ManagementError(
        `Management HTTP ${response.status}: ${await response.text()}`,
        response.status,
        response.status >= 500 ? "unknown" : "rejected",
      );
    try {
      return (await response.json()) as T;
    } catch {
      throw new ManagementError("Invalid management response", response.status, "unknown");
    }
  }
  async status(options: RequestOptions = {}): Promise<CoordinatorStatus> {
    const status = await this.request<CoordinatorStatus>("status", options);
    if (status.apiVersion !== MANAGEMENT_API_VERSION)
      throw new ManagementError(
        `Unsupported management API ${status.apiVersion}`,
        null,
        "rejected",
      );
    return status;
  }
  runs(options: RequestOptions = {}): Promise<RunsResponse> {
    return this.request("runs", options);
  }
  stop(instanceId: string, options: RequestOptions = {}): Promise<unknown> {
    return this.request("stop", options, { instanceId });
  }
}

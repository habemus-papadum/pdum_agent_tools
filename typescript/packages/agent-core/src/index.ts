/** The first implemented host API. Provider capabilities remain separate. */
export const MANAGEMENT_API_VERSION = "0" as const;
export type ProviderId = "codex" | "claude" | "hp";
export interface HostRef {
  hostId: string;
}
export interface ProfileRef extends HostRef {
  provider: ProviderId;
  id: string;
}
export interface RunRef extends HostRef {
  provider: ProviderId;
  runId: string;
  ownerInstanceId: string;
}
export interface ConversationRef extends HostRef {
  provider: ProviderId;
  conversationId: string;
  profileId?: string;
  sourceId?: string;
}

/** Raw evidence and derived facts must keep their source, coverage and native identity. */
export interface EvidenceRef {
  source: "native-live" | "native-history" | "runtime-replay" | "ingested" | "diagnostic";
  provider: ProviderId;
  sourceId: string;
  runId?: string;
  sequence?: number;
  observedAt?: string;
  occurredAt?: string;
}
export type Coverage = { kind: "known" } | { kind: "partial" | "unknown"; reason: string };
export type DeliveryOutcome = "not-sent" | "pending" | "accepted" | "rejected" | "unknown";

export interface CoordinatorStatus {
  apiVersion: typeof MANAGEMENT_API_VERSION;
  instanceId: string;
  hostId: string;
  pid: number;
  processStartedAt: number;
  startedAt: string;
  stoppedAt: string | null;
  state: "running" | "stopping" | "stopped";
  stateDirectory: string;
  workspaceDirectory: string;
  profileRoots: Record<ProviderId, string>;
  capabilities: string[];
}

/** No provider runtime is implemented by S0; later records retain explicit owner identity. */
export interface RunSummary extends RunRef {
  state: "starting" | "running" | "stopping" | "stopped" | "unknown";
  observedAt: string;
}
export interface RunsResponse {
  runs: RunSummary[];
}

export interface LaunchContext {
  hostId: string;
  cwd: string;
  projectId?: string;
}
export interface ResolvedValue {
  value: string;
  basis: "context" | "override";
}
/** Context is resolved at the action, not inherited from an unrelated previous launch. */
export function resolveLaunchContext(
  context: LaunchContext,
  overrides: Partial<LaunchContext> = {},
) {
  const choose = (key: "hostId" | "cwd"): ResolvedValue => ({
    value: overrides[key] ?? context[key],
    basis: overrides[key] === undefined ? "context" : "override",
  });
  return {
    host: choose("hostId"),
    cwd: choose("cwd"),
    projectId: overrides.projectId ?? context.projectId,
  };
}

export interface TurnSettings {
  model?: string;
  effort?: string;
  serviceTier?: string;
}
/** Carry-forward state is supplied per conversation. No saved-default write occurs here. */
export function resolveTurnSettings(
  defaults: TurnSettings,
  working: TurnSettings,
  edits: TurnSettings = {},
) {
  const nextWorking = Object.fromEntries(
    Object.entries({ ...working, ...edits }).filter(([, value]) => value !== undefined),
  ) as TurnSettings;
  return { working: nextWorking, effective: { ...defaults, ...nextWorking } };
}

/** Include scope rather than concatenating ambiguous bare native IDs. */
export function conversationKey(ref: ConversationRef): string {
  return JSON.stringify([
    ref.provider,
    ref.hostId,
    ref.profileId ?? null,
    ref.sourceId ?? null,
    ref.conversationId,
  ]);
}

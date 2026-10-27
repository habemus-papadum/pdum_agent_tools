import type { CoordinatorStatus } from "@habemus-papadum/agent-core";
import { describe, expect, it } from "vitest";
import { type ConnectionObservation, ConnectionOwner } from "./connection.ts";

const status: CoordinatorStatus = {
  apiVersion: "0",
  instanceId: "instance-a",
  hostId: "host-a",
  pid: 42,
  processStartedAt: 100,
  startedAt: "2026-10-26T00:00:00Z",
  stoppedAt: null,
  state: "running",
  stateDirectory: "/test/state",
  workspaceDirectory: "/test/project",
  profileRoots: { codex: "/test/codex", claude: "/test/claude", hp: "/test/hp" },
  capabilities: ["status", "runs"],
};

describe("connection observation", () => {
  it("retains last-known identity and inventory after a transport failure", async () => {
    let failed = false;
    const owner = new ConnectionOwner({
      status: async () => {
        if (failed) throw new Error("Connection lost");
        return status;
      },
      runs: async () => ({ runs: [] }),
    });
    const observations: ConnectionObservation[] = [];
    const first = await owner.refresh((value) => observations.push(value));
    failed = true;
    const second = await owner.refresh((value) => observations.push(value));
    expect(first.phase).toBe("ready");
    expect(second).toMatchObject({
      phase: "unavailable",
      status,
      runs: { runs: [] },
      error: "Connection lost",
    });
    expect(second.observedAt).toBe(first.observedAt);
    expect(observations.map((value) => value.phase)).toEqual([
      "loading",
      "ready",
      "loading",
      "unavailable",
    ]);
  });

  it("a superseded read cannot overwrite a newer observation", async () => {
    let finishOld!: (value: CoordinatorStatus) => void;
    let call = 0;
    const newer = { ...status, instanceId: "instance-b" };
    const owner = new ConnectionOwner({
      status: () =>
        ++call === 1
          ? new Promise((resolve) => {
              finishOld = resolve;
            })
          : Promise.resolve(newer),
      runs: async () => ({ runs: [] }),
    });
    const observations: ConnectionObservation[] = [];
    const old = owner.refresh((value) => observations.push(value));
    await owner.refresh((value) => observations.push(value));
    finishOld(status);
    await old;
    expect(observations.at(-1)?.status?.instanceId).toBe("instance-b");
    expect(observations.filter((value) => value.phase === "ready")).toHaveLength(1);
  });
});

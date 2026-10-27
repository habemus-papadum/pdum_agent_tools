import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { startDevInstance } from "./index.mjs";

it("two real frontend/backend instances isolate profiles, proxies, caches and cleanup", async () => {
  const a = await startDevInstance({ host: "127.0.0.1" });
  let b;
  try {
    b = await startDevInstance({ host: "127.0.0.1" });
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(a.url).not.toBe(b.url);
    const read = async (url) => (await fetch(`${url}api/status`)).json();
    const first = await read(a.url),
      second = await read(b.url);
    expect(first.instanceId).toBe(a.instanceId);
    expect((await (await fetch(`${a.url}__dev/instance`)).json()).instanceId).toBe(a.instanceId);
    expect(second.instanceId).toBe(b.instanceId);
    expect(first.profileRoots.codex).not.toBe(second.profileRoots.codex);
    const wrong = await fetch(`${a.url}api/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: b.instanceId }),
    });
    expect(wrong.status).toBe(409);
    expect((await read(a.url)).state).toBe("running");
    await a.close();
    expect((await read(b.url)).state).toBe("running");
    expect(
      JSON.parse(await readFile(`${a.stateDirectory}/coordinator/instance.json`, "utf8")).state,
    ).toBe("stopped");
    await expect(startDevInstance({ stateDirectory: b.stateDirectory })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect((await read(b.url)).state).toBe("running");
    expect((await (await fetch(`${b.url}api/runs`)).json()).runs).toEqual([]);
  } finally {
    await a.close();
    await b?.close();
  }
});

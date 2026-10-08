import { describe, expect, it } from "vitest";
import { Surreal } from "../../packages/storage-surrealdb/node_modules/surrealdb";
import { closeProbeClient } from "../../packages/storage-surrealdb/src/probe-agent-knowledge-store.ts";

/**
 * Proves the bounded cleanup contract of the knowledge probe: the client
 * close is awaited within a fixed budget, a wedged close cannot extend it,
 * and cleanup failures never surface — so no unmanaged promise survives a
 * probe and the next probe on a fresh connection always runs.
 */
describe("closeProbeClient", () => {
  it("settles within the budget when the client close never settles", async () => {
    const wedged = {
      close: () => new Promise<void>(() => {}),
    } as unknown as Surreal;
    const started = Date.now();
    await closeProbeClient(wedged, 100);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("swallows a rejecting close without surfacing the error", async () => {
    const rejecting = {
      close: async () => {
        throw new Error("close exploded");
      },
    } as unknown as Surreal;
    await expect(closeProbeClient(rejecting, 1_000)).resolves.toBeUndefined();
  });

  it("settles promptly when the close resolves immediately", async () => {
    let closed = false;
    const orderly = {
      close: async () => {
        closed = true;
      },
    } as unknown as Surreal;
    const started = Date.now();
    await closeProbeClient(orderly, 5_000);
    expect(closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

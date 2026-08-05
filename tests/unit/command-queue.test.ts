import { describe, expect, test } from "vitest";
import { CommandQueue } from "../../apps/daemon/src/command-queue.ts";

describe("CommandQueue", () => {
  test("serializes commands and continues after a failure", async () => {
    const queue = new CommandQueue();
    const trace: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      trace.push("first:start");
      await firstGate;
      trace.push("first:end");
      return 1;
    });
    const second = queue.enqueue(async () => {
      trace.push("second");
      throw new Error("expected failure");
    });
    const third = queue.enqueue(async () => {
      trace.push("third");
      return 3;
    });

    await Promise.resolve();
    expect(trace).toEqual(["first:start"]);
    releaseFirst?.();

    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toThrow("expected failure");
    await expect(third).resolves.toBe(3);
    expect(trace).toEqual(["first:start", "first:end", "second", "third"]);
  });
});

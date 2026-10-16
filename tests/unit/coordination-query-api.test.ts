import { describe, expect, test, vi } from "vitest";
import { CoordinationQueryApi } from "../../apps/daemon/src/coordination-query-api.ts";
import type { CoordinationReadService } from "@ai-office/application/coordination/coordination-read-service.ts";
import { PlanningReadBusyError } from "@ai-office/application/ports/planning-read.port.ts";

function api(
  execute: CoordinationReadService["execute"],
  maxInFlight?: number,
): CoordinationQueryApi {
  return new CoordinationQueryApi({
    reads: { execute } as CoordinationReadService,
    projects: new Map([["p", ["P", "T"]]]),
    startedAt: () => new Date("2026-10-16T08:00:00.000Z"),
    ...(maxInFlight === undefined ? {} : { maxInFlight }),
  });
}

const read = (target: CoordinationQueryApi) =>
  target.handle(
    new Request("http://localhost/api/coordination/v1/projects/p/tasks"),
  );

describe("coordination query API transport", () => {
  test("a busy read answers RUNTIME_BUSY with retry-after", async () => {
    const response = await read(
      api(async () => {
        throw new PlanningReadBusyError();
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      coordinationApiVersion: 1,
      error: { code: "RUNTIME_BUSY", message: "A write is in progress; retry" },
    });
  });

  test("an unexpected failure leaks no message, path or stack", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure = new TypeError("/home/user/.ai-office/project.sqlite SECRET");
      const response = await read(
        api(async () => {
          throw failure;
        }),
      );
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        coordinationApiVersion: 1,
        error: { code: "INTERNAL_ERROR", message: "Query execution failed" },
      });
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain(".ai-office");
      // The operator log names the error type only.
      expect(errors).toHaveBeenCalledWith(
        "Coordination listener read failed: TypeError",
      );
      expect(JSON.stringify(errors.mock.calls)).not.toContain("SECRET");
    } finally {
      errors.mockRestore();
    }
  });

  test("reads beyond the in-flight bound answer RUNTIME_BUSY and the bound recovers", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const target = api(async () => {
      await held;
      return {} as Awaited<ReturnType<CoordinationReadService["execute"]>>;
    }, 2);
    const first = read(target);
    const second = read(target);
    const third = await read(target);
    expect(third.status).toBe(503);
    expect(await third.json()).toMatchObject({
      error: { code: "RUNTIME_BUSY" },
    });
    // Health is not a read of planning state and is always answered.
    const health = await target.handle(
      new Request("http://localhost/api/coordination/v1/health"),
    );
    expect(health.status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await read(target)).status).toBe(200);
  });

  test("a failed read releases its in-flight slot", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const target = api(async () => {
        throw new Error("boom");
      }, 1);
      expect((await read(target)).status).toBe(500);
      expect((await read(target)).status).toBe(500);
    } finally {
      errors.mockRestore();
    }
  });
});

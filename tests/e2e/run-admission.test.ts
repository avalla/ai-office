import { expect, test } from "vitest";
import { runRuntime } from "../helpers/run-runtime.ts";

test("terminal and blocked tasks cannot schedule and queued work is revalidated", async () => {
  const r = await runRuntime();
  try {
    for (const operation of ["cancel", "block"]) {
      const taskId = await r.task();
      await r.command([
        `task:${operation}`,
        "--project",
        r.projectId,
        "--task",
        taskId,
        ...(operation === "block" ? ["--reason", "Blocked"] : []),
      ]);
      expect((await r.schedule(taskId)).exitCode).toBe(1);
    }
    const taskId = await r.task();
    expect((await r.schedule(taskId)).exitCode).toBe(0);
    await r.command([
      "task:cancel",
      "--project",
      r.projectId,
      "--task",
      taskId,
    ]);
    const result = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout[0]!)).toMatchObject({
      results: [{ status: "cancelled", error: { code: "RUN_NOT_ELIGIBLE" } }],
    });
  } finally {
    await r.close();
  }
});

test("concurrent ticks claim one run only once", async () => {
  const r = await runRuntime();
  try {
    await r.schedule(await r.task());
    const ticks = await Promise.all(
      Array.from({ length: 4 }, () =>
        r.command(["run:tick", "--project", r.projectId, "--json"]),
      ),
    );
    expect(ticks.every((value) => value.exitCode === 0)).toBe(true);
    expect(
      ticks.flatMap(
        (value) =>
          (JSON.parse(value.stdout[0]!) as { results: unknown[] }).results,
      ),
    ).toHaveLength(1);
  } finally {
    await r.close();
  }
});

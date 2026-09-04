import { expect, test } from "vitest";
import { runRuntime } from "../helpers/run-runtime.ts";

test("run:tick exposes failures and mixed batches through the daemon", async () => {
  const runtime = await runRuntime();
  const { command, projectId, task, schedule } = runtime;
  try {
    expect(
      await command(["run:tick", "--project", projectId, "--json"]),
    ).toMatchObject({ exitCode: 0 });
    await schedule(await task());
    await schedule(await task(), true);
    const result = await command([
      "run:tick",
      "--project",
      projectId,
      "--capacity",
      "2",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout[0]!) as {
      schemaVersion: number;
      unsuccessful: number;
      results: { status: string }[];
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.unsuccessful).toBe(1);
    expect(report.results.map((value) => value.status).sort()).toEqual([
      "completed",
      "failed",
    ]);
    await schedule(await task(), true);
    const human = await command(["run:tick", "--project", projectId]);
    expect(human.exitCode).toBe(1);
    expect(human.stderr.join("\n")).toContain("EXECUTION_FAILED");
    expect(
      (await command(["run:tick", "--project", projectId, "--capacity", "101"]))
        .exitCode,
    ).toBe(1);
  } finally {
    await runtime.close();
  }
});

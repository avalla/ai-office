import { expect, test } from "vitest";
import { join } from "node:path";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { runRuntime } from "../helpers/run-runtime.ts";

test("queued cancellation and approved orphan reconciliation survive restart", async () => {
  const r = await runRuntime();
  try {
    const taskId = await r.task();
    const scheduled = await r.schedule(taskId);
    const runId = scheduled.stdout[0]!.replace("Agent run scheduled: ", "");
    const args = [
      "--project",
      r.projectId,
      "--run",
      runId,
      "--reason",
      "Inspect interrupted work",
      "--json",
    ];
    const database = openDatabase(join(r.root, ".ai-office", "project.sqlite"));
    const repository = new SqliteAgentRuntimeRepository(database);
    const run = (await repository.findRun(runId))!;
    run.transition("preparing", new Date());
    await repository.saveRun(run);
    run.transition("running", new Date());
    await repository.saveRun(run);
    database.close();
    await r.restart();
    const before = await r.command(["run:reconcile", ...args]);
    const plan = JSON.parse(before.stdout[0]!) as {
      planHash: string;
      classification: string;
      available: boolean;
    };
    expect(plan).toMatchObject({ classification: "orphaned", available: true });
    expect((await r.command(["run:cancel", ...args])).exitCode).toBe(1);
    expect(
      (await r.command(["run:reconcile", ...args, "--approve", "stale"]))
        .exitCode,
    ).toBe(1);
    expect(
      (await r.command(["run:reconcile", ...args, "--approve", plan.planHash]))
        .exitCode,
    ).toBe(0);
    expect(
      (await r.command(["run:reconcile", ...args, "--approve", plan.planHash]))
        .exitCode,
    ).toBe(1);
    const next = await r.schedule(taskId);
    expect(next.exitCode).toBe(0);
    const nextId = next.stdout[0]!.replace("Agent run scheduled: ", "");
    expect(
      (
        await r.command([
          "run:cancel",
          "--project",
          r.projectId,
          "--run",
          nextId,
          "--reason",
          "Stop queued work",
        ])
      ).exitCode,
    ).toBe(0);
    const tick = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--json",
    ]);
    expect(JSON.parse(tick.stdout[0]!)).toMatchObject({ results: [] });
  } finally {
    await r.close();
  }
});

test("live cancellation waits for executor acknowledgment and records owner provenance", async () => {
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const r = await runRuntime({
    execute: async () => {
      started();
      await gate;
      return { summary: "stopped", artifacts: [] };
    },
  });
  try {
    const taskId = await r.task();
    const runId = (await r.schedule(taskId)).stdout[0]!.replace(
      "Agent run scheduled: ",
      "",
    );
    const ticking = r.command(["run:tick", "--project", r.projectId, "--json"]);
    await start;
    const args = [
      "--project",
      r.projectId,
      "--run",
      runId,
      "--reason",
      "Stop work",
      "--json",
    ];
    const report = JSON.parse(
      (await r.command(["run:reconcile", ...args])).stdout[0]!,
    ) as { ownerId: string; classification: string; available: boolean };
    expect(report).toMatchObject({ classification: "live", available: false });
    expect(report.ownerId).toBeTypeOf("string");
    expect(
      (
        await r.command([
          "task:cancel",
          "--project",
          r.projectId,
          "--task",
          taskId,
        ])
      ).exitCode,
    ).toBe(0);
    const cancelling = await r.command(["run:reconcile", ...args]);
    expect(JSON.parse(cancelling.stdout[0]!)).toMatchObject({
      recordedStatus: "running",
      cancellationRequested: true,
    });
    finish();
    const done = await ticking;
    expect(done.exitCode).toBe(1);
    expect(JSON.parse(done.stdout[0]!)).toMatchObject({
      results: [{ status: "cancelled" }],
    });
  } finally {
    finish();
    await r.close();
  }
});

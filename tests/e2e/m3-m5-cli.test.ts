import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";

const dirs: string[] = [];
const io = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (v: string) => stdout.push(v),
      stderr: (v: string) => stderr.push(v),
    } satisfies CliIo,
  };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("M3-M5 CLI", () => {
  test("runs agents with locking and exports deterministic governance", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-m3-m5-"));
    dirs.push(root);
    const run = async (args: string[]) => {
      const out = io();
      expect(await runCli(args, { projectRoot: root, io: out.io })).toBe(0);
      expect(out.stderr).toEqual([]);
      return out.stdout;
    };
    const projectId =
      (await run(["project:create", "Demo"]))[0]?.replace(
        "Project created: ",
        "",
      ) ?? "";
    const taskId =
      (
        await run([
          "task:create",
          "--project",
          projectId,
          "--title",
          "Implement runtime",
        ])
      )[0]?.replace("Task created: ", "") ?? "";
    const agents = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "agents",
    );
    expect(
      await run(["agent:sync", "--project", projectId, "--directory", agents]),
    ).toEqual(["Agent definitions synchronized: 4"]);
    const agentId = `agent:${projectId}:developer`;
    const incompleteIntent = io();
    expect(
      await runCli(
        [
          "run:schedule",
          "--project",
          projectId,
          "--task",
          taskId,
          "--agent",
          agentId,
          "--resource",
          "workspace",
        ],
        { projectRoot: root, io: incompleteIntent.io },
      ),
    ).toBe(1);
    expect(incompleteIntent.stderr).toEqual([
      "Controlled runs require both --resource and --operation",
    ]);
    const runId =
      (
        await run([
          "run:schedule",
          "--project",
          projectId,
          "--task",
          taskId,
          "--agent",
          agentId,
        ])
      )[0]?.replace("Agent run scheduled: ", "") ?? "";
    const locked = io();
    expect(
      await runCli(
        [
          "run:schedule",
          "--project",
          projectId,
          "--task",
          taskId,
          "--agent",
          agentId,
        ],
        { projectRoot: root, io: locked.io },
      ),
    ).toBe(1);
    expect(locked.stderr[0]).toContain("already locked");
    expect(await run(["run:tick", "--project", projectId])).toEqual([
      "Agent runs executed: 1",
      `Run ${runId}: completed`,
      "Unsuccessful runs: 0",
    ]);
    expect((await run(["run:list", "--project", projectId]))[1]).toContain(
      `${runId}\tcompleted`,
    );
    expect(
      (await run(["run:show", "--project", projectId, "--run", runId])).join(
        "\n",
      ),
    ).toContain("Simulated execution completed");
    const milestone =
      (
        await run([
          "milestone:create",
          "--project",
          projectId,
          "--title",
          "M5",
          "--description",
          "Governance",
        ])
      )[0]?.replace("Milestone created: ", "") ?? "";
    await run([
      "milestone:set-status",
      "--project",
      projectId,
      "--milestone",
      milestone,
      "--status",
      "active",
    ]);
    const requirement =
      (
        await run([
          "requirement:create",
          "--project",
          projectId,
          "--key",
          "GOV-01",
          "--title",
          "Audit approvals",
          "--description",
          "Persist decisions",
          "--milestone",
          milestone,
        ])
      )[0]?.replace("Requirement created: ", "") ?? "";
    await run([
      "requirement:set-status",
      "--project",
      projectId,
      "--requirement",
      requirement,
      "--status",
      "accepted",
    ]);
    await run([
      "adr:create",
      "--project",
      projectId,
      "--title",
      "SQLite truth",
      "--context",
      "Need durable state",
      "--decision",
      "Use explicit SQL",
      "--consequences",
      "Markdown is generated",
    ]);
    const review =
      (
        await run([
          "review:create",
          "--project",
          projectId,
          "--subject-type",
          "requirement",
          "--subject",
          requirement,
          "--reviewer",
          "qa",
        ])
      )[0]?.replace("Review created: ", "") ?? "";
    await run([
      "review:decide",
      "--project",
      projectId,
      "--review",
      review,
      "--actor",
      "owner",
      "--decision",
      "approved",
    ]);
    await run(["governance:export", "--project", projectId]);
    const path = join(root, ".ai-office", "generated", "governance.md");
    const first = readFileSync(path, "utf8");
    await run(["governance:export", "--project", projectId]);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(first).toContain("GOV-01");
    expect(first).toContain("approved");
    const db = openDatabase(join(root, ".ai-office", "project.sqlite"));
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM agent_run_event WHERE run_id=?",
        )
        .get(runId)?.count,
    ).toBe(5);
    expect(() => db.exec("DELETE FROM agent_run_event")).toThrow("append-only");
    db.close();
  });
});

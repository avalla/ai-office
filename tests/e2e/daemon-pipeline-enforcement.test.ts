import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";

const roots: string[] = [];

function output(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    stdout,
    stderr,
  };
}

async function waitForDaemon(socketPath: string): Promise<void> {
  const client = new DaemonClient(socketPath);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error("Daemon did not become healthy");
}

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Enforced delivery",
    goals: ["Deliver through independent gates"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Runtime office",
    roles: ["architect", "developer", "reviewer", "qa"].map((id) => ({
      id,
      title: id,
      purpose: `${id} responsibility`,
      responsibilities: [`Perform ${id} stage`],
    })),
  },
  pipelines: [
    {
      id: "delivery",
      name: "Delivery",
      description: "Architecture through merge",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "architecture",
          name: "Architecture",
          roleId: "architect",
          objective: "Design",
          checks: ["Design complete"],
          requiresApproval: false,
          capabilities: ["fake.read"],
        },
        {
          id: "implementation",
          name: "Implementation",
          roleId: "developer",
          objective: "Build",
          checks: ["Implementation complete"],
          requiresApproval: false,
          capabilities: ["fake.read", "fake.write"],
        },
        {
          id: "review",
          name: "Review",
          roleId: "reviewer",
          objective: "Review",
          checks: ["Review accepted"],
          requiresApproval: true,
          requiresIndependentApproval: true,
          capabilities: ["fake.read"],
          requiresDifferentAgentFrom: ["implementation"],
        },
        {
          id: "qa",
          name: "QA",
          roleId: "qa",
          objective: "Verify",
          checks: ["QA passed"],
          requiresApproval: false,
          capabilities: ["fake.read"],
        },
        {
          id: "merge",
          name: "Merge",
          roleId: "developer",
          objective: "Merge",
          checks: ["Merge authorized"],
          requiresApproval: false,
          capabilities: ["fake.delete"],
          requiresDifferentAgentFrom: ["review"],
        },
      ],
    },
  ],
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("daemon enforced pipeline lifecycle", () => {
  test("blocks skipped gates and self-review before authorizing merge", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-daemon-pipeline-"));
    roots.push(root);
    const socketPath = join(root, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({ projectRoot: root, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const command = async (args: string[]) => {
      const capture = output();
      const exitCode = await runDaemonCli(args, {
        projectRoot: root,
        socketPath,
        workingDirectory: root,
        io: capture.io,
      });
      return { exitCode, ...capture };
    };

    try {
      await waitForDaemon(socketPath);
      const created = await command([
        "project:create",
        "Pipeline project",
        "--json",
      ]);
      const projectId = (
        JSON.parse(created.stdout[0]!) as { projectId: string }
      ).projectId;
      expect(
        (
          await command([
            "office:apply",
            "--project",
            projectId,
            "--manifest",
            JSON.stringify(manifest),
          ])
        ).exitCode,
      ).toBe(0);
      const task = await command([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Enforced feature",
      ]);
      const taskId = task.stdout[0]!.slice("Task created: ".length);

      const database = openDatabase(join(root, ".ai-office", "project.sqlite"));
      const runtime = new SqliteAgentRuntimeRepository(database);
      const timestamp = new Date("2020-01-01T00:00:00.000Z");
      for (const key of ["architect", "developer", "reviewer", "qa"] as const)
        await runtime.saveRole(
          Role.create({
            id: `role-${key}`,
            projectId,
            key,
            name: key,
            version: 1,
            capabilities: [],
            tools: [],
            modelPolicy: "default",
            limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
            sourcePath: `${key}.yaml`,
            now: timestamp,
          }),
        );
      const agents: Agent[] = ["architect", "developer", "reviewer", "qa"].map(
        (key) => ({
          id: `${key}-agent`,
          projectId,
          roleId: `role-${key}`,
          name: `${key} agent`,
          enabled: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      for (const agent of agents) await runtime.saveAgent(agent);
      database
        .prepare(
          `INSERT INTO resources(
           id, project_id, type, provider, external_ref, display_name,
           configuration_json, credential_ref, status, created_at, updated_at
         ) VALUES ('resource', ?, 'filesystem_scope', 'fake', NULL,
           'Fake resource', '{}', NULL, 'active', ?, ?)`,
        )
        .run(projectId, timestamp.toISOString(), timestamp.toISOString());
      for (const key of ["architect", "developer", "reviewer", "qa"])
        database
          .prepare(
            `INSERT INTO capability_grants(
             id, project_id, principal_type, principal_id, resource_id,
             actions_json, constraints_json, valid_from, expires_at, revoked_at,
             granted_by, reason, created_at
           ) VALUES (?, ?, 'role', ?, 'resource', ?, ?, ?, NULL, NULL,
             'operator', 'E2E base authority', ?)`,
          )
          .run(
            `grant-${key}`,
            projectId,
            `role-${key}`,
            JSON.stringify(["fake.read", "fake.write", "fake.delete"]),
            JSON.stringify({ allowMutation: true }),
            timestamp.toISOString(),
            timestamp.toISOString(),
          );
      database.close();
      const started = await command([
        "pipeline:start",
        "--project",
        projectId,
        "--task",
        taskId,
        "--pipeline",
        "delivery",
        "--actor",
        "operator",
      ]);
      expect(started.exitCode).toBe(0);
      const runId = (JSON.parse(started.stdout[0]!) as { id: string }).id;
      const createAgentRun = async (
        agentId: string,
        actionIntent?: {
          resourceId: string;
          operation: string;
          arguments: Readonly<Record<string, unknown>>;
        },
      ) => {
        const run = AgentRun.create({
          id: crypto.randomUUID(),
          projectId,
          taskId,
          agentId,
          pipelineRunId: runId,
          ...(actionIntent === undefined ? {} : { actionIntent }),
          now: new Date(),
        });
        run.transition("preparing", timestamp);
        run.transition("running", timestamp);
        const agentDatabase = openDatabase(
          join(root, ".ai-office", "project.sqlite"),
        );
        await new SqliteAgentRuntimeRepository(agentDatabase).saveRun(run);
        agentDatabase.close();
        return run.snapshot().id;
      };

      const assign = (agent: string) =>
        command([
          "pipeline:assign",
          "--project",
          projectId,
          "--run",
          runId,
          "--agent",
          agent,
          "--actor",
          "operator",
        ]);
      const complete = async (agent: string) => {
        const agentRunId = await createAgentRun(agent);
        return command([
          "pipeline:transition",
          "--project",
          projectId,
          "--run",
          runId,
          "--event",
          "complete",
          "--agent-run",
          agentRunId,
        ]);
      };
      await assign("architect-agent");
      await complete("architect-agent");
      await assign("developer-agent");

      const earlyMerge = await command([
        "action:request",
        "--project",
        projectId,
        "--agent-run",
        await createAgentRun("developer-agent", {
          resourceId: "resource",
          operation: "fake.delete",
          arguments: { target: "main" },
        }),
      ]);
      expect(earlyMerge.exitCode).toBe(2);
      expect(earlyMerge.stdout.join("\n")).toContain(
        "pipeline_prerequisite_incomplete",
      );

      await complete("developer-agent");
      const selfReview = await assign("developer-agent");
      expect(selfReview.exitCode).toBe(1);
      expect(selfReview.stderr.join("\n")).toContain("requires role reviewer");
      await assign("reviewer-agent");
      const reviewerWrite = await command([
        "action:request",
        "--project",
        projectId,
        "--agent-run",
        await createAgentRun("reviewer-agent", {
          resourceId: "resource",
          operation: "fake.write",
          arguments: { target: "change" },
        }),
      ]);
      expect(reviewerWrite.exitCode).toBe(2);
      expect(reviewerWrite.stdout.join("\n")).toContain(
        "pipeline_capability_denied",
      );
      const pendingAgentRun = await createAgentRun("reviewer-agent", {
        resourceId: "resource",
        operation: "fake.read",
        arguments: {},
      });
      await complete("reviewer-agent");
      const pending = await command([
        "action:request",
        "--project",
        projectId,
        "--agent-run",
        pendingAgentRun,
      ]);
      expect(pending.exitCode).toBe(2);
      expect(pending.stdout.join("\n")).toContain("pipeline_approval_required");
      expect(
        (
          await command([
            "pipeline:transition",
            "--project",
            projectId,
            "--run",
            runId,
            "--event",
            "approve",
            "--actor",
            "operator",
            "--rationale",
            "Independent review accepted",
          ])
        ).exitCode,
      ).toBe(0);
      await assign("qa-agent");
      await complete("qa-agent");
      await assign("developer-agent");
      const merge = await command([
        "action:request",
        "--project",
        projectId,
        "--agent-run",
        await createAgentRun("developer-agent", {
          resourceId: "resource",
          operation: "fake.delete",
          arguments: { target: "main" },
        }),
      ]);
      expect(merge.exitCode, JSON.stringify(merge)).toBe(0);
      expect(merge.stdout.join("\n")).toContain("approval_required");
      await complete("developer-agent");

      const status = await command([
        "pipeline:status",
        "--project",
        projectId,
        "--run",
        runId,
      ]);
      expect(JSON.parse(status.stdout[0]!) as { status: string }).toMatchObject(
        { status: "completed" },
      );
      const auditDatabase = openDatabase(
        join(root, ".ai-office", "project.sqlite"),
      );
      expect(
        auditDatabase
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM audit_event WHERE event_type = 'pipeline.action_denied'",
          )
          .get()?.count,
      ).toBeGreaterThanOrEqual(3);
      expect(
        auditDatabase
          .query<{ status: string }, [string]>(
            "SELECT status FROM task WHERE id = ?",
          )
          .get(taskId)?.status,
      ).toBe("completed");
      auditDatabase.close();
    } finally {
      controller.abort();
      await running;
    }
  });
});

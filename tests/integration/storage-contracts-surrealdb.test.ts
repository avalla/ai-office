import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { connectSurrealProjectStorageSubsetHarness, type SurrealProjectStorageSubsetHarness } from "../../packages/storage-surrealdb/src/project-storage/test-support.ts";
import { defineProjectStorageContracts } from "../contracts/project-storage.contract.ts";

const endpoint = process.env.AI_OFFICE_TEST_SURREALDB_URL;
const tenantId = "contract-tenant";

describe.skipIf(endpoint === undefined)("SurrealDB ProjectStorage subset contracts", () => {
  defineProjectStorageContracts(async () => {
    const harness = await openHarness(tenantId);
    return {
      projects: harness.experiment.projects,
      tasks: harness.experiment.tasks,
      taskRequirements: harness.experiment.taskRequirements,
      transactions: harness.experiment.transactions,
      seedRequirement: async (input: {
        id: string;
        projectId: string;
        key: string;
        title: string;
        status: RequirementStatus;
      }) => harness.seedRequirement({ ...input, tenantId }),
      close: harness.close,
    };
  });

  let harness: SurrealProjectStorageSubsetHarness;
  let databaseName: string;

  beforeEach(async () => {
    databaseName = `subset_${randomUUID().replaceAll("-", "")}`;
    harness = await openHarness(tenantId, databaseName);
  });

  afterEach(async () => {
    await harness.close();
  });

  test("scopes reads and conflicting writes to the trusted tenant context", async () => {
    const otherTenant = await openHarness("other-tenant", databaseName);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const project = Project.create({ id: "tenant-project", name: "Owner", now });
    const task = Task.create({
      id: "tenant-task",
      projectId: project.snapshot().id,
      title: "Owner task",
      now,
    });

    try {
      await harness.experiment.projects.save(project);
      await harness.experiment.tasks.save(task);

      expect(await otherTenant.experiment.projects.findById("tenant-project")).toBeNull();
      expect(await otherTenant.experiment.tasks.findById("tenant-task")).toBeNull();
      expect(await otherTenant.experiment.tasks.listByProject("tenant-project")).toEqual([]);
      await harness.seedRequirement({
        id: "tenant-requirement",
        tenantId,
        projectId: "tenant-project",
        key: "TENANT-001",
        title: "Tenant requirement",
        status: "accepted",
      });
      expect(
        await harness.experiment.taskRequirements.link({
          projectId: "tenant-project",
          taskId: "tenant-task",
          requirementId: "tenant-requirement",
          now,
        }),
      ).toBe(true);
      expect(
        await otherTenant.experiment.taskRequirements.link({
          projectId: "tenant-project",
          taskId: "tenant-task",
          requirementId: "tenant-requirement",
          now,
        }),
      ).toBe(false);
      expect(
        await otherTenant.experiment.taskRequirements.listForTask(
          "tenant-project",
          "tenant-task",
        ),
      ).toEqual([]);
      expect(
        await otherTenant.experiment.taskRequirements.unlink({
          projectId: "tenant-project",
          taskId: "tenant-task",
          requirementId: "tenant-requirement",
        }),
      ).toBe(false);
      await expect(
        otherTenant.experiment.projects.save(
          Project.create({ id: "tenant-project", name: "Attacker", now }),
        ),
      ).rejects.toThrow();
      await expect(
        otherTenant.experiment.tasks.save(
          Task.create({
            id: "tenant-task",
            projectId: "tenant-project",
            title: "Attacker task",
            now,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        otherTenant.experiment.tasks.save(
          Task.create({
            id: "cross-tenant-new-task",
            projectId: "tenant-project",
            title: "Wrong owner",
            now,
          }),
        ),
      ).rejects.toThrow();
      expect(await otherTenant.experiment.tasks.findById("cross-tenant-new-task")).toBeNull();
      expect((await harness.experiment.projects.findById("tenant-project"))?.snapshot().name).toBe("Owner");
      expect((await harness.experiment.tasks.findById("tenant-task"))?.snapshot().title).toBe("Owner task");
    } finally {
      await otherTenant.close();
    }
  });
  test("rejected relation writes preserve valid links", async () => {
    const now = new Date("2026-06-06T00:00:00.000Z");
    for (const id of ["failure-project-a", "failure-project-b"]) {
      await harness.experiment.projects.save(Project.create({ id, name: id, now }));
    }
    const projectTasks: [string, string][] = [
      ["failure-task-a", "failure-project-a"],
      ["failure-task-b", "failure-project-b"],
    ];
    for (const [id, projectId] of projectTasks) {
      await harness.experiment.tasks.save(
        Task.create({ id, projectId, title: id, now }),
      );
    }
    await harness.seedRequirement({
      id: "failure-requirement-a",
      tenantId,
      projectId: "failure-project-a",
      key: "FAIL-A",
      title: "A",
      status: "accepted",
    });
    await harness.seedRequirement({
      id: "failure-requirement-b",
      tenantId,
      projectId: "failure-project-b",
      key: "FAIL-B",
      title: "B",
      status: "accepted",
    });
    await expect(
      harness.experiment.taskRequirements.link({
        projectId: "failure-project-a",
        taskId: "failure-task-a",
        requirementId: "failure-requirement-a",
        now,
      }),
    ).resolves.toBe(true);
    await expect(
      harness.experiment.taskRequirements.link({
        projectId: "failure-project-a",
        taskId: "failure-task-a",
        requirementId: "failure-requirement-b",
        now,
      }),
    ).resolves.toBe(false);
    await expect(
      harness.experiment.taskRequirements.link({
        projectId: "failure-project-a",
        taskId: "failure-task-a",
        requirementId: "failure-missing-requirement",
        now,
      }),
    ).resolves.toBe(false);
    await expect(
      harness.experiment.taskRequirements.listByProject("failure-project-a"),
    ).resolves.toMatchObject([
      { taskId: "failure-task-a", requirementId: "failure-requirement-a" },
    ]);
  });


  test("rejects a missing task project and leaves no task behind", async () => {
    const task = Task.create({
      id: "missing-parent-task",
      projectId: "missing-parent-project",
      title: "Orphan",
      now: new Date("2026-06-02T00:00:00.000Z"),
    });
    await expect(harness.experiment.tasks.save(task)).rejects.toThrow();
    expect(await harness.experiment.tasks.findById(task.snapshot().id)).toBeNull();
  });

  test("database relation records project/task ownership", async () => {
    const project = Project.create({
      id: "referenced-project",
      name: "Referenced",
      now: new Date("2026-06-03T00:00:00.000Z"),
    });
    await harness.experiment.projects.save(project);
    await harness.experiment.tasks.save(
      Task.create({
        id: "referencing-task",
        projectId: project.snapshot().id,
        title: "Task",
        now: new Date("2026-06-03T00:00:00.000Z"),
      }),
    );
    await expect(
      harness.projectOwnsTask("referenced-project", "referencing-task"),
    ).resolves.toBe(true);
    expect((await harness.experiment.tasks.findById("referencing-task"))?.snapshot().projectId).toBe("referenced-project");
  });

  test("typed relation rejects missing endpoints at the database boundary", async () => {
    await expect(
      harness.createRelationWithMissingEndpoints("absent-task", "absent-requirement"),
    ).rejects.toThrow();
  });

  test("task lifecycle rejects an invalid transition without changing stored state", async () => {
    const now = new Date("2026-06-04T00:00:00.000Z");
    const task = Task.create({ id: "terminal-task", projectId: "terminal-project", title: "Terminal", now });
    await harness.experiment.projects.save(
      Project.create({ id: "terminal-project", name: "Terminal project", now }),
    );
    task.start(now);
    task.complete(now);
    await harness.experiment.tasks.save(task);
    expect(() => task.start(new Date("2026-06-05T00:00:00.000Z"))).toThrow();
    expect((await harness.experiment.tasks.findById("terminal-task"))?.snapshot().status).toBe("completed");
  });

  test("subset composition names only implemented capabilities", () => {
    expect(harness.experiment.capabilities).toEqual([
      "projects",
      "tasks",
      "taskRequirements",
      "transactions",
    ]);
    expect(harness.experiment.experiment).toBe("surrealdb-project-storage-subset");
  });
});

async function openHarness(
  scopedTenantId: string,
  database = `subset_${randomUUID().replaceAll("-", "")}`,
): Promise<SurrealProjectStorageSubsetHarness> {
  if (endpoint === undefined) throw new Error("SurrealDB test endpoint is required");
  return connectSurrealProjectStorageSubsetHarness({
    endpoint,
    namespace: "ai_office_tests",
    database,
    tenantId: scopedTenantId,
  });
}

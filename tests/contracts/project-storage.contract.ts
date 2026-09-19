import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type {
  LinkedRequirement,
  TaskRequirementRepository,
} from "@ai-office/application/ports/task-requirement-repository.port.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import {
  TransactionAlreadyActiveError,
  type TransactionRunner,
} from "@ai-office/application/ports/transaction-runner.port.ts";
import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";

export interface RepositoryContractHarness {
  projects: ProjectRepository;
  tasks: TaskRepository;
  taskRequirements: TaskRequirementRepository;
  transactions: TransactionRunner;
  seedRequirement(input: {
    id: string;
    projectId: string;
    key: string;
    title: string;
    status: RequirementStatus;
  }): Promise<void>;
  close(): Promise<void>;
}

export function defineProjectStorageContracts(
  createHarness: () => Promise<RepositoryContractHarness>,
): void {
  let harness: RepositoryContractHarness;
  let prefix: string;

  beforeEach(async () => {
    harness = await createHarness();
    prefix = `contract-${randomUUID()}`;
  });

  afterEach(async () => {
    await harness.close();
  });

  describe("ProjectRepository", () => {
    test("returns null when a project is missing", async () => {
      expect(await harness.projects.findById(`${prefix}-missing`)).toBeNull();
    });

    test("round-trips optional descriptions and preserves createdAt on update", async () => {
      const createdAt = new Date("2026-01-02T03:04:05.000Z");
      const updatedAt = new Date("2026-01-03T03:04:05.000Z");
      const project = Project.create({
        id: `${prefix}-project`,
        name: "Original",
        description: "First description",
        now: createdAt,
      });
      await harness.projects.save(project);
      expect(
        (await harness.projects.findById(project.snapshot().id))?.snapshot(),
      ).toEqual(project.snapshot());

      const update = Project.restore({
        ...project.snapshot(),
        name: "Updated",
        description: "Second description",
        updatedAt,
      });
      await harness.projects.save(update);
      expect(
        (await harness.projects.findById(update.snapshot().id))?.snapshot(),
      ).toEqual(update.snapshot());
      expect(
        (await harness.projects.findById(update.snapshot().id))?.snapshot()
          .createdAt,
      ).toEqual(createdAt);
    });

    test("round-trips an omitted description as undefined", async () => {
      const project = Project.create({
        id: `${prefix}-no-description`,
        name: "No description",
        now: new Date("2026-01-02T03:04:05.000Z"),
      });
      await harness.projects.save(project);
      expect(
        (await harness.projects.findById(project.snapshot().id))?.snapshot()
          .description,
      ).toBeUndefined();
    });
  });

  describe("TaskRepository", () => {
    test("returns null when a task is missing", async () => {
      expect(await harness.tasks.findById(`${prefix}-missing`)).toBeNull();
    });

    test("round-trips status and nullable description and updates existing tasks", async () => {
      const project = await createProject(harness, `${prefix}-task-project`);
      const createdAt = new Date("2026-02-02T03:04:05.000Z");
      const updatedAt = new Date("2026-02-03T03:04:05.000Z");
      const task = Task.create({
        id: `${prefix}-task`,
        projectId: project.snapshot().id,
        title: "Original task",
        now: createdAt,
      });
      await harness.tasks.save(task);
      expect(
        (await harness.tasks.findById(task.snapshot().id))?.snapshot(),
      ).toEqual(task.snapshot());

      const update = Task.restore({
        ...task.snapshot(),
        title: "Updated task",
        description: "Now described",
        status: "running",
        updatedAt,
      });
      await harness.tasks.save(update);
      const restored = await harness.tasks.findById(update.snapshot().id);
      expect(restored?.snapshot()).toEqual(update.snapshot());
      expect(restored?.snapshot().createdAt).toEqual(createdAt);
    });

    test("preserves immutable project ownership on update", async () => {
      const project = await createProject(harness, `${prefix}-owner-project`);
      const otherProject = await createProject(
        harness,
        `${prefix}-other-owner-project`,
      );
      const task = Task.create({
        id: `${prefix}-owned-task`,
        projectId: project.snapshot().id,
        title: "Owned task",
        now: new Date("2026-02-02T03:04:05.000Z"),
      });
      await harness.tasks.save(task);

      await harness.tasks.save(
        Task.restore({
          ...task.snapshot(),
          projectId: otherProject.snapshot().id,
          title: "Updated owned task",
          updatedAt: new Date("2026-02-03T03:04:05.000Z"),
        }),
      );

      expect(
        (await harness.tasks.findById(task.snapshot().id))?.snapshot(),
      ).toMatchObject({
        id: task.snapshot().id,
        projectId: project.snapshot().id,
        title: "Updated owned task",
      });
    });

    test("lists only the requested project in exact priority/time/id order", async () => {
      const project = await createProject(harness, `${prefix}-list-project`);
      const otherProject = await createProject(
        harness,
        `${prefix}-other-project`,
      );
      const tasks = [
        Task.create({
          id: `${prefix}-low`,
          projectId: project.snapshot().id,
          title: "Low",
          priority: 1,
          now: new Date("2026-02-02T00:00:03.000Z"),
        }),
        Task.create({
          id: `${prefix}-high-b`,
          projectId: project.snapshot().id,
          title: "High B",
          priority: 5,
          now: new Date("2026-02-02T00:00:02.000Z"),
        }),
        Task.create({
          id: `${prefix}-high-a`,
          projectId: project.snapshot().id,
          title: "High A",
          priority: 5,
          now: new Date("2026-02-02T00:00:02.000Z"),
        }),
        Task.create({
          id: `${prefix}-other`,
          projectId: otherProject.snapshot().id,
          title: "Other",
          priority: 100,
          now: new Date("2026-02-02T00:00:00.000Z"),
        }),
      ];
      for (const task of tasks) await harness.tasks.save(task);

      expect(
        (await harness.tasks.listByProject(project.snapshot().id)).map(
          (task) => task.snapshot().id,
        ),
      ).toEqual([`${prefix}-high-a`, `${prefix}-high-b`, `${prefix}-low`]);
    });
  });

  describe("TaskRequirementRepository", () => {
    test("preserves linking, isolation, idempotency, ordering, and unlink semantics", async () => {
      const project = await createProject(harness, `${prefix}-link-project`);
      const otherProject = await createProject(harness, `${prefix}-link-other`);
      const taskA = await createTask(
        harness,
        project.snapshot().id,
        `${prefix}-task-a`,
      );
      const taskB = await createTask(
        harness,
        project.snapshot().id,
        `${prefix}-task-b`,
      );
      const otherTask = await createTask(
        harness,
        otherProject.snapshot().id,
        `${prefix}-other-task`,
      );
      await harness.seedRequirement({
        id: `${prefix}-requirement-a`,
        projectId: project.snapshot().id,
        key: "A-001",
        title: "A",
        status: "accepted",
      });
      await harness.seedRequirement({
        id: `${prefix}-requirement-z`,
        projectId: project.snapshot().id,
        key: "Z-001",
        title: "Z",
        status: "verified",
      });
      await harness.seedRequirement({
        id: `${prefix}-other-requirement`,
        projectId: otherProject.snapshot().id,
        key: "OTHER-001",
        title: "Other",
        status: "proposed",
      });
      const now = new Date("2026-03-02T03:04:05.000Z");

      expect(
        await harness.taskRequirements.link({
          projectId: project.snapshot().id,
          taskId: taskB,
          requirementId: `${prefix}-requirement-z`,
          now,
        }),
      ).toBe(true);
      expect(
        await harness.taskRequirements.link({
          projectId: project.snapshot().id,
          taskId: taskB,
          requirementId: `${prefix}-requirement-z`,
          now,
        }),
      ).toBe(false);
      expect(
        await harness.taskRequirements.link({
          projectId: project.snapshot().id,
          taskId: taskB,
          requirementId: `${prefix}-requirement-a`,
          now,
        }),
      ).toBe(true);
      expect(
        await harness.taskRequirements.link({
          projectId: project.snapshot().id,
          taskId: taskA,
          requirementId: `${prefix}-requirement-a`,
          now,
        }),
      ).toBe(true);

      expect(
        (
          await harness.taskRequirements.listForTask(
            project.snapshot().id,
            taskB,
          )
        ).map(requirementKey),
      ).toEqual(["A-001", "Z-001"]);
      expect(
        [
          ...(
            await harness.taskRequirements.listForTasks(project.snapshot().id, [
              taskB,
              taskA,
              otherTask,
            ])
          ).entries(),
        ].map(([taskId, requirements]) => [
          taskId,
          requirements.map(requirementKey),
        ]),
      ).toEqual([
        [taskA, ["A-001"]],
        [taskB, ["A-001", "Z-001"]],
      ]);
      expect(
        (
          await harness.taskRequirements.listByProject(project.snapshot().id)
        ).map((link) => [link.taskId, link.requirementId]),
      ).toEqual([
        [taskA, `${prefix}-requirement-a`],
        [taskB, `${prefix}-requirement-a`],
        [taskB, `${prefix}-requirement-z`],
      ]);

      expect(
        await harness.taskRequirements.link({
          projectId: project.snapshot().id,
          taskId: taskA,
          requirementId: `${prefix}-other-requirement`,
          now,
        }),
      ).toBe(false);
      expect(
        await harness.taskRequirements.link({
          projectId: project.snapshot().id,
          taskId: otherTask,
          requirementId: `${prefix}-requirement-a`,
          now,
        }),
      ).toBe(false);
      expect(
        await harness.taskRequirements.link({
          projectId: project.snapshot().id,
          taskId: taskA,
          requirementId: `${prefix}-missing-requirement`,
          now,
        }),
      ).toBe(false);

      expect(
        await harness.taskRequirements.unlink({
          projectId: project.snapshot().id,
          taskId: taskB,
          requirementId: `${prefix}-requirement-z`,
        }),
      ).toBe(true);
      expect(
        await harness.taskRequirements.unlink({
          projectId: project.snapshot().id,
          taskId: taskB,
          requirementId: `${prefix}-requirement-z`,
        }),
      ).toBe(false);
    });
  });

  describe("TransactionRunner", () => {
    test("commits writes from multiple repositories on success", async () => {
      const projectId = `${prefix}-commit-project`;
      const taskId = `${prefix}-commit-task`;
      await harness.transactions.run(async () => {
        await harness.projects.save(
          Project.create({
            id: projectId,
            name: "Committed",
            now: new Date("2026-04-02T03:04:05.000Z"),
          }),
        );
        await harness.tasks.save(
          Task.create({
            id: taskId,
            projectId,
            title: "Committed task",
            now: new Date("2026-04-02T03:04:05.000Z"),
          }),
        );
      });
      expect(await harness.projects.findById(projectId)).not.toBeNull();
      expect(await harness.tasks.findById(taskId)).not.toBeNull();
    });

    test("rolls back writes from multiple repositories on failure", async () => {
      const projectId = `${prefix}-rollback-project`;
      const taskId = `${prefix}-rollback-task`;
      await expect(
        harness.transactions.run(async () => {
          await harness.projects.save(
            Project.create({
              id: projectId,
              name: "Rolled back",
              now: new Date("2026-04-02T03:04:05.000Z"),
            }),
          );
          await harness.tasks.save(
            Task.create({
              id: taskId,
              projectId,
              title: "Rolled back task",
              now: new Date("2026-04-02T03:04:05.000Z"),
            }),
          );
          throw new Error("rollback contract failure");
        }),
      ).rejects.toThrow("rollback contract failure");
      expect(await harness.projects.findById(projectId)).toBeNull();
      expect(await harness.tasks.findById(taskId)).toBeNull();
    });

    test("rejects nested transactions", async () => {
      await expect(
        harness.transactions.run(() =>
          harness.transactions.run(async () => undefined),
        ),
      ).rejects.toBeInstanceOf(TransactionAlreadyActiveError);
    });
  });
}

async function createProject(
  harness: RepositoryContractHarness,
  id: string,
): Promise<Project> {
  const project = Project.create({
    id,
    name: id,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  await harness.projects.save(project);
  return project;
}

async function createTask(
  harness: RepositoryContractHarness,
  projectId: string,
  id: string,
): Promise<string> {
  await harness.tasks.save(
    Task.create({
      id,
      projectId,
      title: id,
      now: new Date("2026-02-01T00:00:00.000Z"),
    }),
  );
  return id;
}

function requirementKey(value: LinkedRequirement): string {
  return value.key;
}

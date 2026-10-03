import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { ProjectDefinitionRepository } from "@ai-office/application/ports/project-definition-repository.port.ts";
import {
  StaleProjectDefinitionError,
  type ProjectOwnedDefinition,
} from "@ai-office/application/domain-pack/project-definition.ts";
import {
  StaleProjectPackBindingError,
  type ProjectPackBindingRepository,
} from "@ai-office/application/ports/project-pack-binding-repository.port.ts";
import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type {
  LinkedRequirement,
  TaskRequirementRepository,
} from "@ai-office/application/ports/task-requirement-repository.port.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import type { TaskDependencyRepository } from "@ai-office/application/ports/task-dependency-repository.port.ts";
import {
  TransactionAlreadyActiveError,
  type TransactionRunner,
} from "@ai-office/application/ports/transaction-runner.port.ts";
import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import {
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
} from "../../packages/domain-pack-contracts/src/index.ts";

export interface RepositoryContractHarness {
  projects: ProjectRepository;
  packBindings?: ProjectPackBindingRepository;
  definitions?: ProjectDefinitionRepository;
  deleteProject?: (projectId: string) => Promise<void>;
  bindingRowCounts?: (
    projectId: string,
  ) => Promise<{ heads: number; packs: number }>;
  definitionRowCounts?: (
    projectId: string,
  ) => Promise<{ heads: number; owned: number; overrides: number }>;
  tasks: TaskRepository;
  taskRequirements: TaskRequirementRepository;
  taskDependencies?: TaskDependencyRepository;
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
  features: { packBindings?: boolean; definitions?: boolean } = {},
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

  if (features.packBindings)
    describe("ProjectPackBindingRepository", () => {
      const bindings = () => {
        if (!harness.packBindings)
          throw new Error(
            "Pack binding repository is required for this contract",
          );
        return harness.packBindings;
      };
      const now = new Date("2026-10-02T00:00:00.000Z");
      const first: PackIdentity = {
        id: parseDomainPackId("org.example.first"),
        version: parseDomainPackVersion("1.0.0"),
        manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
      };
      const second: PackIdentity = {
        id: parseDomainPackId("org.example.second"),
        version: parseDomainPackVersion("2.0.0"),
        manifestDigest: parseManifestDigest(`sha256:${"b".repeat(64)}`),
      };

      test("starts empty, persists exact tuples, and increments only for changes", async () => {
        const projectId = (
          await createProject(harness, `${prefix}-packs`)
        ).snapshot().id;
        expect(await bindings().get(projectId)).toEqual({
          projectId,
          configurationRevision: 0,
          packs: [],
        });
        const applied = await bindings().replace(
          projectId,
          0,
          [second, first],
          now,
        );
        expect(applied).toEqual({
          changed: true,
          binding: {
            projectId,
            configurationRevision: 1,
            packs: [first, second],
          },
        });
        expect(await bindings().get(projectId)).toEqual(applied.binding);
        expect(
          await bindings().replace(projectId, 1, [first, second], now),
        ).toEqual({ changed: false, binding: applied.binding });
        await expect(
          bindings().replace(projectId, 0, [], now),
        ).rejects.toBeInstanceOf(StaleProjectPackBindingError);
        expect(
          (await bindings().replace(projectId, 1, [], now)).binding,
        ).toEqual({ projectId, configurationRevision: 2, packs: [] });
      });

      test("isolates projects and rolls back replacement", async () => {
        const projectId = (
          await createProject(harness, `${prefix}-a`)
        ).snapshot().id;
        const otherId = (await createProject(harness, `${prefix}-b`)).snapshot()
          .id;
        await bindings().replace(projectId, 0, [first], now);
        expect(await bindings().get(otherId)).toEqual({
          projectId: otherId,
          configurationRevision: 0,
          packs: [],
        });
        await expect(
          harness.transactions.run(async () => {
            await bindings().replace(projectId, 1, [second], now);
            throw new Error("rollback binding");
          }),
        ).rejects.toThrow("rollback binding");
        expect((await bindings().get(projectId)).packs).toEqual([first]);
        expect((await bindings().get(projectId)).configurationRevision).toBe(1);
      });

      test("rejects two active versions of the same pack ID without changing revision", async () => {
        const projectId = (
          await createProject(harness, `${prefix}-unique`)
        ).snapshot().id;
        await expect(
          bindings().replace(
            projectId,
            0,
            [first, { ...first, version: parseDomainPackVersion("2.0.0") }],
            now,
          ),
        ).rejects.toThrow();
        expect(await bindings().get(projectId)).toEqual({
          projectId,
          configurationRevision: 0,
          packs: [],
        });
      });

      test("deleting a project cascades its binding head and exact tuples", async () => {
        if (!harness.deleteProject || !harness.bindingRowCounts)
          throw new Error("Pack binding cascade probes are required");
        const projectId = (
          await createProject(harness, `${prefix}-cascade`)
        ).snapshot().id;
        await bindings().replace(projectId, 0, [first, second], now);
        await harness.deleteProject(projectId);
        expect(await harness.projects.findById(projectId)).toBeNull();
        expect(await bindings().get(projectId)).toEqual({
          projectId,
          configurationRevision: 0,
          packs: [],
        });
        expect(await harness.bindingRowCounts(projectId)).toEqual({
          heads: 0,
          packs: 0,
        });
      });
    });

  if (features.definitions)
    describe("ProjectDefinitionRepository", () => {
      const definitions = () => {
        if (!harness.definitions)
          throw new Error("Definition repository is required");
        return harness.definitions;
      };
      const now = new Date("2026-10-03T00:00:00.000Z");
      const owned: ProjectOwnedDefinition = {
        origin: "project_owned",
        kind: "roles",
        id: "custom",
        revision: 1,
        enabled: true,
        payload: { id: "custom", title: "Custom" },
        actorId: "operator",
        changedAt: now.toISOString(),
      };
      test("round-trips project authority, isolates projects, and rejects stale revisions", async () => {
        const first = (
          await createProject(harness, `${prefix}-definitions-a`)
        ).snapshot().id;
        const second = (
          await createProject(harness, `${prefix}-definitions-b`)
        ).snapshot().id;
        expect(await definitions().get(first)).toEqual({
          projectId: first,
          revision: 0,
          owned: [],
          overrides: [],
        });
        const result = await definitions().replace(
          { projectId: first, revision: 0, owned: [owned], overrides: [] },
          0,
          now,
        );
        expect(result.revision).toBe(1);
        expect(await definitions().get(first)).toEqual(result);
        expect(await definitions().get(second)).toEqual({
          projectId: second,
          revision: 0,
          owned: [],
          overrides: [],
        });
        await expect(
          definitions().replace({ ...result, owned: [] }, 0, now),
        ).rejects.toBeInstanceOf(StaleProjectDefinitionError);
        expect(await definitions().get(first)).toEqual(result);
      });
      test("rolls back definition mutations with the caller transaction", async () => {
        const projectId = (
          await createProject(harness, `${prefix}-definitions-rollback`)
        ).snapshot().id;
        await expect(
          harness.transactions.run(async () => {
            await definitions().replace(
              { projectId, revision: 0, owned: [owned], overrides: [] },
              0,
              now,
            );
            throw new Error("rollback definitions");
          }),
        ).rejects.toThrow("rollback definitions");
        expect(await definitions().get(projectId)).toEqual({
          projectId,
          revision: 0,
          owned: [],
          overrides: [],
        });
      });
      test("round-trips exact override identity and rejects duplicate source targets atomically", async () => {
        const projectId = (
          await createProject(harness, `${prefix}-definition-source`)
        ).snapshot().id;
        const override = {
          origin: "project_override" as const,
          source: {
            id: parseDomainPackId("org.example.legal"),
            version: parseDomainPackVersion("1.0.0"),
            manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
            kind: "roles" as const,
            localId: "counsel",
          },
          operation: "replace" as const,
          revision: 1,
          payload: { id: "counsel", title: "Counsel" },
          actorId: "operator",
          changedAt: now.toISOString(),
        };
        const current = await definitions().replace(
          { projectId, revision: 0, owned: [], overrides: [override] },
          0,
          now,
        );
        expect(await definitions().get(projectId)).toEqual(current);
        await expect(
          definitions().replace(
            {
              projectId,
              revision: 1,
              owned: [],
              overrides: [override, override],
            },
            1,
            now,
          ),
        ).rejects.toThrow();
        expect(await definitions().get(projectId)).toEqual(current);
      });

      test("creates, updates and removes ordered owned and exact-source entries", async () => {
        const projectId = (
          await createProject(harness, `${prefix}-definition-lifecycle`)
        ).snapshot().id;
        const source = {
          id: parseDomainPackId("org.example.legal"),
          version: parseDomainPackVersion("1.0.0"),
          manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
          kind: "roles" as const,
          localId: "counsel",
        };
        const override = {
          origin: "project_override" as const,
          source,
          operation: "replace" as const,
          revision: 1,
          payload: { id: "counsel", title: "Counsel" },
          actorId: "operator",
          changedAt: now.toISOString(),
        };
        const created = await definitions().replace(
          {
            projectId,
            revision: 0,
            owned: [
              { ...owned, id: "z", payload: { id: "z" } },
              { ...owned, id: "a", payload: { id: "a" } },
            ],
            overrides: [
              { ...override, source: { ...source, kind: "agents" as const } },
              override,
            ],
          },
          0,
          now,
        );
        expect(created.revision).toBe(1);
        expect(
          (await definitions().get(projectId)).owned.map((item) => item.id),
        ).toEqual(["a", "z"]);
        expect(
          (await definitions().get(projectId)).overrides.map(
            (item) => item.source.kind,
          ),
        ).toEqual(["agents", "roles"]);
        const updated = await definitions().replace(
          {
            projectId,
            revision: 1,
            owned: [
              {
                ...owned,
                id: "a",
                revision: 2,
                payload: { id: "a", title: "Updated" },
              },
            ],
            overrides: [
              {
                ...override,
                revision: 2,
                operation: "extend",
                payload: { id: "counsel", description: "Added" },
              },
            ],
          },
          1,
          now,
        );
        expect(updated.revision).toBe(2);
        expect(await definitions().get(projectId)).toMatchObject({
          revision: 2,
          owned: [{ id: "a", revision: 2 }],
          overrides: [{ source, revision: 2, operation: "extend" }],
        });
        await expect(
          definitions().replace(
            { ...created, owned: [], overrides: [] },
            1,
            now,
          ),
        ).rejects.toBeInstanceOf(StaleProjectDefinitionError);
        expect(
          (
            await definitions().replace(
              { projectId, revision: 2, owned: [], overrides: [] },
              2,
              now,
            )
          ).revision,
        ).toBe(3);
        expect(await definitions().get(projectId)).toEqual({
          projectId,
          revision: 3,
          owned: [],
          overrides: [],
        });
      });

      test("rejects duplicate owned identities and cascades all definition rows on project deletion", async () => {
        if (!harness.deleteProject || !harness.definitionRowCounts)
          throw new Error("Definition cascade probes are required");
        const projectId = (
          await createProject(harness, `${prefix}-definition-cascade`)
        ).snapshot().id;
        const source = {
          id: parseDomainPackId("org.example.legal"),
          version: parseDomainPackVersion("1.0.0"),
          manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
          kind: "roles" as const,
          localId: "counsel",
        };
        const override = {
          origin: "project_override" as const,
          source,
          operation: "disable" as const,
          revision: 1,
          actorId: "operator",
          changedAt: now.toISOString(),
        };
        // Repository storage requires a valid kind/operation pair.
        const promptOverride = {
          ...override,
          source: { ...source, kind: "prompts" as const },
        };
        const current = await definitions().replace(
          {
            projectId,
            revision: 0,
            owned: [owned],
            overrides: [promptOverride],
          },
          0,
          now,
        );
        await expect(
          definitions().replace({ ...current, owned: [owned, owned] }, 1, now),
        ).rejects.toThrow();
        expect(await harness.definitionRowCounts(projectId)).toEqual({
          heads: 1,
          owned: 1,
          overrides: 1,
        });
        await harness.deleteProject(projectId);
        expect(await harness.definitionRowCounts(projectId)).toEqual({
          heads: 0,
          owned: 0,
          overrides: 0,
        });
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

  describe("TaskDependencyRepository", () => {
    test("round-trips project-scoped hard prerequisites without duplicates", async () => {
      const dependencies = harness.taskDependencies;
      if (dependencies === undefined) return; // Experimental partial storage has no planning graph.
      const project = await createProject(
        harness,
        `${prefix}-dependency-project`,
      );
      const other = await createProject(harness, `${prefix}-other-project`);
      const now = new Date("2026-02-02T03:04:05.000Z");
      const first = Task.create({
        id: `${prefix}-first`,
        projectId: project.snapshot().id,
        title: "First",
        now,
      });
      const second = Task.create({
        id: `${prefix}-second`,
        projectId: project.snapshot().id,
        title: "Second",
        now,
      });
      const foreign = Task.create({
        id: `${prefix}-foreign`,
        projectId: other.snapshot().id,
        title: "Foreign",
        now,
      });
      for (const task of [first, second, foreign])
        await harness.tasks.save(task);
      const edge = {
        projectId: project.snapshot().id,
        taskId: second.snapshot().id,
        dependsOnTaskId: first.snapshot().id,
        createdAt: now,
      };
      expect(await dependencies.link(edge)).toBe(true);
      expect(await dependencies.link(edge)).toBe(false);
      expect(await dependencies.listByProject(edge.projectId)).toEqual([edge]);
      await expect(
        dependencies.link({
          ...edge,
          taskId: first.snapshot().id,
          dependsOnTaskId: second.snapshot().id,
        }),
      ).rejects.toThrow("cycle");
      expect(
        await dependencies.link({
          ...edge,
          dependsOnTaskId: foreign.snapshot().id,
        }),
      ).toBe(false);
      expect(await dependencies.listByProject(other.snapshot().id)).toEqual([]);
      expect(
        await dependencies.unlink(
          edge.projectId,
          edge.taskId,
          edge.dependsOnTaskId,
        ),
      ).toBe(true);
      expect(
        await dependencies.unlink(
          edge.projectId,
          edge.taskId,
          edge.dependsOnTaskId,
        ),
      ).toBe(false);
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

import { describe, expect, test } from "vitest";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { TaskNotFoundError } from "@ai-office/application/commands/schedule-agent-run.ts";
import { UpdateTask } from "@ai-office/application/commands/update-task.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import type { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import { Project as ProjectAggregate } from "@ai-office/domain/project/project.ts";
import { Task as TaskAggregate } from "@ai-office/domain/task/task.ts";
import { CreateProject } from "@ai-office/application/commands/create-project.ts";
import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import type { RepositoryIdentityRepository } from "@ai-office/application/ports/repository-identity-repository.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { ListTasks } from "@ai-office/application/queries/list-tasks.ts";
import type { Project, ProjectId } from "@ai-office/domain/project/project.ts";
import type { Task, TaskId } from "@ai-office/domain/task/task.ts";

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-08-05T00:00:00.000Z");
  }
}

class SequenceIds implements IdGenerator {
  private next = 0;

  generate(): string {
    this.next += 1;
    return `id-${this.next}`;
  }
}

class InMemoryProjects implements ProjectRepository {
  readonly values = new Map<ProjectId, Project>();

  async findById(id: ProjectId): Promise<Project | null> {
    return this.values.get(id) ?? null;
  }

  async save(project: Project): Promise<void> {
    this.values.set(project.snapshot().id, project);
  }
}

class InMemoryTasks implements TaskRepository {
  readonly values = new Map<TaskId, Task>();

  async findById(id: TaskId): Promise<Task | null> {
    return this.values.get(id) ?? null;
  }

  async listByProject(projectId: ProjectId): Promise<Task[]> {
    return [...this.values.values()]
      .filter((task) => task.snapshot().projectId === projectId)
      .sort(
        (left, right) => right.snapshot().priority - left.snapshot().priority,
      );
  }

  async save(task: Task): Promise<void> {
    this.values.set(task.snapshot().id, task);
  }
}

class InMemoryIdentities implements RepositoryIdentityRepository {
  private readonly byRepository = new Map<string, string>();
  private readonly byProject = new Map<string, string>();

  async findProjectId(repositoryId: string): Promise<string | null> {
    return this.byRepository.get(repositoryId) ?? null;
  }

  async findRepositoryId(projectId: string): Promise<string | null> {
    return this.byProject.get(projectId) ?? null;
  }

  async associate(input: {
    repositoryId: string;
    projectId: string;
    createdAt: Date;
  }): Promise<"created" | "existing" | "conflict"> {
    const existingProject = this.byRepository.get(input.repositoryId);
    const existingRepository = this.byProject.get(input.projectId);
    if (
      existingProject === input.projectId &&
      existingRepository === input.repositoryId
    )
      return "existing";
    if (existingProject !== undefined || existingRepository !== undefined)
      return "conflict";
    this.byRepository.set(input.repositoryId, input.projectId);
    this.byProject.set(input.projectId, input.repositoryId);
    return "created";
  }
}

class InMemoryTransactions implements TransactionRunner {
  async run<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

describe("project and task use cases", () => {
  test("creates a project and tasks, then lists only that project's tasks", async () => {
    const projects = new InMemoryProjects();
    const tasks = new InMemoryTasks();
    const ids = new SequenceIds();
    const clock = new FixedClock();
    const identities = new InMemoryIdentities();
    const createProject = new CreateProject(
      projects,
      identities,
      ids,
      clock,
      new InMemoryTransactions(),
    );
    const createTask = new CreateTask(projects, tasks, ids, clock);

    const projectId = await createProject.execute({ name: "Demo" });
    await createTask.execute({ projectId, title: "Low", priority: 1 });
    const highId = await createTask.execute({
      projectId,
      title: "High",
      priority: 10,
    });

    const listed = await new ListTasks(tasks).execute(projectId);

    expect(projectId).toBe("id-1");
    expect(await identities.findRepositoryId(projectId)).toBe("repo_id-1");
    expect(listed.map((task) => task.id)).toEqual([highId, "id-2"]);
  });

  test("does not create a task for a missing project", async () => {
    const projects = new InMemoryProjects();
    const tasks = new InMemoryTasks();
    const createTask = new CreateTask(
      projects,
      tasks,
      new SequenceIds(),
      new FixedClock(),
    );

    await expect(
      createTask.execute({ projectId: "missing", title: "Task" }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(tasks.values.size).toBe(0);
  });
});

class RecordedAuditEvents implements AuditEventRepository {
  readonly values: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.values.push(event);
  }
}

describe("UpdateTask", () => {
  const created = new Date("2026-08-01T00:00:00.000Z");

  async function fixture() {
    const projects = new InMemoryProjects();
    const tasks = new InMemoryTasks();
    const events = new RecordedAuditEvents();
    await projects.save(
      ProjectAggregate.create({ id: "project-1", name: "Demo", now: created }),
    );
    await tasks.save(
      TaskAggregate.create({
        id: "task-1",
        projectId: "project-1",
        title: "Ship it",
        description: "Original",
        priority: 2,
        now: created,
      }),
    );
    const clock = new FixedClock();
    const service = new UpdateTask(
      projects,
      tasks,
      new RecordAuditEvent(events, new SequenceIds(), clock),
      clock,
      new InMemoryTransactions(),
    );
    const audit = () =>
      events.values.map((event) => {
        const value = event.snapshot();
        return {
          eventType: value.eventType,
          actorId: value.actorId,
          aggregateId: value.aggregateId,
          payload: value.payload,
        };
      });
    const stored = async () => {
      const task = await tasks.findById("task-1");
      if (task === null) throw new Error("task-1 disappeared");
      return task.snapshot();
    };
    return { service, audit, stored };
  }

  const target = { projectId: "project-1", taskId: "task-1", actorId: "op" };

  test("updates only the description and audits it exactly as before", async () => {
    const { service, audit, stored } = await fixture();

    const result = await service.execute({
      ...target,
      description: "Rewritten",
    });

    expect(result).toEqual({
      taskId: "task-1",
      description: "Rewritten",
      priority: 2,
      updatedAt: new FixedClock().now(),
    });
    expect(await stored()).toMatchObject({
      description: "Rewritten",
      priority: 2,
      status: "pending",
    });
    expect(audit()).toEqual([
      {
        eventType: "task.description_updated",
        actorId: "op",
        aggregateId: "task-1",
        payload: { descriptionUpdated: true },
      },
    ]);
  });

  test("updates only the priority and audits explicit before and after", async () => {
    const { service, audit, stored } = await fixture();

    await service.execute({ ...target, priority: -5 });

    expect(await stored()).toMatchObject({
      description: "Original",
      priority: -5,
      status: "pending",
      updatedAt: new FixedClock().now(),
    });
    expect(audit()).toEqual([
      {
        eventType: "task.priority_updated",
        actorId: "op",
        aggregateId: "task-1",
        payload: { from: 2, to: -5 },
      },
    ]);
  });

  test("records an unchanged priority like an unchanged description", async () => {
    const { service, audit } = await fixture();

    await service.execute({ ...target, priority: 2 });

    expect(audit()).toEqual([
      expect.objectContaining({
        eventType: "task.priority_updated",
        payload: { from: 2, to: 2 },
      }),
    ]);
  });

  test("applies description and priority together with one event each", async () => {
    const { service, audit, stored } = await fixture();

    const result = await service.execute({
      ...target,
      description: "Both",
      priority: 9,
    });

    expect(result).toMatchObject({ description: "Both", priority: 9 });
    expect(await stored()).toMatchObject({ description: "Both", priority: 9 });
    expect(
      audit().map(({ eventType, payload }) => ({ eventType, payload })),
    ).toEqual([
      {
        eventType: "task.description_updated",
        payload: { descriptionUpdated: true },
      },
      { eventType: "task.priority_updated", payload: { from: 2, to: 9 } },
    ]);
  });

  test("refuses an invalid priority before changing or auditing anything", async () => {
    const { service, audit, stored } = await fixture();
    const before = await stored();

    await expect(
      service.execute({ ...target, description: "Never", priority: 1.5 }),
    ).rejects.toBeInstanceOf(DomainValidationError);

    expect(await stored()).toEqual(before);
    expect(audit()).toEqual([]);
  });

  test("refuses a missing project or a task outside the project", async () => {
    const { service, audit } = await fixture();

    await expect(
      service.execute({ ...target, projectId: "missing", priority: 1 }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      service.execute({ ...target, taskId: "task-2", priority: 1 }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(audit()).toEqual([]);
  });
});

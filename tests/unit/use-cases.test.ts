import { describe, expect, test } from "vitest";
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

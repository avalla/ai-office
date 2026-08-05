import { describe, expect, test } from "vitest";
import { CreateProject } from "@ai-office/application/commands/create-project.ts";
import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
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
      .sort((left, right) => right.snapshot().priority - left.snapshot().priority);
  }

  async save(task: Task): Promise<void> {
    this.values.set(task.snapshot().id, task);
  }
}

describe("project and task use cases", () => {
  test("creates a project and tasks, then lists only that project's tasks", async () => {
    const projects = new InMemoryProjects();
    const tasks = new InMemoryTasks();
    const ids = new SequenceIds();
    const clock = new FixedClock();
    const createProject = new CreateProject(projects, ids, clock);
    const createTask = new CreateTask(projects, tasks, ids, clock);

    const projectId = await createProject.execute({ name: "Demo" });
    await createTask.execute({ projectId, title: "Low", priority: 1 });
    const highId = await createTask.execute({ projectId, title: "High", priority: 10 });

    const listed = await new ListTasks(tasks).execute(projectId);

    expect(projectId).toBe("id-1");
    expect(listed.map((task) => task.id)).toEqual([highId, "id-2"]);
  });

  test("does not create a task for a missing project", async () => {
    const projects = new InMemoryProjects();
    const tasks = new InMemoryTasks();
    const createTask = new CreateTask(projects, tasks, new SequenceIds(), new FixedClock());

    await expect(
      createTask.execute({ projectId: "missing", title: "Task" })
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(tasks.values.size).toBe(0);
  });
});

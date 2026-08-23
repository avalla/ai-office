import type { Clock } from "../ports/clock.port.ts";
import type {
  GlobalMemoryRepository,
  MemorySearchResult,
} from "../ports/global-memory-repository.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { MemoryReferenceRepository } from "../ports/memory-reference-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import { TaskNotFoundError } from "../commands/schedule-agent-run.ts";
import { ProjectNotFoundError } from "../errors.ts";
import {
  GlobalMemoryDeprecatedError,
  GlobalMemoryNotFoundError,
  GlobalMemorySourceMismatchError,
  GlobalMemoryVersionConflictError,
} from "../memory-errors.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { GlobalLesson } from "@ai-office/domain/memory/global-lesson.ts";
import { GlobalPattern } from "@ai-office/domain/memory/global-pattern.ts";
import {
  GlobalRole,
  type GlobalRoleDefinition,
  normalizeGlobalRoleDefinition,
} from "@ai-office/domain/memory/global-role.ts";
import {
  MemoryReference,
  type MemoryTargetType,
} from "@ai-office/domain/memory/memory-reference.ts";

export class ManageGlobalMemory {
  constructor(
    private readonly memory: GlobalMemoryRepository,
    private readonly references: MemoryReferenceRepository,
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async createRole(input: {
    name: string;
    version: number;
    definition: GlobalRoleDefinition;
  }): Promise<string> {
    const definition = normalizeGlobalRoleDefinition(input.definition);
    const latest = await this.memory.findLatestRoleByKey(definition.key);
    if (latest !== null) {
      const current = latest.snapshot();
      if (input.version <= current.version)
        throw new GlobalMemoryVersionConflictError(
          "role",
          current.id,
          input.version,
          current.version,
        );
    }
    const role = GlobalRole.create({
      id: latest?.snapshot().id ?? this.ids.generate(),
      name: input.name,
      version: input.version,
      definition,
      now: this.clock.now(),
    });
    await this.memory.saveRole(role);
    return role.snapshot().id;
  }

  async getRole(id: string, version: number): Promise<GlobalRole> {
    const role = await this.memory.findRole(id, version);
    if (role === null)
      throw new GlobalMemoryNotFoundError("role", `${id}@${version}`);
    return role;
  }

  async getLatestRole(id: string): Promise<GlobalRole> {
    const role = await this.memory.findLatestRole(id);
    if (role === null) throw new GlobalMemoryNotFoundError("role", id);
    return role;
  }

  async createPattern(input: {
    id?: string;
    name: string;
    version: number;
    problem: string;
    context: string;
    solution: string;
    applicability?: readonly string[];
    constraints?: readonly string[];
    risks?: readonly string[];
    sourceProjectId?: string;
  }): Promise<string> {
    if (input.sourceProjectId !== undefined)
      await this.requireProject(input.sourceProjectId);
    const id = input.id ?? this.ids.generate();
    if ((await this.memory.findPattern(id, input.version)) !== null)
      throw new GlobalMemoryVersionConflictError("pattern", id, input.version);
    const pattern = GlobalPattern.create({
      id,
      ...input,
      now: this.clock.now(),
    });
    await this.memory.savePattern(pattern);
    return pattern.snapshot().id;
  }

  async extractLesson(input: {
    sourceProjectId?: string;
    sourceTaskId?: string;
    title: string;
    content: string;
    confidence: number;
  }): Promise<string> {
    if (input.sourceProjectId !== undefined)
      await this.requireProject(input.sourceProjectId);
    if (input.sourceTaskId !== undefined) {
      const task = await this.tasks.findById(input.sourceTaskId);
      if (task === null) throw new TaskNotFoundError(input.sourceTaskId);
      if (task.snapshot().projectId !== input.sourceProjectId)
        throw new GlobalMemorySourceMismatchError(
          input.sourceTaskId,
          input.sourceProjectId ?? "",
        );
    }
    const lesson = GlobalLesson.create({
      id: this.ids.generate(),
      ...input,
      now: this.clock.now(),
    });
    await this.memory.saveLesson(lesson);
    return lesson.snapshot().id;
  }

  async search(input: {
    query: string;
    limit: number;
  }): Promise<readonly MemorySearchResult[]> {
    if (input.query.trim().length === 0)
      throw new DomainValidationError("Memory search query cannot be empty");
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new DomainValidationError(
        "Memory search limit must be an integer between 1 and 100",
      );
    return this.memory.search(input.query, input.limit);
  }

  async adoptPattern(input: {
    projectId: string;
    patternId: string;
    version: number;
    query?: string;
  }): Promise<string> {
    await this.requireProject(input.projectId);
    const pattern = await this.memory.findPattern(
      input.patternId,
      input.version,
    );
    if (pattern === null)
      throw new GlobalMemoryNotFoundError(
        "pattern",
        `${input.patternId}@${input.version}`,
      );
    if (pattern.snapshot().status !== "active")
      throw new GlobalMemoryDeprecatedError("pattern", input.patternId);
    const reference = MemoryReference.create({
      id: this.ids.generate(),
      projectId: input.projectId,
      targetId: input.patternId,
      targetVersion: input.version,
      targetType: "pattern",
      referenceType: "adopted",
      ...(input.query === undefined ? {} : { query: input.query }),
      now: this.clock.now(),
    });
    return this.references.saveReference(reference);
  }

  async listReferences(projectId: string): Promise<readonly MemoryReference[]> {
    await this.requireProject(projectId);
    return this.references.listReferences(projectId);
  }

  async deprecate(input: {
    type: MemoryTargetType;
    id: string;
    version?: number;
  }): Promise<void> {
    const now = this.clock.now();
    if (input.type === "role") {
      if (input.version === undefined)
        throw new GlobalMemoryNotFoundError("role", `${input.id}@<version>`);
      const role = await this.memory.findRole(input.id, input.version);
      if (role === null)
        throw new GlobalMemoryNotFoundError(
          "role",
          `${input.id}@${input.version}`,
        );
      role.deprecate(now);
      await this.memory.updateRoleStatus(role);
      return;
    }
    if (input.type === "lesson") {
      const lesson = await this.memory.findLesson(input.id);
      if (lesson === null)
        throw new GlobalMemoryNotFoundError("lesson", input.id);
      lesson.deprecate(now);
      await this.memory.saveLesson(lesson);
      return;
    }
    if (input.version === undefined)
      throw new GlobalMemoryNotFoundError("pattern", `${input.id}@<version>`);
    const pattern = await this.memory.findPattern(input.id, input.version);
    if (pattern === null)
      throw new GlobalMemoryNotFoundError(
        "pattern",
        `${input.id}@${input.version}`,
      );
    pattern.deprecate(now);
    await this.memory.savePattern(pattern);
  }

  private async requireProject(projectId: string): Promise<void> {
    if ((await this.projects.findById(projectId)) === null)
      throw new ProjectNotFoundError(projectId);
  }
}

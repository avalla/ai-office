import { ProjectNotFoundError } from "../errors.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type {
  TaskDeliverySetupEntry,
  TaskDeliverySetupRepository,
} from "../ports/task-delivery-setup-repository.port.ts";
import {
  defaultTaskDeliverySetupValues,
  isTaskDeliverySetupKey,
  validateTaskDeliverySetupValue,
  type TaskDeliverySetupKey,
  type TaskDeliverySetupValues,
} from "./task-delivery-setup-schema.ts";

/** One run- or task-scoped row that took part in the resolution. */
export interface TaskDeliverySetupOverride {
  readonly scope: "run" | "task";
  readonly scopeRef: string;
  readonly key: TaskDeliverySetupKey;
  readonly value: string | number;
}

export interface ResolvedTaskDeliverySetup {
  /** Values merged over the built-in defaults, project -> run -> task. */
  readonly values: TaskDeliverySetupValues;
  /** Project-scope rows as stored, keyed by setup key. */
  readonly project: Partial<Record<TaskDeliverySetupKey, string | number>>;
  /** The run/task rows that took part in the resolution, in merge order. */
  readonly overrides: readonly TaskDeliverySetupOverride[];
}

export interface ReadTaskDeliverySetupFilter {
  readonly runId?: string;
  readonly taskId?: string;
}

/**
 * Applies stored rows over the defaults in the order given. Unknown keys and
 * out-of-contract values are left out of the merge but also out of the
 * failure path: a row edited by hand in the database degrades one key to its
 * default instead of bricking every read.
 */
function merged(
  base: TaskDeliverySetupValues,
  entries: readonly TaskDeliverySetupEntry[],
): {
  values: TaskDeliverySetupValues;
  overrides: TaskDeliverySetupOverride[];
} {
  const values: Record<string, string | number> = { ...base };
  const overrides: TaskDeliverySetupOverride[] = [];
  for (const entry of entries) {
    if (!isTaskDeliverySetupKey(entry.key)) continue;
    const valid = validateTaskDeliverySetupValue(entry.key, entry.value);
    if (valid === null) continue;
    values[entry.key] = valid;
    if (entry.scope !== "project" && entry.scopeRef !== null)
      overrides.push({
        scope: entry.scope,
        scopeRef: entry.scopeRef,
        key: entry.key,
        value: valid,
      });
  }
  return { values: values as unknown as TaskDeliverySetupValues, overrides };
}

/** Reads and merges the stored setup for one project and optional overrides. */
export class ReadTaskDeliverySetup {
  constructor(
    private readonly ports: {
      readonly projects: ProjectRepository;
      readonly setup: TaskDeliverySetupRepository;
      readonly transactions: TransactionRunner;
    },
  ) {}

  async read(
    projectId: string,
    filter: ReadTaskDeliverySetupFilter = {},
  ): Promise<ResolvedTaskDeliverySetup> {
    const { projectEntries, overrideEntries } =
      await this.ports.transactions.run(async () => {
        if (!(await this.ports.projects.findById(projectId)))
          throw new ProjectNotFoundError(projectId);
        const projectEntries = await this.ports.setup.get(
          projectId,
          "project",
          null,
        );
        const overrideEntries: TaskDeliverySetupEntry[] = [];
        if (filter.runId !== undefined)
          overrideEntries.push(
            ...(await this.ports.setup.get(projectId, "run", filter.runId)),
          );
        if (filter.taskId !== undefined)
          overrideEntries.push(
            ...(await this.ports.setup.get(projectId, "task", filter.taskId)),
          );
        return { projectEntries, overrideEntries };
      });
    const { values, overrides } = merged(defaultTaskDeliverySetupValues, [
      ...projectEntries,
      ...overrideEntries,
    ]);
    const project: Partial<Record<TaskDeliverySetupKey, string | number>> = {};
    for (const entry of projectEntries) {
      if (!isTaskDeliverySetupKey(entry.key)) continue;
      const valid = validateTaskDeliverySetupValue(entry.key, entry.value);
      if (valid !== null) project[entry.key] = valid;
    }
    return { values, project, overrides };
  }
}

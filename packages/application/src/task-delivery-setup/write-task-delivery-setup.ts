import { ProjectNotFoundError } from "../errors.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskDeliverySetupRepository } from "../ports/task-delivery-setup-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import {
  isTaskDeliverySetupKey,
  taskDeliverySetupSchema,
  validateTaskDeliverySetupValue,
  type TaskDeliverySetupKeySpec,
} from "./task-delivery-setup-schema.ts";
import { TaskDeliverySetupError } from "./task-delivery-setup-errors.ts";

export interface WriteTaskDeliverySetupInput {
  readonly projectId: string;
  readonly scope: "project" | "run" | "task";
  readonly scopeRef?: string;
  readonly key: string;
  /** JSON null deletes the key; any other value upserts it. */
  readonly value: unknown;
  readonly actor: string;
}

export interface WriteTaskDeliverySetupResult {
  readonly scope: "project" | "run" | "task";
  readonly scopeRef: string | null;
  readonly key: string;
  /** The stored value, or null when the key was deleted. */
  readonly value: unknown;
  readonly deleted: boolean;
  readonly updatedAt: Date;
}

/**
 * Writes one setup key. Usage-shape problems (unknown key, out-of-contract
 * value, scope/reference mismatch) are rejected before the transaction; the
 * mutation itself is one short deterministic transaction, mirroring
 * `pricing:set`, which also writes without an audit event.
 */
export class WriteTaskDeliverySetup {
  constructor(
    private readonly ports: {
      readonly projects: ProjectRepository;
      readonly setup: TaskDeliverySetupRepository;
      readonly transactions: TransactionRunner;
    },
  ) {}

  async set(
    input: WriteTaskDeliverySetupInput,
    now: Date,
  ): Promise<WriteTaskDeliverySetupResult> {
    if (!isTaskDeliverySetupKey(input.key))
      throw new TaskDeliverySetupError(
        "TASK_DELIVERY_SETUP_UNKNOWN_KEY",
        `Unknown task-delivery setup key: ${input.key}`,
      );
    if (input.scope === "project" && input.scopeRef !== undefined)
      throw new TaskDeliverySetupError(
        "TASK_DELIVERY_SETUP_SCOPE_REF_FORBIDDEN",
        "Project scope does not take a run or task reference",
      );
    if (input.scope !== "project" && input.scopeRef === undefined)
      throw new TaskDeliverySetupError(
        "TASK_DELIVERY_SETUP_SCOPE_REF_REQUIRED",
        `${input.scope} scope requires a --${input.scope} reference`,
      );
    const deleting = input.value === null;
    if (!deleting) {
      const valid = validateTaskDeliverySetupValue(
        input.key,
        input.value,
      );
      if (valid === null) {
        const spec: TaskDeliverySetupKeySpec = taskDeliverySetupSchema[input.key];
        const expected =
          spec.values !== undefined
            ? `one of: ${spec.values.join(", ")}`
            : `a number from ${spec.number!.min} to ${spec.number!.max}`;
        throw new TaskDeliverySetupError(
          "TASK_DELIVERY_SETUP_INVALID_VALUE",
          `Invalid value for setup key ${input.key}; expected ${expected}`,
        );
      }
    }
    const scopeRef = input.scope === "project" ? null : input.scopeRef!;
    const result = await this.ports.transactions.run(async () => {
      if (!(await this.ports.projects.findById(input.projectId)))
        throw new ProjectNotFoundError(input.projectId);
      if (deleting) {
        await this.ports.setup.remove(
          input.projectId,
          input.scope,
          scopeRef,
          input.key,
        );
        return null;
      }
      await this.ports.setup.put(
        {
          projectId: input.projectId,
          scope: input.scope,
          scopeRef,
          key: input.key,
          value: input.value,
        },
        input.actor,
        now,
      );
      return input.value;
    });
    return {
      scope: input.scope,
      scopeRef,
      key: input.key,
      value: result,
      deleted: deleting,
      updatedAt: now,
    };
  }
}

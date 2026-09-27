import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import type { TaskRequirementRepository } from "@ai-office/application/ports/task-requirement-repository.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { SurrealProjectRepository } from "./project-storage/surreal-project-repository.ts";
import { SurrealTaskRepository } from "./project-storage/surreal-task-repository.ts";
import { SurrealTaskRequirementRepository } from "./project-storage/surreal-task-requirement-repository.ts";
import { initializeProjectStorageSubsetSchema } from "./project-storage/schema.ts";
import { SurrealTransactionRunner } from "./project-storage/surreal-transaction-runner.ts";
import type { Surreal } from "surrealdb";

/** Explicitly partial composition; it is not a ProjectStorage implementation. */
export interface SurrealProjectStorageSubsetExperiment {
  readonly experiment: "surrealdb-project-storage-subset";
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly capabilities: readonly ["projects", "tasks", "taskRequirements", "transactions"];
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly taskRequirements: TaskRequirementRepository;
  readonly transactions: TransactionRunner;
}

export async function createSurrealProjectStorageSubsetExperiment(
  db: Surreal,
  tenantId: string,
): Promise<SurrealProjectStorageSubsetExperiment> {
  if (!tenantId.trim())
    throw new Error("Surreal ProjectStorage subset requires a trusted tenant ID");
  await initializeProjectStorageSubsetSchema(db);
  const transactions = new SurrealTransactionRunner(db);
  return {
    experiment: "surrealdb-project-storage-subset",
    schemaVersion: 1,
    tenantId,
    capabilities: ["projects", "tasks", "taskRequirements", "transactions"],
    projects: new SurrealProjectRepository(db, tenantId),
    tasks: new SurrealTaskRepository(db, tenantId),
    taskRequirements: new SurrealTaskRequirementRepository(db, tenantId, transactions),
    transactions,
  };
}

import type { Database } from "bun:sqlite";
import type { ProjectStorage } from "@ai-office/application/ports/project-storage.port.ts";
import { SqliteAgentRuntimeRepository } from "./repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "./repositories/sqlite-audit-event.repository.ts";
import { SqliteCapabilityPolicyRepository } from "./repositories/sqlite-capability-policy.repository.ts";
import { SqliteControlledExecutionRepository } from "./repositories/sqlite-controlled-execution.repository.ts";
import { SqliteCostRepository } from "./repositories/sqlite-cost.repository.ts";
import { SqliteGovernanceRepository } from "./repositories/sqlite-governance.repository.ts";
import { SqliteJobOutboxRepository } from "./repositories/sqlite-job-outbox.repository.ts";
import { SqliteMemoryReferenceRepository } from "./repositories/sqlite-memory-reference.repository.ts";
import { SqliteOfficeManifestRepository } from "./repositories/sqlite-office-manifest.repository.ts";
import { SqliteOperationalReadRepository } from "./repositories/sqlite-operational-read.repository.ts";
import { SqlitePipelineRunRepository } from "./repositories/sqlite-pipeline-run.repository.ts";
import { SqliteProjectMemoryProvenanceRepository } from "./repositories/sqlite-project-memory-provenance.repository.ts";
import { SqliteProjectProfileRepository } from "./repositories/sqlite-project-profile.repository.ts";
import { SqliteProjectRepository } from "./repositories/sqlite-project.repository.ts";
import { SqliteProjectStateRepository } from "./repositories/sqlite-project-state.repository.ts";
import { SqliteRepositoryIdentityRepository } from "./repositories/sqlite-repository-identity.repository.ts";
import { SqliteTaskRequirementRepository } from "./repositories/sqlite-task-requirement.repository.ts";
import { SqliteTaskRepository } from "./repositories/sqlite-task.repository.ts";
import { SqliteTransactionRunner } from "./database/sqlite-transaction-runner.ts";

/** Compose the existing SQLite adapters for one project authority. */
export function createSqliteProjectStorage(database: Database): ProjectStorage {
  return {
    projects: new SqliteProjectRepository(database),
    profiles: new SqliteProjectProfileRepository(database),
    officeManifests: new SqliteOfficeManifestRepository(database),
    pipelines: new SqlitePipelineRunRepository(database),
    tasks: new SqliteTaskRepository(database),
    taskRequirements: new SqliteTaskRequirementRepository(database),
    runtime: new SqliteAgentRuntimeRepository(database),
    costs: new SqliteCostRepository(database),
    governance: new SqliteGovernanceRepository(database),
    capabilities: new SqliteCapabilityPolicyRepository(database),
    controlled: new SqliteControlledExecutionRepository(database),
    auditEvents: new SqliteAuditEventRepository(database),
    repositoryIdentities: new SqliteRepositoryIdentityRepository(database),
    projectStates: new SqliteProjectStateRepository(database),
    memoryReferences: new SqliteMemoryReferenceRepository(database),
    projectMemoryProvenance: new SqliteProjectMemoryProvenanceRepository(
      database,
    ),
    operationalReads: new SqliteOperationalReadRepository(database),
    transactions: new SqliteTransactionRunner(database),
    jobOutbox: new SqliteJobOutboxRepository(database),
  };
}

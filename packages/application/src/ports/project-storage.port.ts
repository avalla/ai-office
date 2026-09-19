import type { AgentRuntimeRepository } from "./agent-runtime-repository.port.ts";
import type { AuditEventRepository } from "./audit-event-repository.port.ts";
import type { CapabilityPolicyRepository } from "./capability-policy-repository.port.ts";
import type { ControlledExecutionRepository } from "./controlled-execution-repository.port.ts";
import type { CostRepository } from "./cost-repository.port.ts";
import type { GovernanceRepository } from "./governance-repository.port.ts";
import type { JobOutboxRepository } from "./job-outbox-repository.port.ts";
import type { MemoryReferenceRepository } from "./memory-reference-repository.port.ts";
import type { OfficeManifestRepository } from "./office-manifest-repository.port.ts";
import type { OperationalReadRepository } from "./operational-read.port.ts";
import type { PipelineRunRepository } from "./pipeline-run-repository.port.ts";
import type { ProjectMemoryProvenanceRepository } from "./project-memory-provenance-repository.port.ts";
import type { ProjectProfileRepository } from "./project-profile-repository.port.ts";
import type { ProjectRepository } from "./project-repository.port.ts";
import type { ProjectStateRepository } from "./project-state-repository.port.ts";
import type { RepositoryIdentityRepository } from "./repository-identity-repository.port.ts";
import type { TaskRepository } from "./task-repository.port.ts";
import type { TaskRequirementRepository } from "./task-requirement-repository.port.ts";
import type { TransactionRunner } from "./transaction-runner.port.ts";

/**
 * Repository ports that make up one authoritative project store.
 *
 * Global reusable memory and the future regenerable code index intentionally
 * remain outside this boundary.
 */
export interface ProjectStorage {
  projects: ProjectRepository;
  profiles: ProjectProfileRepository;
  officeManifests: OfficeManifestRepository;
  pipelines: PipelineRunRepository;
  tasks: TaskRepository;
  taskRequirements: TaskRequirementRepository;
  runtime: AgentRuntimeRepository;
  costs: CostRepository;
  governance: GovernanceRepository;
  capabilities: CapabilityPolicyRepository;
  controlled: ControlledExecutionRepository;
  auditEvents: AuditEventRepository;
  repositoryIdentities: RepositoryIdentityRepository;
  projectStates: ProjectStateRepository;
  memoryReferences: MemoryReferenceRepository;
  projectMemoryProvenance: ProjectMemoryProvenanceRepository;
  operationalReads: OperationalReadRepository;
  transactions: TransactionRunner;
  jobOutbox: JobOutboxRepository;
}

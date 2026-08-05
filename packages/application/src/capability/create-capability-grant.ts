import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import { ProjectNotFoundError } from "../errors.ts";
import {
  CapabilityPrincipalNotFoundError,
  CapabilityProjectMismatchError,
  ResourceNotFoundError,
} from "../capability-errors.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type {
  CapabilityGrant,
  CapabilityPrincipalType,
} from "@ai-office/domain/capability/capability.ts";
import { canonicalRecord, requiredText, validateGrant } from "./validation.ts";

export class CreateCapabilityGrant {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly runtime: AgentRuntimeRepository,
    private readonly repository: CapabilityPolicyRepository,
    private readonly audit: RecordAuditEvent,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(input: {
    projectId: string;
    principalType: CapabilityPrincipalType;
    principalId: string;
    resourceId: string;
    actions: readonly string[];
    constraints?: Readonly<Record<string, unknown>>;
    validFrom?: Date;
    expiresAt?: Date;
    grantedBy: string;
    reason: string;
  }): Promise<CapabilityGrant> {
    if ((await this.projects.findById(input.projectId)) === null)
      throw new ProjectNotFoundError(input.projectId);
    const resource = await this.repository.findResource(input.resourceId);
    if (resource === null) throw new ResourceNotFoundError(input.resourceId);
    if (resource.projectId !== input.projectId)
      throw new CapabilityProjectMismatchError();
    if (input.principalType === "agent") {
      const agent = await this.runtime.findAgent(input.principalId);
      if (agent === null || agent.projectId !== input.projectId)
        throw new CapabilityPrincipalNotFoundError("agent", input.principalId);
    }
    if (input.principalType === "role") {
      const role = await this.runtime.findRole(
        input.principalId,
        input.projectId,
      );
      if (role === null)
        throw new CapabilityPrincipalNotFoundError("role", input.principalId);
    }
    const now = this.clock.now();
    const grant: CapabilityGrant = {
      id: this.ids.generate(),
      projectId: input.projectId,
      principalType: input.principalType,
      principalId: requiredText(input.principalId, "principal id"),
      resourceId: resource.id,
      actions: Object.freeze(
        [...new Set(input.actions.map((action) => action.trim()))].sort(),
      ),
      constraints: canonicalRecord(
        input.constraints ?? {},
        "grant constraints",
      ),
      validFrom: input.validFrom ?? now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      grantedBy: requiredText(input.grantedBy, "granted by"),
      reason: requiredText(input.reason, "reason"),
      createdAt: now,
    };
    validateGrant(grant, resource.provider);
    await this.transactions.run(async () => {
      await this.repository.saveGrant(grant);
      await this.audit.execute({
        eventType: "capability.granted",
        actorType: "cli",
        actorId: grant.grantedBy,
        projectId: grant.projectId,
        aggregateType: "capability_grant",
        aggregateId: grant.id,
        payload: {
          principalType: grant.principalType,
          principalId: grant.principalId,
          resourceId: grant.resourceId,
          actions: grant.actions,
        },
      });
    });
    return grant;
  }
}

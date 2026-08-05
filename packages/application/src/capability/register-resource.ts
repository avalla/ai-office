import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import { ProjectNotFoundError } from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type {
  Resource,
  ResourceType,
} from "@ai-office/domain/capability/capability.ts";
import {
  canonicalRecord,
  requiredText,
  validateResource,
} from "./validation.ts";

export class RegisterResource {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly repository: CapabilityPolicyRepository,
    private readonly audit: RecordAuditEvent,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(input: {
    projectId: string;
    type: ResourceType;
    provider: string;
    externalRef?: string;
    displayName: string;
    configuration?: Readonly<Record<string, unknown>>;
  }): Promise<Resource> {
    if ((await this.projects.findById(input.projectId)) === null)
      throw new ProjectNotFoundError(input.projectId);
    const now = this.clock.now();
    const resource: Resource = {
      id: this.ids.generate(),
      projectId: requiredText(input.projectId, "project id"),
      type: input.type,
      provider: requiredText(input.provider, "provider"),
      ...(input.externalRef === undefined
        ? {}
        : { externalRef: requiredText(input.externalRef, "external ref") }),
      displayName: requiredText(input.displayName, "display name"),
      configuration: canonicalRecord(
        input.configuration ?? {},
        "resource configuration",
      ),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    validateResource(resource);
    await this.transactions.run(async () => {
      await this.repository.saveResource(resource);
      await this.audit.execute({
        eventType: "resource.registered",
        actorType: "cli",
        actorId: "local-cli",
        projectId: resource.projectId,
        aggregateType: "resource",
        aggregateId: resource.id,
        payload: { type: resource.type, provider: resource.provider },
      });
    });
    return resource;
  }
}

import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import {
  CapabilityProjectMismatchError,
  ResourceDisabledError,
  ResourceNotFoundError,
} from "../capability-errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";

export class DisableResource {
  constructor(
    private readonly repository: CapabilityPolicyRepository,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(input: {
    projectId: string;
    resourceId: string;
  }): Promise<void> {
    const resource = await this.repository.findResource(input.resourceId);
    if (resource === null) throw new ResourceNotFoundError(input.resourceId);
    if (resource.projectId !== input.projectId)
      throw new CapabilityProjectMismatchError();
    if (resource.status === "disabled")
      throw new ResourceDisabledError(resource.id);
    await this.transactions.run(async () => {
      const disabled = await this.repository.disableResource(
        resource.id,
        input.projectId,
        this.clock.now(),
      );
      if (!disabled) throw new ResourceDisabledError(resource.id);
      await this.audit.execute({
        eventType: "resource.disabled",
        actorType: "cli",
        actorId: "local-cli",
        projectId: input.projectId,
        aggregateType: "resource",
        aggregateId: resource.id,
      });
    });
  }
}

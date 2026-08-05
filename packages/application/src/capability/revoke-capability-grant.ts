import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import {
  CapabilityGrantNotFoundError,
  CapabilityGrantRevokedError,
  CapabilityProjectMismatchError,
} from "../capability-errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";

export class RevokeCapabilityGrant {
  constructor(
    private readonly repository: CapabilityPolicyRepository,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(input: {
    projectId: string;
    grantId: string;
    revokedBy: string;
  }): Promise<void> {
    const grant = await this.repository.findGrant(input.grantId);
    if (grant === null) throw new CapabilityGrantNotFoundError(input.grantId);
    if (grant.projectId !== input.projectId)
      throw new CapabilityProjectMismatchError();
    if (grant.revokedAt !== undefined)
      throw new CapabilityGrantRevokedError(grant.id);
    await this.transactions.run(async () => {
      const revoked = await this.repository.revokeGrant(
        grant.id,
        grant.projectId,
        this.clock.now(),
      );
      if (!revoked) throw new CapabilityGrantRevokedError(grant.id);
      await this.audit.execute({
        eventType: "capability.revoked",
        actorType: "cli",
        actorId: input.revokedBy,
        projectId: grant.projectId,
        aggregateType: "capability_grant",
        aggregateId: grant.id,
        payload: { resourceId: grant.resourceId },
      });
    });
  }
}

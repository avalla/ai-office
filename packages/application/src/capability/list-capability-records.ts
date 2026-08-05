import {
  ActionRequestNotFoundError,
  CapabilityProjectMismatchError,
} from "../capability-errors.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";

export class ListCapabilityRecords {
  constructor(private readonly repository: CapabilityPolicyRepository) {}

  listResources(projectId: string) {
    return this.repository.listResources(projectId);
  }

  listGrants(projectId: string) {
    return this.repository.listGrants(projectId);
  }

  listActions(projectId: string) {
    return this.repository.listActionRequests(projectId);
  }

  async showAction(id: string, projectId: string) {
    const request = await this.repository.findActionRequest(id);
    if (request === null) throw new ActionRequestNotFoundError(id);
    if (request.snapshot().projectId !== projectId)
      throw new CapabilityProjectMismatchError();
    return request;
  }
}

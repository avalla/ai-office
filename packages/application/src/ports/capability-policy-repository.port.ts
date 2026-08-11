import type {
  ActionRequest,
  ActionStatus,
} from "@ai-office/domain/capability/action-request.ts";
import type { ActionSimulation } from "@ai-office/domain/capability/action-simulation.ts";
import type {
  CapabilityGrant,
  Resource,
} from "@ai-office/domain/capability/capability.ts";

export interface CapabilityPolicyRepository {
  saveResource(resource: Resource): Promise<void>;
  findResource(id: string): Promise<Resource | null>;
  listResources(projectId: string): Promise<Resource[]>;
  disableResource(id: string, projectId: string, now: Date): Promise<boolean>;
  saveGrant(grant: CapabilityGrant): Promise<void>;
  findGrant(id: string): Promise<CapabilityGrant | null>;
  listGrants(
    projectId: string,
    resourceId?: string,
  ): Promise<CapabilityGrant[]>;
  revokeGrant(id: string, projectId: string, now: Date): Promise<boolean>;
  insertActionRequest(request: ActionRequest): Promise<void>;
  transitionActionRequest(input: {
    id: string;
    projectId: string;
    expectedStatus: ActionStatus;
    status: ActionStatus;
    updatedAt: Date;
  }): Promise<boolean>;
  insertActionSimulation(simulation: ActionSimulation): Promise<boolean>;
  findActionSimulationByAction(
    actionRequestId: string,
    projectId: string,
  ): Promise<ActionSimulation | null>;
  findActionRequest(id: string): Promise<ActionRequest | null>;
  listActionRequests(projectId: string): Promise<ActionRequest[]>;
}

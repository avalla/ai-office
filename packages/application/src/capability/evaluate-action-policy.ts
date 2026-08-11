import {
  CapabilityPrincipalNotFoundError,
  CapabilityProjectMismatchError,
  ResourceNotFoundError,
} from "../capability-errors.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { ConnectorDescriptor } from "@ai-office/connector-sdk/connector.ts";
import type { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";
import type {
  PolicyDecision,
  Resource,
} from "@ai-office/domain/capability/capability.ts";
import { PolicyEngine } from "@ai-office/domain/capability/policy-engine.ts";
import { canonicalRecord, requiredText } from "./validation.ts";

export interface EvaluatedActionPolicy {
  decision: PolicyDecision;
  resource: Resource;
  normalizedArguments: Readonly<Record<string, unknown>>;
  connector: ConnectorDescriptor;
}

export class EvaluateActionPolicy {
  constructor(
    private readonly runtime: AgentRuntimeRepository,
    private readonly repository: CapabilityPolicyRepository,
    private readonly clock: Clock,
    private readonly connectors: ConnectorRegistry,
    private readonly engine: PolicyEngine = new PolicyEngine(connectors),
  ) {}

  async execute(input: {
    projectId: string;
    agentId: string;
    resourceId: string;
    operation: string;
    arguments: Readonly<Record<string, unknown>>;
    evaluatedAt?: Date;
  }): Promise<EvaluatedActionPolicy> {
    const resource = await this.repository.findResource(input.resourceId);
    if (resource === null) throw new ResourceNotFoundError(input.resourceId);
    if (resource.projectId !== input.projectId)
      throw new CapabilityProjectMismatchError();
    const agent = await this.runtime.findAgent(input.agentId);
    if (agent === null || agent.projectId !== input.projectId || !agent.enabled)
      throw new CapabilityPrincipalNotFoundError("agent", input.agentId);
    const role = await this.runtime.findRole(agent.roleId, input.projectId);
    if (role === null)
      throw new CapabilityPrincipalNotFoundError("role", agent.roleId);
    const definition = this.connectors.requireDefinition(resource.provider);
    const normalizedArguments = definition.normalizeArguments(
      requiredText(input.operation, "operation"),
      canonicalRecord(input.arguments, "action arguments"),
    );
    const decision = this.engine.evaluate(
      {
        projectId: input.projectId,
        agentId: agent.id,
        roleIds: [role.snapshot().id],
        resource,
        operation: requiredText(input.operation, "operation"),
        arguments: normalizedArguments,
        grants: await this.repository.listGrants(input.projectId, resource.id),
      },
      input.evaluatedAt ?? this.clock.now(),
    );
    return {
      decision,
      resource,
      normalizedArguments,
      connector: definition.descriptor,
    };
  }
}

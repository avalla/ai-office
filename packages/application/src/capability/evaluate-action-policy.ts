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
import {
  EvaluatePipelineAuthorization,
  type PipelineAuthorizationDecision,
} from "../pipeline/evaluate-pipeline-authorization.ts";

export interface EvaluatedActionPolicy {
  decision: PolicyDecision;
  pipeline: PipelineAuthorizationDecision;
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
    private readonly pipeline?: EvaluatePipelineAuthorization,
    private readonly engine: PolicyEngine = new PolicyEngine(connectors),
  ) {}

  async execute(input: {
    projectId: string;
    agentId: string;
    resourceId: string;
    operation: string;
    arguments: Readonly<Record<string, unknown>>;
    evaluatedAt?: Date;
    pipelineRunId?: string;
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
    const baseDecision = this.engine.evaluate(
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
    const pipeline =
      this.pipeline === undefined
        ? ({ decision: "allow", reasons: [] } as const)
        : await this.pipeline.execute({
            projectId: input.projectId,
            agentId: input.agentId,
            operation: requiredText(input.operation, "operation"),
            ...(input.pipelineRunId === undefined
              ? {}
              : { pipelineRunId: input.pipelineRunId }),
          });
    const decision: PolicyDecision =
      pipeline.decision === "allow"
        ? baseDecision
        : {
            ...baseDecision,
            decision: "deny",
            reasons: [...baseDecision.reasons, ...pipeline.reasons],
          };
    return {
      decision,
      pipeline,
      resource,
      normalizedArguments,
      connector: definition.descriptor,
    };
  }
}

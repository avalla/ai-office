import type { ModelSelectionSource } from "@ai-office/domain/agent/agent-run-model.ts";
import { ProjectNotFoundError } from "../errors.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { CostRepository } from "../ports/cost-repository.port.ts";
import type { ModelProviderCatalog } from "../ports/model-provider-catalog.port.ts";
import type {
  ProviderCredentialIssueCode,
  ProviderCredentialOrigin,
  ProviderCredentialState,
} from "../ports/provider-credential-source.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import {
  ModelRoutingError,
  resolveAgentRunModel,
  type AgentModelOverride,
  type ConcreteModel,
  type ModelRoutingIssue,
  type ModelRoutingSources,
  type ModelRoutingState,
} from "./model-routing.ts";

export type ModelRoutingFindingSeverity = "error" | "warning";

export interface ModelRoutingFinding extends ModelRoutingIssue {
  readonly severity: ModelRoutingFindingSeverity;
}

export interface AgentModelRoute {
  agentId: string;
  agent: string;
  enabled: boolean;
  roleKey: string | null;
  policy: string | null;
  status: "resolved" | "unrouted" | "error";
  profile: string | null;
  modelRef: string | null;
  providerId: string | null;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
  source: ModelSelectionSource | null;
  /** The role budget; a model choice never changes it. */
  maxCostMicros: string | null;
  error: { code: string; message: string } | null;
}

export interface ModelRoutingReport {
  schemaVersion: 1;
  status: ModelRoutingState["status"];
  valid: boolean;
  sources: ModelRoutingSources;
  defaultProfile: string | null;
  legacyDefaultModelRef: string | null;
  profiles: {
    key: string;
    modelRef: string;
    providerId: string;
    reasoningEffort: string | null;
    maxOutputTokens: number | null;
  }[];
  policies: { policy: string; profile: string }[];
  agentOverrides: {
    /** `host`: every project's agent with this name; `project`: one project only. */
    scope: "host" | "project";
    projectId: string | null;
    agent: string;
    profile: string | null;
    modelRef: string | null;
  }[];
  providers: {
    providerId: string;
    supported: boolean;
    /** Whether the metered gateway worker can execute this provider's models. */
    gatewayExecution: boolean;
    /** Names of unusable (missing or invalid) credentials. */
    missingCredentials: string[];
    /** Presence by logical name only: never a value, length or path. */
    credentials: {
      name: string;
      state: ProviderCredentialState;
      origin: ProviderCredentialOrigin | null;
      issue: ProviderCredentialIssueCode | null;
    }[];
  }[];
  /** `managed`: provider credentials are read only from the Runtime home. */
  credentialSource: "managed" | "foreground";
  project: { projectId: string; agents: AgentModelRoute[] } | null;
  findings: ModelRoutingFinding[];
}

const byText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function overrideReport(
  scope: "host" | "project",
  projectId: string | null,
  agent: string,
  override: AgentModelOverride,
): ModelRoutingReport["agentOverrides"][number] {
  return {
    scope,
    projectId,
    agent,
    profile: override.kind === "profile" ? override.profile : null,
    modelRef: override.kind === "model" ? override.modelRef : null,
  };
}

/**
 * Validates host model routing without constructing a provider client, sending
 * a model request, or writing project or Runtime state.
 */
export class DescribeModelRouting {
  constructor(
    private readonly routing: ModelRoutingState,
    private readonly providers: ModelProviderCatalog,
    private readonly projects: ProjectRepository,
    private readonly runtime: AgentRuntimeRepository,
    private readonly costs: CostRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string | null;
  }): Promise<ModelRoutingReport> {
    const routing = this.routing;
    const findings: ModelRoutingFinding[] = [
      ...(routing.status === "misconfigured" ? routing.issues : []).map(
        (issue) => ({ ...issue, severity: "error" as const }),
      ),
      ...routing.warnings.map((issue) => ({
        ...issue,
        severity: "warning" as const,
      })),
    ];
    const configuration =
      routing.status === "configured" ? routing.configuration : null;
    const concreteModels = new Map<string, ConcreteModel>();
    const remember = (model: ConcreteModel) =>
      concreteModels.set(model.modelRef, model);
    for (const profile of configuration?.profiles.values() ?? [])
      remember(profile);
    for (const override of configuration?.agentOverrides.values() ?? [])
      if (override.kind === "model") remember(override);
    for (const overrides of configuration?.projectAgentOverrides.values() ?? [])
      for (const override of overrides.values())
        if (override.kind === "model") remember(override);
    if (configuration?.legacyDefault != null)
      remember(configuration.legacyDefault);

    const providerIds = [
      ...new Set([...concreteModels.values()].map((model) => model.providerId)),
    ].sort(byText);
    const managedCredentials = this.providers.credentialsManaged();
    const credentialLocation = managedCredentials
      ? "the Runtime home credentials directory (managed Runtime)"
      : "the Runtime host environment or the Runtime home credentials directory";
    const providers = providerIds.map((providerId) => {
      const missing = this.providers.missingCredentials(providerId);
      const gatewayExecution =
        this.providers.supportsGatewayExecution(providerId);
      // Only a gateway-executable provider reads host credentials; client-login
      // workers use their own login. Statuses carry names, never values.
      const statuses = gatewayExecution
        ? (this.providers.credentialStatuses(providerId) ?? [])
        : [];
      const credentials = statuses.map((status) => ({
        name: status.name,
        state: status.state,
        origin: status.origin,
        issue: status.issue,
      }));
      for (const status of statuses)
        if (status.state === "invalid")
          findings.push({
            severity: "warning",
            code: "PROVIDER_CREDENTIAL_INVALID",
            subject: status.name,
            message: `${status.name} is present but unusable (${status.issue ?? "CREDENTIAL_UNREADABLE"}); gateway execution for provider ${providerId} fails closed until it is corrected and the Runtime restarts.`,
          });
      const absent = credentials
        .filter((status) => status.state === "missing")
        .map((status) => status.name);
      if (absent.length > 0)
        findings.push({
          severity: "warning",
          code: "PROVIDER_CREDENTIALS_MISSING",
          subject: providerId,
          message: `Gateway execution for provider ${providerId} needs ${absent.join(", ")} in ${credentialLocation}. Client-login workers do not use these credentials.`,
        });
      for (const status of statuses)
        if (status.ambientIgnored)
          findings.push({
            severity: "warning",
            code: "MANAGED_ENVIRONMENT_IGNORED",
            subject: status.name,
            message: `${status.name} is ignored by the managed Runtime service, which reads provider credentials only from the Runtime home credentials directory.`,
          });
      return {
        providerId,
        supported: missing !== null,
        gatewayExecution,
        missingCredentials: gatewayExecution ? [...(missing ?? [])] : [],
        credentials,
      };
    });

    const now = this.clock.now();
    for (const model of [...concreteModels.values()].sort((left, right) =>
      byText(left.modelRef, right.modelRef),
    ))
      if (
        (await this.costs.findPricing(model.providerId, model.model, now)) ===
        null
      )
        findings.push({
          severity: "warning",
          code: "PRICING_MISSING",
          subject: model.modelRef,
          message: `No active pricing for ${model.modelRef}. Metered gateway execution fails closed until pricing:set records it.`,
        });

    let project: ModelRoutingReport["project"] = null;
    if (input.projectId !== null) {
      if ((await this.projects.findById(input.projectId)) === null)
        throw new ProjectNotFoundError(input.projectId);
      const agents: AgentModelRoute[] = [];
      for (const agent of await this.runtime.listAgents(input.projectId)) {
        const role = (
          await this.runtime.findRole(agent.roleId, input.projectId)
        )?.snapshot();
        const route: AgentModelRoute = {
          agentId: agent.id,
          agent: agent.name,
          enabled: agent.enabled,
          roleKey: role?.key ?? null,
          policy: role?.modelPolicy ?? null,
          status: "error",
          profile: null,
          modelRef: null,
          providerId: null,
          reasoningEffort: null,
          maxOutputTokens: null,
          source: null,
          maxCostMicros: role?.limits.maxCostMicros.toString() ?? null,
          error: null,
        };
        if (role === undefined) {
          route.error = {
            code: "ROLE_NOT_FOUND",
            message: `Agent ${agent.name} has no synchronized role.`,
          };
          agents.push(route);
          continue;
        }
        try {
          const resolved = resolveAgentRunModel(routing, {
            projectId: input.projectId,
            agentName: agent.name,
            modelPolicy: role.modelPolicy,
          });
          if (resolved.status === "unrouted") route.status = "unrouted";
          else {
            const selection = resolved.selection;
            Object.assign(route, {
              status: "resolved",
              profile: selection.profile,
              modelRef: selection.modelRef,
              providerId: selection.providerId,
              reasoningEffort: selection.reasoningEffort,
              maxOutputTokens: selection.maxOutputTokens,
              source: selection.source,
            });
            if (
              selection.source === "default" ||
              selection.source === "legacy_default"
            )
              findings.push({
                severity: "warning",
                code: "POLICY_UNDEFINED",
                subject: `${agent.name}:${role.modelPolicy}`,
                message: `Model policy "${role.modelPolicy}" of agent ${agent.name} has no profile; it uses the ${selection.source === "default" ? "default profile" : "legacy AI_OFFICE_LLM_MODEL default"}.`,
              });
          }
        } catch (error) {
          if (!(error instanceof ModelRoutingError)) throw error;
          route.error = { code: error.code, message: error.message };
          if (error.code !== "MODEL_ROUTING_MISCONFIGURED")
            findings.push({
              severity: "error",
              code:
                error.code === "MODEL_POLICY_UNRESOLVED"
                  ? "POLICY_UNRESOLVED"
                  : "PROFILE_UNDEFINED",
              subject: `${agent.name}:${role.modelPolicy}`,
              message: error.message,
            });
        }
        agents.push(route);
      }
      const names = new Set(agents.map((agent) => agent.agent));
      for (const name of [...(configuration?.agentOverrides.keys() ?? [])].sort(
        byText,
      ))
        if (!names.has(name))
          findings.push({
            severity: "warning",
            code: "AGENT_OVERRIDE_UNKNOWN_AGENT",
            subject: name,
            message: `Host-global agent override ${name} matches no agent in project ${input.projectId}.`,
          });
      for (const name of [
        ...(configuration?.projectAgentOverrides.get(input.projectId)?.keys() ??
          []),
      ].sort(byText))
        if (!names.has(name))
          findings.push({
            severity: "warning",
            code: "AGENT_OVERRIDE_UNKNOWN_AGENT",
            subject: `projects.${input.projectId}.agents.${name}`,
            message: `Project agent override ${name} matches no agent in project ${input.projectId}.`,
          });
      project = { projectId: input.projectId, agents };
    }
    for (const projectId of [
      ...(configuration?.projectAgentOverrides.keys() ?? []),
    ].sort(byText))
      if ((await this.projects.findById(projectId)) === null)
        findings.push({
          severity: "warning",
          code: "PROJECT_OVERRIDE_UNKNOWN_PROJECT",
          subject: `projects.${projectId}`,
          message: `Project overrides name ${projectId}, which is not a project of this Runtime.`,
        });

    return {
      schemaVersion: 1,
      status: routing.status,
      valid: !findings.some((finding) => finding.severity === "error"),
      sources: { ...routing.sources },
      defaultProfile: configuration?.defaultProfile ?? null,
      legacyDefaultModelRef: configuration?.legacyDefault?.modelRef ?? null,
      profiles: [...(configuration?.profiles.values() ?? [])]
        .map((profile) => ({
          key: profile.key,
          modelRef: profile.modelRef,
          providerId: profile.providerId,
          reasoningEffort: profile.reasoningEffort,
          maxOutputTokens: profile.maxOutputTokens,
        }))
        .sort((left, right) => byText(left.key, right.key)),
      policies: [...(configuration?.policies.entries() ?? [])]
        .map(([policy, profile]) => ({ policy, profile }))
        .sort((left, right) => byText(left.policy, right.policy)),
      agentOverrides: [
        ...[...(configuration?.agentOverrides.entries() ?? [])]
          .map(([agent, override]) =>
            overrideReport("host", null, agent, override),
          )
          .sort((left, right) => byText(left.agent, right.agent)),
        ...[...(configuration?.projectAgentOverrides.entries() ?? [])]
          .sort(([left], [right]) => byText(left, right))
          .flatMap(([projectId, overrides]) =>
            [...overrides.entries()]
              .map(([agent, override]) =>
                overrideReport("project", projectId, agent, override),
              )
              .sort((left, right) => byText(left.agent, right.agent)),
          ),
      ],
      providers,
      credentialSource: managedCredentials ? "managed" : "foreground",
      project,
      findings,
    };
  }
}

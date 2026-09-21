import {
  DescribeModelRouting,
  type ModelRoutingReport,
} from "@ai-office/application/model-routing/describe-model-routing.ts";
import { dirname } from "node:path";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  parseCanonicalModelRef,
  ModelProviderConfigurationError,
} from "@ai-office/llm-gateway/model-ref.ts";
import { modelTokenPattern } from "@ai-office/domain/agent/agent-run-model.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

function describe(context: CommandContext, projectId: string | null) {
  return new DescribeModelRouting(
    context.modelRouting,
    context.modelProviders,
    context.projects,
    context.runtime,
    context.costs,
    context.clock,
  ).execute({ projectId });
}

const dash = (value: string | number | null) =>
  value === null ? "-" : String(value);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function routingDocument(path: string): Record<string, unknown> {
  try {
    const root = record(Bun.YAML.parse(readFileSync(path, "utf8")));
    if (root === null)
      throw new CliUsageError("Model routing file must be a map");
    return root;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ENOENT"
    )
      return {
        schema_version: 1,
        profiles: {},
        policies: {},
        default_profile: null,
        agents: {},
        projects: {},
      };
    throw new CliUsageError("Model routing file cannot be read or parsed");
  }
}

function writeRoutingDocument(
  path: string,
  document: Record<string, unknown>,
  token: string,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + token + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The mutation failed; preserve the original error semantics without
      // exposing a host-local path.
    }
    throw new CliUsageError(
      "Model routing file could not be written; reload was not attempted",
    );
  }
}

function routingOverrideDocument(
  document: Record<string, unknown>,
  scope: "host" | "project",
  projectId: string | undefined,
  agent: string,
  target: Record<string, string>,
): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  const root =
    scope === "host"
      ? next
      : (() => {
          const projects = record(next.projects) ?? {};
          const project = record(projects[projectId!]) ?? {};
          projects[projectId!] = project;
          next.projects = projects;
          return project;
        })();
  const agents = record(root.agents) ?? {};
  agents[agent] = target;
  root.agents = agents;
  if (next.schema_version === undefined) next.schema_version = 1;
  return next;
}

function modelTarget(model: string, providers: readonly string[]): string {
  try {
    const parsed = parseCanonicalModelRef(model);
    if (!providers.includes(parsed.providerId))
      throw new CliUsageError("Unsupported LLM provider " + parsed.providerId);
    return parsed.modelRef;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    if (error instanceof ModelProviderConfigurationError)
      throw new CliUsageError(
        "Model must be a canonical <provider>:<model> reference",
      );
    throw error;
  }
}

function requireOperator(context: CommandContext): void {
  if (context.principal.kind !== "operator")
    throw new CliUsageError("Model routing overrides are operator-only");
}

function printFindings(context: CommandContext, report: ModelRoutingReport) {
  for (const finding of report.findings)
    context.io.stdout(
      `${finding.severity.toUpperCase()} ${finding.code} ${finding.subject}: ${finding.message}`,
    );
}

async function overrideModel(
  args: string[],
  context: CommandContext,
): Promise<number> {
  requireOperator(context);
  if (
    context.modelRoutingLoader === undefined ||
    context.reloadModelRouting === undefined ||
    context.modelRoutingFile === undefined
  )
    throw new CliUsageError(
      "Model routing mutation is unavailable in this Runtime composition",
    );
  const parsed = parseArguments(
    args,
    new Set(["scope", "project", "agent", "profile", "model"]),
    new Set(["json"]),
  );
  const scope = requiredOption(parsed, "scope");
  if (scope !== "host" && scope !== "project")
    throw new CliUsageError("--scope must be host or project");
  const projectId = parsed.options.get("project");
  if (scope === "project") {
    if (projectId === undefined)
      throw new CliUsageError("--project is required for project scope");
    await context.projects.findById(projectId);
  } else if (projectId !== undefined)
    throw new CliUsageError("--project is only valid with project scope");
  const agent = requiredOption(parsed, "agent");
  if (!modelTokenPattern.test(agent))
    throw new CliUsageError("--agent must be a valid agent name");
  const profile = parsed.options.get("profile");
  const model = parsed.options.get("model");
  if ((profile === undefined) === (model === undefined))
    throw new CliUsageError("Set exactly one of --profile or --model");
  if (profile !== undefined && !modelTokenPattern.test(profile))
    throw new CliUsageError("--profile must be a valid profile key");
  const target =
    profile === undefined
      ? {
          model: modelTarget(
            model!,
            context.modelProviders.supportedProviders(),
          ),
        }
      : { profile };
  const document = routingOverrideDocument(
    routingDocument(context.modelRoutingFile),
    scope,
    projectId,
    agent,
    target,
  );
  const candidate = context.modelRoutingLoader(() => JSON.stringify(document));
  if (candidate.status === "misconfigured")
    throw new CliUsageError(
      "The override would make model routing invalid; no change was written",
    );
  writeRoutingDocument(
    context.modelRoutingFile,
    document,
    context.ids.generate(),
  );
  const reloaded = context.reloadModelRouting();
  await context.audit.execute({
    eventType: "model.routing.override",
    actorType: "daemon",
    actorId: context.principal.id,
    aggregateType: "model_routing",
    ...(scope === "host"
      ? { aggregateId: "host" }
      : { aggregateId: projectId! }),
    ...(scope === "project" ? { projectId: projectId! } : {}),
    payload: {
      scope,
      ...(scope === "project" ? { projectId: projectId! } : {}),
      agent,
      ...target,
      routingStatus: reloaded.status,
    },
  });
  const reloadedSuccessfully = reloaded.status !== "misconfigured";
  const result = {
    schemaVersion: 1,
    scope,
    ...(projectId === undefined ? {} : { projectId }),
    agent,
    ...target,
    routingStatus: reloaded.status,
    reloaded: reloadedSuccessfully,
  };
  context.io.stdout(
    parsed.flags.has("json")
      ? JSON.stringify(result)
      : reloadedSuccessfully
        ? "Model routing override applied for " + agent + "."
        : "Model routing override was written but reload failed: misconfigured.",
  );
  return reloadedSuccessfully ? 0 : 1;
}

async function reloadModel(
  args: string[],
  context: CommandContext,
): Promise<number> {
  requireOperator(context);
  if (context.reloadModelRouting === undefined)
    throw new CliUsageError(
      "Model routing reload is unavailable in this Runtime composition",
    );
  const parsed = parseArguments(args, new Set(), new Set(["json"]));
  const state = context.reloadModelRouting();
  await context.audit.execute({
    eventType: "model.routing.reload",
    actorType: "daemon",
    actorId: context.principal.id,
    aggregateType: "model_routing",
    aggregateId: "host",
    payload: { status: state.status },
  });
  context.io.stdout(
    parsed.flags.has("json")
      ? JSON.stringify({ schemaVersion: 1, status: state.status })
      : "Model routing reloaded: " + state.status,
  );
  return state.status === "misconfigured" ? 1 : 0;
}
/** Read-only model routing inspection; it never sends a model request. */
export async function handleModelCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (command === "agent:models") {
    const parsed = parseArguments(
      args,
      new Set(["project"]),
      new Set(["json"]),
    );
    const report = await describe(context, requiredOption(parsed, "project"));
    const agents = report.project?.agents ?? [];
    if (parsed.flags.has("json")) {
      context.io.stdout(
        JSON.stringify({
          schemaVersion: 1,
          projectId: report.project?.projectId,
          routing: report.status,
          agents,
        }),
      );
      return 0;
    }
    context.io.stdout(`Model routing: ${report.status}`);
    if (agents.length === 0) {
      context.io.stdout("No agents found.");
      return 0;
    }
    context.io.stdout("AGENT\tPOLICY\tPROFILE\tMODEL\tSOURCE\tMAX_COST_MICROS");
    for (const agent of agents)
      context.io.stdout(
        [
          agent.agent,
          dash(agent.policy),
          dash(agent.profile),
          agent.status === "resolved"
            ? agent.modelRef
            : agent.status === "unrouted"
              ? "(executor default)"
              : `(error: ${agent.error?.code ?? "UNKNOWN"})`,
          dash(agent.source),
          dash(agent.maxCostMicros),
        ].join("\t"),
      );
    return 0;
  }
  if (command === "model:check") {
    const parsed = parseArguments(
      args,
      new Set(["project"]),
      new Set(["json"]),
    );
    const report = await describe(
      context,
      parsed.options.get("project") ?? null,
    );
    if (parsed.flags.has("json")) {
      context.io.stdout(JSON.stringify(report));
      return report.valid ? 0 : 1;
    }
    context.io.stdout(`Model routing: ${report.status}`);
    context.io.stdout(
      `Sources: routing file ${report.sources.fileOrigin === "environment" ? "AI_OFFICE_MODEL_ROUTING_FILE override" : report.sources.fileOrigin === "runtime_home" ? "model-routing.yaml in AI_OFFICE_HOME" : "not configured"}; AI_OFFICE_LLM_MODEL ${report.sources.managed ? "ignored (managed service)" : report.sources.legacyEnvironment ? "set" : "not set"}`,
    );
    if (report.status === "unconfigured")
      context.io.stdout(
        "No model routing is configured: runs are scheduled unrouted and the selected executor keeps its own default model.",
      );
    context.io.stdout(`Default profile: ${dash(report.defaultProfile)}`);
    if (report.legacyDefaultModelRef !== null)
      context.io.stdout(`Legacy default: ${report.legacyDefaultModelRef}`);
    for (const profile of report.profiles)
      context.io.stdout(
        `Profile ${profile.key}: ${profile.modelRef}${profile.reasoningEffort === null ? "" : ` reasoning_effort=${profile.reasoningEffort}`}${profile.maxOutputTokens === null ? "" : ` max_output_tokens=${profile.maxOutputTokens}`}`,
      );
    for (const policy of report.policies)
      context.io.stdout(`Policy ${policy.policy} -> ${policy.profile}`);
    for (const override of report.agentOverrides)
      context.io.stdout(
        `Agent override (${override.scope === "host" ? "host-global, every project" : `project ${override.projectId}`}) ${override.agent} -> ${override.profile === null ? override.modelRef : `profile ${override.profile}`}`,
      );
    if (report.providers.some((provider) => provider.gatewayExecution))
      context.io.stdout(
        `Provider credentials: ${report.credentialSource === "managed" ? "credentials directory in AI_OFFICE_HOME only (managed service)" : "Runtime environment only (foreground; the credentials directory in AI_OFFICE_HOME is not read)"}`,
      );
    for (const provider of report.providers) {
      context.io.stdout(
        `Provider ${provider.providerId}: ${provider.gatewayExecution ? `gateway-executable (run:tick --worker gateway)${provider.missingCredentials.length === 0 ? "" : `; missing ${provider.missingCredentials.join(", ")}`}` : "not gateway-executable; needs a client worker that supports it"}`,
      );
      // Presence by logical name only; never a value, length or path.
      for (const credential of provider.credentials)
        context.io.stdout(
          `  ${credential.name}: ${credential.state}${credential.origin === null ? "" : ` (${credential.origin})`}${credential.issue === null ? "" : ` ${credential.issue}`}`,
        );
    }
    for (const agent of report.project?.agents ?? [])
      context.io.stdout(
        `Agent ${agent.agent}: ${agent.status === "resolved" ? `${agent.modelRef} (${agent.source})` : agent.status === "unrouted" ? "unrouted" : `error ${agent.error?.code ?? "UNKNOWN"}`}`,
      );
    printFindings(context, report);
    context.io.stdout(
      report.valid
        ? "Model routing is valid. No model request was sent."
        : "Model routing is invalid; scheduling affected runs fails closed. No model request was sent.",
    );
    return report.valid ? 0 : 1;
  }
  if (command === "model:override") return overrideModel(args, context);
  if (command === "model:reload") return reloadModel(args, context);
  return null;
}

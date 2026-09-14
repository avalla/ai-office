import {
  DescribeModelRouting,
  type ModelRoutingReport,
} from "@ai-office/application/model-routing/describe-model-routing.ts";
import {
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

function printFindings(context: CommandContext, report: ModelRoutingReport) {
  for (const finding of report.findings)
    context.io.stdout(
      `${finding.severity.toUpperCase()} ${finding.code} ${finding.subject}: ${finding.message}`,
    );
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
        `Provider credentials: ${report.credentialSource === "managed" ? "credentials directory in AI_OFFICE_HOME only (managed service)" : "Runtime environment, then credentials directory in AI_OFFICE_HOME"}`,
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
  return null;
}

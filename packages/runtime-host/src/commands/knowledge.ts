import {
  ManageKnowledgeAdmission,
  type KnowledgeAdmissionKind,
} from "@ai-office/application/agent-knowledge/manage-knowledge-admission.ts";
import { ImportLegacyKnowledge } from "@ai-office/application/agent-knowledge/import-legacy-knowledge.ts";
import {
  CliUsageError,
  parseArguments,
  requiredOption,
  type CommandContext,
} from "./shared.ts";

function kind(value: string): KnowledgeAdmissionKind {
  if (value !== "memory" && value !== "decision")
    throw new CliUsageError("Knowledge kind must be memory or decision");
  return value;
}

export async function handleKnowledgeCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (!command.startsWith("knowledge:")) return null;
  const service = new ManageKnowledgeAdmission(
    context.projects,
    context.tasks,
    context.runtime,
    context.repositoryIdentities,
    context.agentKnowledge ?? { state: "disabled" },
    context.audit,
    context.clock,
  );
  if (
    command === "knowledge:legacy-plan" ||
    command === "knowledge:legacy-import"
  ) {
    const parsed = parseArguments(
      args,
      new Set(["project", "scope", "approve", "actor"]),
    );
    const importer = new ImportLegacyKnowledge(
      context.projects,
      context.repositoryIdentities,
      context.legacyMemory,
      context.agentKnowledge ?? { state: "disabled" },
      context.audit,
      context.clock,
    );
    const projectId = requiredOption(parsed, "project");
    const sourceScope = requiredOption(parsed, "scope");
    if (command === "knowledge:legacy-plan") {
      if (parsed.options.has("approve") || parsed.options.has("actor"))
        throw new CliUsageError(
          "Approval options are only accepted by knowledge:legacy-import",
        );
      context.io.stdout(
        JSON.stringify(await importer.plan(projectId, sourceScope)),
      );
    } else {
      context.io.stdout(
        JSON.stringify(
          await importer.import({
            projectId,
            sourceScope,
            approval: requiredOption(parsed, "approve"),
            reviewedBy: requiredOption(parsed, "actor"),
          }),
        ),
      );
    }
    return 0;
  }
  if (command === "knowledge:trace") {
    const parsed = parseArguments(args, new Set(["project", "kind", "id"]));
    const trace = await service.trace(
      requiredOption(parsed, "project"),
      kind(requiredOption(parsed, "kind")),
      requiredOption(parsed, "id"),
    );
    context.io.stdout(JSON.stringify({ schemaVersion: 1, provenance: trace }));
    return 0;
  }
  if (command === "knowledge:plan" || command === "knowledge:admit") {
    const parsed = parseArguments(
      args,
      new Set(["project", "run", "kind", "title", "text", "approve", "actor"]),
    );
    const input = {
      projectId: requiredOption(parsed, "project"),
      runId: requiredOption(parsed, "run"),
      kind: kind(requiredOption(parsed, "kind")),
      text: requiredOption(parsed, "text"),
      ...(parsed.options.get("title") === undefined
        ? {}
        : { title: parsed.options.get("title")! }),
    };
    if (command === "knowledge:plan") {
      if (parsed.options.has("approve") || parsed.options.has("actor"))
        throw new CliUsageError(
          "Approval options are only accepted by knowledge:admit",
        );
      context.io.stdout(JSON.stringify(await service.plan(input)));
      return 0;
    }
    const plan = await service.admit({
      ...input,
      approval: requiredOption(parsed, "approve"),
      reviewedBy: requiredOption(parsed, "actor"),
    });
    context.io.stdout(
      JSON.stringify({
        schemaVersion: 1,
        id: plan.id,
        kind: plan.kind,
        planHash: plan.planHash,
        outcome: plan.outcome,
      }),
    );
    return 0;
  }
  return null;
}

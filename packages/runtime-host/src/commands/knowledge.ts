import {
  ManageKnowledgeAdmission,
  type KnowledgeAdmissionKind,
  type KnowledgeAdmissionSourceInput,
} from "@ai-office/application/agent-knowledge/manage-knowledge-admission.ts";
import {
  isKnowledgeIdentifier,
  knowledgeRetrievalLimits,
  type SearchKnowledgeHit,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import {
  CliUsageError,
  parseArguments,
  requiredOption,
  type CommandContext,
  type ParsedArguments,
} from "./shared.ts";

function kind(value: string): KnowledgeAdmissionKind {
  if (value !== "memory" && value !== "decision")
    throw new CliUsageError("Knowledge kind must be memory or decision");
  return value;
}

/** Bounded prefix reported as the hit excerpt; the full text stays in the store. */
function excerpt(text: string): string {
  const characters = [...text];
  return characters.length <= knowledgeRetrievalLimits.excerptCharacters
    ? text
    : `${characters.slice(0, knowledgeRetrievalLimits.excerptCharacters).join("")}…`;
}

function taskHitOutput(hit: SearchKnowledgeHit) {
  return {
    id: hit.id,
    kind: hit.kind,
    title: hit.title,
    excerpt: excerpt(hit.text),
    createdAt: hit.createdAt.toISOString(),
    runId: hit.runId,
  };
}

const sourceOptions = {
  "agent-run": ["run"],
  handover: ["handover"],
  "operator-confirmed": ["confirmed-by", "evidence"],
} as const;

/**
 * The source is selected explicitly; `--run` alone keeps meaning a run. An
 * option that belongs to another source is a usage error, never ignored, so a
 * plan cannot silently carry provenance its reviewer did not select.
 */
function admissionSource(
  parsed: ParsedArguments,
): KnowledgeAdmissionSourceInput {
  const selected = parsed.options.get("source") ?? "agent-run";
  if (!Object.hasOwn(sourceOptions, selected))
    throw new CliUsageError(
      "Knowledge source must be agent-run, handover, or operator-confirmed",
    );
  const kind = selected as keyof typeof sourceOptions;
  for (const [other, names] of Object.entries(sourceOptions))
    for (const name of names)
      if (other !== kind && parsed.options.has(name))
        throw new CliUsageError(
          `Option --${name} is not accepted with --source ${kind}`,
        );
  if (kind === "agent-run")
    return { kind: "agent_run", runId: requiredOption(parsed, "run") };
  if (kind === "handover")
    return {
      kind: "handover",
      confirmationId: requiredOption(parsed, "handover"),
    };
  return {
    kind: "operator_confirmed",
    confirmedBy: requiredOption(parsed, "confirmed-by"),
    evidence: requiredOption(parsed, "evidence")
      .split(",")
      .map((reference) => {
        const separator = reference.indexOf(":");
        if (separator < 1 || separator === reference.length - 1)
          throw new CliUsageError(
            "Knowledge evidence must be a comma-separated list of <kind>:<id>",
          );
        return {
          kind: reference.slice(0, separator),
          id: reference.slice(separator + 1),
        };
      }),
  };
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
    context.profiles,
    context.governance,
  );
  if (command === "knowledge:trace") {
    const parsed = parseArguments(args, new Set(["project", "kind", "id"]));
    const explanation = await service.explain(
      requiredOption(parsed, "project"),
      kind(requiredOption(parsed, "kind")),
      requiredOption(parsed, "id"),
    );
    context.io.stdout(
      JSON.stringify({
        schemaVersion: 1,
        provenance: explanation?.provenance ?? null,
        admissionSource: explanation?.admissionSource ?? null,
        admission: explanation?.admission ?? null,
      }),
    );
    return 0;
  }
  if (command === "knowledge:search") {
    const parsed = parseArguments(
      args,
      new Set(["project", "query", "limit", "agent"]),
    );
    // An unquoted multi-word query would otherwise search only its first word
    // and report a false "no duplicate".
    if (parsed.positionals.length > 0)
      throw new CliUsageError(
        "knowledge:search only accepts named options; quote a multi-word --query",
      );
    const limit = parsed.options.get("limit");
    const maxLimit = knowledgeRetrievalLimits.maxResults;
    if (
      limit !== undefined &&
      (!/^[1-9]\d*$/u.test(limit) || Number(limit) > maxLimit)
    )
      throw new CliUsageError(`Knowledge search limit must be 1 to ${maxLimit}`);
    const agentId = parsed.options.get("agent");
    const hits = await service.search({
      projectId: requiredOption(parsed, "project"),
      text: requiredOption(parsed, "query"),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
      ...(agentId === undefined ? {} : { agentId }),
    });
    context.io.stdout(
      JSON.stringify({
        schemaVersion: 1,
        hits: hits.map((hit) => ({
          id: hit.id,
          kind: hit.kind,
          title: hit.title,
          text: hit.text,
          agentId: hit.agentId,
          runId: hit.runId,
          taskId: hit.taskId,
          source: hit.source,
          createdAt: hit.createdAt.toISOString(),
          legacy: "legacy" in hit,
          provenanceKind:
            "legacy" in hit
              ? "legacy_import"
              : hit.runId === null
                ? hit.provenance.kind
                : "agent_run",
        })),
      }),
    );
    return 0;
  }
  if (command === "knowledge:task") {
    const parsed = parseArguments(args, new Set(["project", "task", "limit"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError(
        "knowledge:task only accepts named options",
      );
    // Usage is caller context, so it is validated before any store state:
    // a non-connected store is reported in the output, not as a refusal.
    const projectId = requiredOption(parsed, "project");
    const taskId = requiredOption(parsed, "task");
    if (!isKnowledgeIdentifier(taskId))
      throw new CliUsageError("Knowledge task id is invalid");
    const limit = parsed.options.get("limit");
    const maxLimit = knowledgeRetrievalLimits.maxResults;
    if (
      limit !== undefined &&
      (!/^[1-9]\d*$/u.test(limit) || Number(limit) > maxLimit)
    )
      throw new CliUsageError(`Knowledge task limit must be 1 to ${maxLimit}`);
    const knowledge = context.agentKnowledge ?? { state: "disabled" as const };
    if (knowledge.state !== "connected") {
      // The state field is the contract that lets a caller tell "the store
      // is not usable" apart from "the store is usable and returned no
      // hits"; misconfigured and unavailable carry only the typed code.
      context.io.stdout(
        JSON.stringify({
          schemaVersion: 1,
          state: knowledge.state,
          ...(knowledge.state === "disabled"
            ? {}
            : { error: knowledge.error.message }),
          hits: [],
        }),
      );
      return 0;
    }
    const hits = await service.taskKnowledge({
      projectId,
      taskId,
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
    context.io.stdout(
      JSON.stringify({
        schemaVersion: 1,
        state: "connected",
        hits: hits.map(taskHitOutput),
      }),
    );
    return 0;
  }
  if (command === "knowledge:plan" || command === "knowledge:admit") {
    const parsed = parseArguments(
      args,
      new Set([
        "project",
        "source",
        "run",
        "handover",
        "confirmed-by",
        "evidence",
        "kind",
        "title",
        "text",
        "approve",
        "actor",
      ]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError(`${command} only accepts named options`);
    const input = {
      projectId: requiredOption(parsed, "project"),
      source: admissionSource(parsed),
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
        provenanceKind: plan.provenance.kind,
        outcome: plan.outcome,
      }),
    );
    return 0;
  }
  return null;
}

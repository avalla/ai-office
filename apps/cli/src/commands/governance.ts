import { join } from "node:path";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import { renderGovernanceMarkdown } from "@ai-office/application/queries/render-governance-markdown.ts";
import { writeTextFileAtomic } from "../atomic-file.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

export async function handleGovernanceCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const { projects, governance, ids, clock, io } = context;
  const service = new ManageGovernance(projects, governance, ids, clock);
  if (command === "milestone:create") {
    const parsed = parseArguments(
      args,
      new Set(["project", "title", "description"]),
    );
    const id = await service.createMilestone({
      projectId: requiredOption(parsed, "project"),
      title: requiredOption(parsed, "title"),
      ...(parsed.options.get("description") === undefined
        ? {}
        : { description: parsed.options.get("description")! }),
    });
    io.stdout(`Milestone created: ${id}`);
    return 0;
  }
  if (command === "requirement:create") {
    const parsed = parseArguments(
      args,
      new Set(["project", "key", "title", "description", "milestone"]),
    );
    const id = await service.createRequirement({
      projectId: requiredOption(parsed, "project"),
      key: requiredOption(parsed, "key"),
      title: requiredOption(parsed, "title"),
      description: requiredOption(parsed, "description"),
      ...(parsed.options.get("milestone") === undefined
        ? {}
        : { milestoneId: parsed.options.get("milestone")! }),
    });
    io.stdout(`Requirement created: ${id}`);
    return 0;
  }
  if (command === "adr:create") {
    const parsed = parseArguments(
      args,
      new Set(["project", "title", "context", "decision", "consequences"]),
    );
    const id = await service.createAdr({
      projectId: requiredOption(parsed, "project"),
      title: requiredOption(parsed, "title"),
      context: requiredOption(parsed, "context"),
      decision: requiredOption(parsed, "decision"),
      consequences: requiredOption(parsed, "consequences"),
    });
    io.stdout(`ADR created: ${id}`);
    return 0;
  }
  if (command === "milestone:set-status") {
    const parsed = parseArguments(
      args,
      new Set(["project", "milestone", "status"]),
    );
    const status = requiredOption(parsed, "status");
    if (!["planned", "active", "completed", "cancelled"].includes(status))
      throw new CliUsageError("Invalid milestone status");
    await service.setStatus({
      projectId: requiredOption(parsed, "project"),
      kind: "milestone",
      id: requiredOption(parsed, "milestone"),
      status: status as "planned" | "active" | "completed" | "cancelled",
    });
    io.stdout(`milestone status updated: ${status}`);
    return 0;
  }
  if (command === "requirement:set-status") {
    const parsed = parseArguments(
      args,
      new Set(["project", "requirement", "status"]),
    );
    const status = requiredOption(parsed, "status");
    if (
      !["proposed", "accepted", "implemented", "verified", "rejected"].includes(
        status,
      )
    )
      throw new CliUsageError("Invalid requirement status");
    await service.setStatus({
      projectId: requiredOption(parsed, "project"),
      kind: "requirement",
      id: requiredOption(parsed, "requirement"),
      status: status as
        "proposed" | "accepted" | "implemented" | "verified" | "rejected",
    });
    io.stdout(`requirement status updated: ${status}`);
    return 0;
  }
  if (command === "adr:set-status") {
    const parsed = parseArguments(args, new Set(["project", "adr", "status"]));
    const status = requiredOption(parsed, "status");
    if (
      ![
        "proposed",
        "accepted",
        "rejected",
        "deprecated",
        "superseded",
      ].includes(status)
    )
      throw new CliUsageError("Invalid adr status");
    await service.setStatus({
      projectId: requiredOption(parsed, "project"),
      kind: "adr",
      id: requiredOption(parsed, "adr"),
      status: status as
        "proposed" | "accepted" | "rejected" | "deprecated" | "superseded",
    });
    io.stdout(`adr status updated: ${status}`);
    return 0;
  }
  if (command === "review:create") {
    const parsed = parseArguments(
      args,
      new Set(["project", "subject-type", "subject", "reviewer"]),
    );
    const type = requiredOption(parsed, "subject-type");
    if (
      !["task", "agent_run", "requirement", "adr", "milestone"].includes(type)
    )
      throw new CliUsageError("Invalid review subject type");
    const reviewer = requiredOption(parsed, "reviewer");
    const id = await service.createReview({
      projectId: requiredOption(parsed, "project"),
      subjectType: type as
        "task" | "agent_run" | "requirement" | "adr" | "milestone",
      subjectId: requiredOption(parsed, "subject"),
      reviewer: { type: "user", id: reviewer, displayName: reviewer },
    });
    io.stdout(`Review created: ${id}`);
    return 0;
  }
  if (command === "review:decide") {
    const parsed = parseArguments(
      args,
      new Set(["project", "review", "actor", "decision", "rationale"]),
    );
    const decision = requiredOption(parsed, "decision");
    if (decision !== "approved" && decision !== "rejected")
      throw new CliUsageError("Decision must be approved or rejected");
    const actor = requiredOption(parsed, "actor");
    const id = await service.approve({
      projectId: requiredOption(parsed, "project"),
      reviewId: requiredOption(parsed, "review"),
      actor: { type: "user", id: actor, displayName: actor },
      decision,
      ...(parsed.options.get("rationale") === undefined
        ? {}
        : { rationale: parsed.options.get("rationale")! }),
    });
    io.stdout(`Review decision saved: ${id}`);
    return 0;
  }
  if (command === "governance:profile" || command === "governance:export") {
    const parsed = parseArguments(args, new Set(["project"]));
    const projectId = requiredOption(parsed, "project");
    const project = await projects.findById(projectId);
    if (project === null) throw new ProjectNotFoundError(projectId);
    const markdown = renderGovernanceMarkdown(
      project.snapshot().name,
      await governance.getSnapshot(projectId),
    );
    if (command === "governance:profile") {
      io.stdout(markdown.trimEnd());
      return 0;
    }
    const outputPath = join(
      context.projectRoot,
      ".ai-office",
      "generated",
      "governance.md",
    );
    writeTextFileAtomic(outputPath, markdown);
    io.stdout(`Governance exported: ${outputPath}`);
    return 0;
  }
  return null;
}

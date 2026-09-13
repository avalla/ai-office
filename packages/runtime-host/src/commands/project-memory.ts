import { DescribeProjectMemory } from "@ai-office/application/project-memory/describe-project-memory.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
} from "./shared.ts";

export async function handleProjectMemoryCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (command !== "project-memory:status") return null;
  const parsed = parseArguments(
    args,
    new Set(["project"]),
    new Set(["probe", "json"]),
  );
  const projectId = parsed.options.get("project") ?? null;
  if (
    projectId !== null &&
    (await context.projects.findById(projectId)) === null
  )
    throw new CliUsageError("Project not found");
  const report = await new DescribeProjectMemory(
    context.projectMemory,
    context.repositoryIdentities,
    context.projectMemoryProvenance,
  ).execute({ projectId, probe: parsed.flags.has("probe") });
  if (parsed.flags.has("json")) {
    context.io.stdout(JSON.stringify(report));
    return 0;
  }
  context.io.stdout(`Project memory provider: ${report.provider}`);
  context.io.stdout(
    `State: ${report.state}${report.probed ? " (probed)" : ""}`,
  );
  if (report.version !== null)
    context.io.stdout(`Server version: ${report.version}`);
  if (report.code !== null) context.io.stdout(`Code: ${report.code}`);
  context.io.stdout(report.message);
  if (report.project !== null) {
    context.io.stdout(
      `Memory identity: ${report.project.memoryProjectId ?? "unavailable (no portable repository identity)"}`,
    );
    const last = report.project.lastRetrieval;
    context.io.stdout(
      last === null
        ? "Last retrieval: none recorded"
        : `Last retrieval: ${last.outcome}${last.errorCode === null ? "" : ` (${last.errorCode})`}, ${last.injectedCount}/${last.resultCount} injected, run ${last.runId} at ${last.createdAt}`,
    );
  }
  context.io.stdout(
    "Project memory is advisory context only; it never changes project authority.",
  );
  return 0;
}

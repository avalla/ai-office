import { join } from "node:path";
import { AnswerProjectQuestion } from "@ai-office/application/commands/answer-project-question.ts";
import { CreateProject } from "@ai-office/application/commands/create-project.ts";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { GetProjectProfile } from "@ai-office/application/queries/get-project-profile.ts";
import { renderProjectProfileMarkdown } from "@ai-office/application/queries/render-project-profile-markdown.ts";
import { writeTextFileAtomic } from "../atomic-file.ts";
import { LocalProjectScanner } from "../local-project-scanner.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

export async function handleProjectCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const {
    projects,
    profiles,
    ids,
    clock,
    transactions,
    io,
  } = context;
  if (command === "project:create") {
    const parsed = parseArguments(
      args,
      new Set(["description"]),
      new Set(["json"]),
    );
    if (parsed.positionals.length !== 1)
      throw new CliUsageError(
        "project:create requires exactly one project name",
      );
    const name = parsed.positionals[0];
    if (name === undefined)
      throw new CliUsageError(
        "project:create requires exactly one project name",
      );
    const description = parsed.options.get("description");
    const id = await new CreateProject(projects, ids, clock).execute({
      name,
      ...(description === undefined ? {} : { description }),
    });
    io.stdout(
      parsed.flags.has("json")
        ? JSON.stringify({ projectId: id, created: true })
        : `Project created: ${id}`,
    );
    return 0;
  }
  if (command === "project:import") {
    const parsed = parseArguments(args, new Set(["name"]), new Set(["json"]));
    if (parsed.positionals.length > 1)
      throw new CliUsageError("project:import accepts at most one path");
    const result = await new ImportProject(
      projects,
      profiles,
      new LocalProjectScanner(),
      ids,
      clock,
      transactions,
    ).execute({
      rootPath: parsed.positionals[0] ?? context.projectRoot,
      ...(parsed.options.get("name") === undefined
        ? {}
        : { name: parsed.options.get("name")! }),
    });
    if (parsed.flags.has("json")) {
      io.stdout(
        JSON.stringify({
          projectId: result.projectId,
          created: result.created,
          scan: result.scan,
        }),
      );
      return 0;
    }
    io.stdout(
      result.created
        ? `Project imported: ${result.projectId}`
        : `Project already imported: ${result.projectId}`,
    );
    io.stdout(`Path: ${result.scan.rootPath}`);
    io.stdout(
      `Languages: ${result.scan.languages.join(", ") || "not detected"}`,
    );
    io.stdout(
      `Frameworks: ${result.scan.frameworks.join(", ") || "not detected"}`,
    );
    io.stdout(`Testing: ${result.scan.testing.join(", ") || "not detected"}`);
    io.stdout(
      "Repository scan completed offline; use the ai-office skill for conversational onboarding.",
    );
    return 0;
  }
  if (command === "project:answer") {
    const parsed = parseArguments(
      args,
      new Set(["project", "question", "answer"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError("project:answer only accepts named options");
    const projectId = requiredOption(parsed, "project");
    const questionId = requiredOption(parsed, "question");
    const answer = await new AnswerProjectQuestion(
      profiles,
      ids,
      clock,
      transactions,
    ).execute({
      projectId,
      questionId,
      value: requiredOption(parsed, "answer"),
    });
    io.stdout(`Answer saved: ${questionId} (${answer.category})`);
    return 0;
  }
  if (command === "project:profile" || command === "project:export") {
    const parsed = parseArguments(args, new Set(["project"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError(`${command} only accepts named options`);
    const profile = await new GetProjectProfile(projects, profiles).execute(
      requiredOption(parsed, "project"),
    );
    const markdown = renderProjectProfileMarkdown(profile);
    if (command === "project:profile") {
      io.stdout(markdown.trimEnd());
      return 0;
    }
    const outputPath = join(
      context.runtimeHome,
      "generated",
      "project-profile.md",
    );
    writeTextFileAtomic(outputPath, markdown);
    io.stdout(`Project profile exported: ${outputPath}`);
    return 0;
  }
  return null;
}

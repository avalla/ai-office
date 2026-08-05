import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AnswerProjectQuestion } from "@ai-office/application/commands/answer-project-question.ts";
import { CreateProject } from "@ai-office/application/commands/create-project.ts";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import {
  InvalidProjectAnswerError,
  ProjectNotFoundError,
  ProjectQuestionAlreadyAnsweredError,
  ProjectQuestionNotFoundError
} from "@ai-office/application/errors.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { ListTasks } from "@ai-office/application/queries/list-tasks.ts";
import { GetProjectProfile } from "@ai-office/application/queries/get-project-profile.ts";
import { renderProjectProfileMarkdown } from "@ai-office/application/queries/render-project-profile-markdown.ts";
import { agentOperations } from "@ai-office/domain/project/project-profile.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { LocalProjectScanner } from "./local-project-scanner.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";

export const cliHelp = `AI Office CLI

Commands:
  daemon:health
  project:create <name> [--description <description>]
  project:import [path] [--name <name>]
  project:onboard --project <id>
  project:answer --project <id> --question <id> --answer <value>
  project:profile --project <id>
  project:export --project <id>
  task:create --project <id> --title <title> [--description <description>] [--priority <integer>]
  task:list --project <id>`;

const commands = [
  "project:create",
  "project:import",
  "project:onboard",
  "project:answer",
  "project:profile",
  "project:export",
  "task:create",
  "task:list"
] as const;
type Command = (typeof commands)[number];
const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
  prompt?(message: string): Promise<string>;
}

export interface CliOptions {
  projectRoot: string;
  migrationDirectory?: string;
  io?: CliIo;
  propagatePromptRequired?: boolean;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliPromptRequiredError extends Error {
  constructor(readonly prompt: string) {
    super("CLI input is required");
    this.name = "CliPromptRequiredError";
  }
}

interface ParsedArguments {
  positionals: string[];
  options: ReadonlyMap<string, string>;
}

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message)
};

function parseArguments(args: string[], allowedOptions: ReadonlySet<string>): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === undefined) continue;

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const name = argument.slice(2);
    if (!allowedOptions.has(name)) {
      throw new CliUsageError(`Unknown option --${name}`);
    }
    if (options.has(name)) {
      throw new CliUsageError(`Option --${name} can only be provided once`);
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`Option --${name} requires a value`);
    }

    options.set(name, value);
    index += 1;
  }

  return { positionals, options };
}

function requiredOption(arguments_: ParsedArguments, name: string): string {
  const value = arguments_.options.get(name);
  if (value === undefined) {
    throw new CliUsageError(`Missing required option --${name}`);
  }
  return value;
}

function formatKnownError(error: unknown): string | null {
  if (
    error instanceof CliUsageError ||
    error instanceof DomainValidationError ||
    error instanceof ProjectNotFoundError ||
    error instanceof ProjectQuestionNotFoundError ||
    error instanceof ProjectQuestionAlreadyAnsweredError ||
    error instanceof InvalidProjectAnswerError
  ) {
    return error.message;
  }

  return null;
}

function isCommand(value: string): value is Command {
  return commands.some((command) => command === value);
}

export async function runCli(args: string[], options: CliOptions): Promise<number> {
  const io = options.io ?? defaultIo;
  const [command, ...commandArguments] = args;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.stdout(cliHelp);
    return 0;
  }

  if (!isCommand(command)) {
    io.stderr(`Unknown command: ${command}\n\n${cliHelp}`);
    return 1;
  }

  const databasePath = join(options.projectRoot, ".ai-office", "project.sqlite");
  const migrationDirectory =
    options.migrationDirectory ??
    join(sourceDirectory, "..", "..", "..", "migrations", "project");
  const database = openDatabase(databasePath);

  try {
    migrate(database, migrationDirectory);

    const projects = new SqliteProjectRepository(database);
    const profiles = new SqliteProjectProfileRepository(database);
    const tasks = new SqliteTaskRepository(database);
    const ids = new CryptoIdGenerator();
    const clock = new SystemClock();
    const transactions = new SqliteTransactionRunner(database);

    switch (command) {
      case "project:create": {
        const parsed = parseArguments(commandArguments, new Set(["description"]));
        if (parsed.positionals.length !== 1) {
          throw new CliUsageError("project:create requires exactly one project name");
        }

        const name = parsed.positionals[0];
        if (name === undefined) {
          throw new CliUsageError("project:create requires exactly one project name");
        }

        const createProject = new CreateProject(projects, ids, clock);
        const description = parsed.options.get("description");
        const projectId = await createProject.execute({
          name,
          ...(description === undefined ? {} : { description })
        });

        io.stdout(`Project created: ${projectId}`);
        return 0;
      }

      case "project:import": {
        const parsed = parseArguments(commandArguments, new Set(["name"]));
        if (parsed.positionals.length > 1) {
          throw new CliUsageError("project:import accepts at most one path");
        }

        const rootPath = parsed.positionals[0] ?? options.projectRoot;
        const importProject = new ImportProject(
          projects,
          profiles,
          new LocalProjectScanner(),
          ids,
          clock,
          transactions
        );
        const result = await importProject.execute({
          rootPath,
          ...(parsed.options.get("name") === undefined
            ? {}
            : { name: parsed.options.get("name")! })
        });

        io.stdout(
          result.created
            ? `Project imported: ${result.projectId}`
            : `Project already imported: ${result.projectId}`
        );
        io.stdout(`Path: ${result.scan.rootPath}`);
        io.stdout(`Languages: ${result.scan.languages.join(", ") || "not detected"}`);
        io.stdout(`Frameworks: ${result.scan.frameworks.join(", ") || "not detected"}`);
        io.stdout(`Testing: ${result.scan.testing.join(", ") || "not detected"}`);
        io.stdout("Onboarding questions:");
        for (const question of result.questions) {
          io.stdout(`- ${question}`);
        }
        return 0;
      }

      case "project:onboard": {
        const parsed = parseArguments(commandArguments, new Set(["project"]));
        if (parsed.positionals.length > 0) {
          throw new CliUsageError("project:onboard only accepts named options");
        }

        const projectId = requiredOption(parsed, "project");
        const profile = await new GetProjectProfile(projects, profiles).execute(projectId);
        if (profile.openQuestions.length === 0) {
          io.stdout(`No open onboarding questions for project ${projectId}.`);
          return 0;
        }

        const reader = io.prompt === undefined
          ? createInterface({ input: process.stdin, output: process.stdout })
          : undefined;
        const prompt = io.prompt ?? ((message: string) => reader!.question(message));
        const answerQuestion = new AnswerProjectQuestion(
          profiles,
          ids,
          clock,
          transactions
        );

        try {
          for (const question of profile.openQuestions) {
            io.stdout(`[${question.answerCategory}] ${question.question}`);
            if (question.answerCategory === "permission") {
              io.stdout(`Supported operations: ${agentOperations.join(", ")}`);
              io.stdout('Use a comma-separated list, "all", or "none".');
            }
            const value = await prompt("> ");
            await answerQuestion.execute({ projectId, questionId: question.id, value });
            io.stdout(`Answer saved: ${question.id}`);
          }
        } finally {
          reader?.close();
        }

        return 0;
      }

      case "project:answer": {
        const parsed = parseArguments(
          commandArguments,
          new Set(["project", "question", "answer"])
        );
        if (parsed.positionals.length > 0) {
          throw new CliUsageError("project:answer only accepts named options");
        }

        const projectId = requiredOption(parsed, "project");
        const questionId = requiredOption(parsed, "question");
        const answer = await new AnswerProjectQuestion(
          profiles,
          ids,
          clock,
          transactions
        ).execute({
          projectId,
          questionId,
          value: requiredOption(parsed, "answer")
        });
        io.stdout(`Answer saved: ${questionId} (${answer.category})`);
        return 0;
      }

      case "project:profile": {
        const parsed = parseArguments(commandArguments, new Set(["project"]));
        if (parsed.positionals.length > 0) {
          throw new CliUsageError("project:profile only accepts named options");
        }

        const profile = await new GetProjectProfile(projects, profiles).execute(
          requiredOption(parsed, "project")
        );
        io.stdout(renderProjectProfileMarkdown(profile).trimEnd());
        return 0;
      }

      case "project:export": {
        const parsed = parseArguments(commandArguments, new Set(["project"]));
        if (parsed.positionals.length > 0) {
          throw new CliUsageError("project:export only accepts named options");
        }

        const profile = await new GetProjectProfile(projects, profiles).execute(
          requiredOption(parsed, "project")
        );
        const outputPath = join(
          options.projectRoot,
          ".ai-office",
          "generated",
          "project-profile.md"
        );
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, renderProjectProfileMarkdown(profile), "utf8");
        io.stdout(`Project profile exported: ${outputPath}`);
        return 0;
      }

      case "task:create": {
        const parsed = parseArguments(
          commandArguments,
          new Set(["project", "title", "description", "priority"])
        );
        if (parsed.positionals.length > 0) {
          throw new CliUsageError("task:create only accepts named options");
        }

        const priorityValue = parsed.options.get("priority");
        const priority = priorityValue === undefined ? undefined : Number(priorityValue);
        const description = parsed.options.get("description");
        const createTask = new CreateTask(projects, tasks, ids, clock);
        const taskId = await createTask.execute({
          projectId: requiredOption(parsed, "project"),
          title: requiredOption(parsed, "title"),
          ...(description === undefined ? {} : { description }),
          ...(priority === undefined ? {} : { priority })
        });

        io.stdout(`Task created: ${taskId}`);
        return 0;
      }

      case "task:list": {
        const parsed = parseArguments(commandArguments, new Set(["project"]));
        if (parsed.positionals.length > 0) {
          throw new CliUsageError("task:list only accepts named options");
        }

        const projectId = requiredOption(parsed, "project");
        const listedTasks = await new ListTasks(tasks).execute(projectId);

        if (listedTasks.length === 0) {
          io.stdout(`No tasks found for project ${projectId}.`);
          return 0;
        }

        io.stdout("ID\tSTATUS\tPRIORITY\tTITLE");
        for (const task of listedTasks) {
          io.stdout(`${task.id}\t${task.status}\t${task.priority}\t${task.title}`);
        }
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof CliPromptRequiredError && options.propagatePromptRequired === true) {
      throw error;
    }

    const message = formatKnownError(error);
    if (message !== null) {
      io.stderr(message);
      return 1;
    }

    io.stderr("AI Office failed because of an unexpected error.");
    return 1;
  } finally {
    database.close();
  }
}

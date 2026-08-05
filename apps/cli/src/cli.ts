import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateProject } from "@ai-office/application/commands/create-project.ts";
import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { ListTasks } from "@ai-office/application/queries/list-tasks.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";

const help = `AI Office CLI

Commands:
  project:create <name> [--description <description>]
  task:create --project <id> --title <title> [--description <description>] [--priority <integer>]
  task:list --project <id>`;

const commands = ["project:create", "task:create", "task:list"] as const;
type Command = (typeof commands)[number];
const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliOptions {
  projectRoot: string;
  migrationDirectory?: string;
  io?: CliIo;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
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
    error instanceof ProjectNotFoundError
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
    io.stdout(help);
    return 0;
  }

  if (!isCommand(command)) {
    io.stderr(`Unknown command: ${command}\n\n${help}`);
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
    const tasks = new SqliteTaskRepository(database);
    const ids = new CryptoIdGenerator();
    const clock = new SystemClock();

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

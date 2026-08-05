import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AnswerProjectQuestion } from "@ai-office/application/commands/answer-project-question.ts";
import { CreateProject } from "@ai-office/application/commands/create-project.ts";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import { SyncAgentDefinitions } from "@ai-office/application/commands/sync-agent-definitions.ts";
import {
  ScheduleAgentRun,
  AgentNotFoundError,
  TaskLockedError,
  TaskNotFoundError,
} from "@ai-office/application/commands/schedule-agent-run.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import {
  InvalidProjectAnswerError,
  ProjectNotFoundError,
  ProjectQuestionAlreadyAnsweredError,
  ProjectQuestionNotFoundError,
} from "@ai-office/application/errors.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { ListTasks } from "@ai-office/application/queries/list-tasks.ts";
import { GetProjectProfile } from "@ai-office/application/queries/get-project-profile.ts";
import { renderProjectProfileMarkdown } from "@ai-office/application/queries/render-project-profile-markdown.ts";
import { renderGovernanceMarkdown } from "@ai-office/application/queries/render-governance-markdown.ts";
import { YamlAgentDefinitionLoader } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";
import { SimulatedAgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import { agentOperations } from "@ai-office/domain/project/project-profile.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { LocalProjectScanner } from "./local-project-scanner.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteCostRepository } from "@ai-office/storage-sqlite/repositories/sqlite-cost.repository.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";

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
  task:list --project <id>
  agent:sync --project <id> [--directory <path>]
  agent:list --project <id>
  run:schedule --project <id> --task <id> --agent <id>
  run:tick --project <id> [--capacity <integer>]
  run:list --project <id>
  pricing:set --provider <id> --model <id> --currency <USD|EUR> --input <micros> --cached-input <micros> --output <micros> --reasoning <micros>
  budget:set --project <id> --limit <micros> [--currency <USD|EUR>]
  cost:list --project <id> [--group-by <project|task|agent>]
  milestone:create --project <id> --title <title> [--description <description>]
  milestone:set-status --project <id> --milestone <id> --status <status>
  requirement:create --project <id> --key <key> --title <title> --description <description> [--milestone <id>]
  requirement:set-status --project <id> --requirement <id> --status <status>
  adr:create --project <id> --title <title> --context <text> --decision <text> --consequences <text>
  adr:set-status --project <id> --adr <id> --status <status>
  review:create --project <id> --subject-type <type> --subject <id> --reviewer <name>
  review:decide --project <id> --review <id> --actor <name> --decision <approved|rejected> [--rationale <text>]
  governance:profile --project <id>
  governance:export --project <id>`;

const commands = [
  "project:create",
  "project:import",
  "project:onboard",
  "project:answer",
  "project:profile",
  "project:export",
  "task:create",
  "task:list",
  "agent:sync",
  "agent:list",
  "run:schedule",
  "run:tick",
  "run:list",
  "pricing:set",
  "budget:set",
  "cost:list",
  "milestone:create",
  "requirement:create",
  "adr:create",
  "milestone:set-status",
  "requirement:set-status",
  "adr:set-status",
  "review:create",
  "review:decide",
  "governance:profile",
  "governance:export",
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
  stderr: (message) => console.error(message),
};

function parseArguments(
  args: string[],
  allowedOptions: ReadonlySet<string>,
): ParsedArguments {
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

function nonNegativeBigInt(value: string, name: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new CliUsageError(`Option --${name} must be a non-negative integer`);
  }
}

function currency(value: string): "USD" | "EUR" {
  if (value !== "USD" && value !== "EUR")
    throw new CliUsageError("Currency must be USD or EUR");
  return value;
}

function formatKnownError(error: unknown): string | null {
  if (
    error instanceof CliUsageError ||
    error instanceof DomainValidationError ||
    error instanceof ProjectNotFoundError ||
    error instanceof ProjectQuestionNotFoundError ||
    error instanceof ProjectQuestionAlreadyAnsweredError ||
    error instanceof InvalidProjectAnswerError ||
    error instanceof AgentNotFoundError ||
    error instanceof TaskNotFoundError ||
    error instanceof TaskLockedError
  ) {
    return error.message;
  }

  return null;
}

function isCommand(value: string): value is Command {
  return commands.some((command) => command === value);
}

export async function runCli(
  args: string[],
  options: CliOptions,
): Promise<number> {
  const io = options.io ?? defaultIo;
  const [command, ...commandArguments] = args;

  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    io.stdout(cliHelp);
    return 0;
  }

  if (!isCommand(command)) {
    io.stderr(`Unknown command: ${command}\n\n${cliHelp}`);
    return 1;
  }

  const databasePath = join(
    options.projectRoot,
    ".ai-office",
    "project.sqlite",
  );
  const migrationDirectory =
    options.migrationDirectory ??
    join(sourceDirectory, "..", "..", "..", "migrations", "project");
  const database = openDatabase(databasePath);

  try {
    migrate(database, migrationDirectory);

    const projects = new SqliteProjectRepository(database);
    const profiles = new SqliteProjectProfileRepository(database);
    const tasks = new SqliteTaskRepository(database);
    const runtime = new SqliteAgentRuntimeRepository(database);
    const costs = new SqliteCostRepository(database);
    const governance = new SqliteGovernanceRepository(database);
    const ids = new CryptoIdGenerator();
    const clock = new SystemClock();
    const transactions = new SqliteTransactionRunner(database);

    switch (command) {
      case "project:create": {
        const parsed = parseArguments(
          commandArguments,
          new Set(["description"]),
        );
        if (parsed.positionals.length !== 1) {
          throw new CliUsageError(
            "project:create requires exactly one project name",
          );
        }

        const name = parsed.positionals[0];
        if (name === undefined) {
          throw new CliUsageError(
            "project:create requires exactly one project name",
          );
        }

        const createProject = new CreateProject(projects, ids, clock);
        const description = parsed.options.get("description");
        const projectId = await createProject.execute({
          name,
          ...(description === undefined ? {} : { description }),
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
          transactions,
        );
        const result = await importProject.execute({
          rootPath,
          ...(parsed.options.get("name") === undefined
            ? {}
            : { name: parsed.options.get("name")! }),
        });

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
        io.stdout(
          `Testing: ${result.scan.testing.join(", ") || "not detected"}`,
        );
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
        const profile = await new GetProjectProfile(projects, profiles).execute(
          projectId,
        );
        if (profile.openQuestions.length === 0) {
          io.stdout(`No open onboarding questions for project ${projectId}.`);
          return 0;
        }

        const reader =
          io.prompt === undefined
            ? createInterface({ input: process.stdin, output: process.stdout })
            : undefined;
        const prompt =
          io.prompt ?? ((message: string) => reader!.question(message));
        const answerQuestion = new AnswerProjectQuestion(
          profiles,
          ids,
          clock,
          transactions,
        );

        try {
          for (const question of profile.openQuestions) {
            io.stdout(`[${question.answerCategory}] ${question.question}`);
            if (question.answerCategory === "permission") {
              io.stdout(`Supported operations: ${agentOperations.join(", ")}`);
              io.stdout('Use a comma-separated list, "all", or "none".');
            }
            const value = await prompt("> ");
            await answerQuestion.execute({
              projectId,
              questionId: question.id,
              value,
            });
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
          new Set(["project", "question", "answer"]),
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
          transactions,
        ).execute({
          projectId,
          questionId,
          value: requiredOption(parsed, "answer"),
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
          requiredOption(parsed, "project"),
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
          requiredOption(parsed, "project"),
        );
        const outputPath = join(
          options.projectRoot,
          ".ai-office",
          "generated",
          "project-profile.md",
        );
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(
          outputPath,
          renderProjectProfileMarkdown(profile),
          "utf8",
        );
        io.stdout(`Project profile exported: ${outputPath}`);
        return 0;
      }

      case "task:create": {
        const parsed = parseArguments(
          commandArguments,
          new Set(["project", "title", "description", "priority"]),
        );
        if (parsed.positionals.length > 0) {
          throw new CliUsageError("task:create only accepts named options");
        }

        const priorityValue = parsed.options.get("priority");
        const priority =
          priorityValue === undefined ? undefined : Number(priorityValue);
        const description = parsed.options.get("description");
        const createTask = new CreateTask(projects, tasks, ids, clock);
        const taskId = await createTask.execute({
          projectId: requiredOption(parsed, "project"),
          title: requiredOption(parsed, "title"),
          ...(description === undefined ? {} : { description }),
          ...(priority === undefined ? {} : { priority }),
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
          io.stdout(
            `${task.id}\t${task.status}\t${task.priority}\t${task.title}`,
          );
        }
        return 0;
      }

      case "agent:sync": {
        const parsed = parseArguments(
          commandArguments,
          new Set(["project", "directory"]),
        );
        const projectId = requiredOption(parsed, "project");
        const directory =
          parsed.options.get("directory") ??
          join(options.projectRoot, "agents");
        const count = await new SyncAgentDefinitions(
          projects,
          runtime,
          ids,
          clock,
          transactions,
        ).execute(projectId, new YamlAgentDefinitionLoader().load(directory));
        io.stdout(`Agent definitions synchronized: ${count}`);
        return 0;
      }
      case "agent:list": {
        const parsed = parseArguments(commandArguments, new Set(["project"]));
        const values = await runtime.listAgents(
          requiredOption(parsed, "project"),
        );
        if (values.length === 0) {
          io.stdout("No agents found.");
          return 0;
        }
        io.stdout("ID\tROLE\tENABLED\tNAME");
        for (const value of values)
          io.stdout(
            `${value.id}\t${value.roleId}\t${value.enabled}\t${value.name}`,
          );
        return 0;
      }
      case "run:schedule": {
        const parsed = parseArguments(
          commandArguments,
          new Set(["project", "task", "agent"]),
        );
        const id = await new ScheduleAgentRun(
          projects,
          tasks,
          runtime,
          ids,
          clock,
          transactions,
        ).execute({
          projectId: requiredOption(parsed, "project"),
          taskId: requiredOption(parsed, "task"),
          agentId: requiredOption(parsed, "agent"),
        });
        io.stdout(`Agent run scheduled: ${id}`);
        return 0;
      }
      case "run:tick": {
        const parsed = parseArguments(
          commandArguments,
          new Set(["project", "capacity"]),
        );
        const projectId = requiredOption(parsed, "project");
        const capacity = Number(parsed.options.get("capacity") ?? "1");
        if (!Number.isSafeInteger(capacity) || capacity < 1)
          throw new CliUsageError("Capacity must be a positive integer");
        const queued = await runtime.listQueuedRuns(projectId, capacity);
        const execute = new ExecuteAgentRun(
          runtime,
          new SimulatedAgentExecutor(),
          new InMemoryWorktreeManager(),
          clock,
        );
        await Promise.all(queued.map((value) => execute.execute(value)));
        io.stdout(`Agent runs executed: ${queued.length}`);
        return 0;
      }
      case "run:list": {
        const parsed = parseArguments(commandArguments, new Set(["project"]));
        const values = await runtime.listRuns(
          requiredOption(parsed, "project"),
        );
        if (values.length === 0) {
          io.stdout("No agent runs found.");
          return 0;
        }
        io.stdout("ID\tSTATUS\tTASK\tAGENT");
        for (const value of values) {
          const v = value.snapshot();
          io.stdout(`${v.id}\t${v.status}\t${v.taskId}\t${v.agentId}`);
        }
        return 0;
      }
      case "pricing:set": {
        const parsed = parseArguments(
          commandArguments,
          new Set([
            "provider",
            "model",
            "currency",
            "input",
            "cached-input",
            "output",
            "reasoning",
          ]),
        );
        const now = clock.now();
        const id = ids.generate();
        await costs.savePricing(
          {
            id,
            provider: requiredOption(parsed, "provider"),
            model: requiredOption(parsed, "model"),
            currency: currency(requiredOption(parsed, "currency")),
            inputPerMillionMicros: nonNegativeBigInt(
              requiredOption(parsed, "input"),
              "input",
            ),
            cachedInputPerMillionMicros: nonNegativeBigInt(
              requiredOption(parsed, "cached-input"),
              "cached-input",
            ),
            outputPerMillionMicros: nonNegativeBigInt(
              requiredOption(parsed, "output"),
              "output",
            ),
            reasoningPerMillionMicros: nonNegativeBigInt(
              requiredOption(parsed, "reasoning"),
              "reasoning",
            ),
            effectiveFrom: now,
          },
          now,
        );
        io.stdout(`Pricing version saved: ${id}`);
        return 0;
      }
      case "budget:set": {
        const parsed = parseArguments(
          commandArguments,
          new Set(["project", "limit", "currency"]),
        );
        const projectId = requiredOption(parsed, "project");
        if ((await projects.findById(projectId)) === null)
          throw new ProjectNotFoundError(projectId);
        const now = clock.now();
        const id = ids.generate();
        await costs.saveBudget(
          {
            id,
            projectId,
            scopeType: "project",
            scopeId: projectId,
            limitMicros: nonNegativeBigInt(
              requiredOption(parsed, "limit"),
              "limit",
            ),
            currency: currency(parsed.options.get("currency") ?? "USD"),
          },
          now,
        );
        io.stdout(`Budget saved: ${id}`);
        return 0;
      }
      case "cost:list": {
        const parsed = parseArguments(
          commandArguments,
          new Set(["project", "group-by"]),
        );
        const group = parsed.options.get("group-by") ?? "project";
        if (group !== "project" && group !== "task" && group !== "agent")
          throw new CliUsageError("Group must be project, task, or agent");
        const values = await costs.aggregate(
          requiredOption(parsed, "project"),
          group,
        );
        if (values.length === 0) {
          io.stdout("No cost events found.");
          return 0;
        }
        io.stdout("DIMENSION\tACTUAL_MICROS\tCURRENCY");
        for (const v of values)
          io.stdout(`${v.dimension}\t${v.actualMicros}\t${v.currency}`);
        return 0;
      }
      case "milestone:create": {
        const p = parseArguments(
          commandArguments,
          new Set(["project", "title", "description"]),
        );
        const id = await new ManageGovernance(
          projects,
          governance,
          ids,
          clock,
        ).createMilestone({
          projectId: requiredOption(p, "project"),
          title: requiredOption(p, "title"),
          ...(p.options.get("description") === undefined
            ? {}
            : { description: p.options.get("description")! }),
        });
        io.stdout(`Milestone created: ${id}`);
        return 0;
      }
      case "requirement:create": {
        const p = parseArguments(
          commandArguments,
          new Set(["project", "key", "title", "description", "milestone"]),
        );
        const id = await new ManageGovernance(
          projects,
          governance,
          ids,
          clock,
        ).createRequirement({
          projectId: requiredOption(p, "project"),
          key: requiredOption(p, "key"),
          title: requiredOption(p, "title"),
          description: requiredOption(p, "description"),
          ...(p.options.get("milestone") === undefined
            ? {}
            : { milestoneId: p.options.get("milestone")! }),
        });
        io.stdout(`Requirement created: ${id}`);
        return 0;
      }
      case "adr:create": {
        const p = parseArguments(
          commandArguments,
          new Set(["project", "title", "context", "decision", "consequences"]),
        );
        const id = await new ManageGovernance(
          projects,
          governance,
          ids,
          clock,
        ).createAdr({
          projectId: requiredOption(p, "project"),
          title: requiredOption(p, "title"),
          context: requiredOption(p, "context"),
          decision: requiredOption(p, "decision"),
          consequences: requiredOption(p, "consequences"),
        });
        io.stdout(`ADR created: ${id}`);
        return 0;
      }
      case "milestone:set-status":
      case "requirement:set-status":
      case "adr:set-status": {
        const kind = command.split(":")[0] as
          "milestone" | "requirement" | "adr";
        const p = parseArguments(
          commandArguments,
          new Set(["project", kind, "status"]),
        );
        const status = requiredOption(p, "status");
        const allowed =
          kind === "milestone"
            ? ["planned", "active", "completed", "cancelled"]
            : kind === "requirement"
              ? ["proposed", "accepted", "implemented", "verified", "rejected"]
              : [
                  "proposed",
                  "accepted",
                  "rejected",
                  "deprecated",
                  "superseded",
                ];
        if (!allowed.includes(status))
          throw new CliUsageError(`Invalid ${kind} status`);
        await new ManageGovernance(projects, governance, ids, clock).setStatus({
          projectId: requiredOption(p, "project"),
          kind,
          id: requiredOption(p, kind),
          status,
        });
        io.stdout(`${kind} status updated: ${status}`);
        return 0;
      }
      case "review:create": {
        const p = parseArguments(
          commandArguments,
          new Set(["project", "subject-type", "subject", "reviewer"]),
        );
        const type = requiredOption(p, "subject-type");
        if (
          !["task", "agent_run", "requirement", "adr", "milestone"].includes(
            type,
          )
        )
          throw new CliUsageError("Invalid review subject type");
        const id = await new ManageGovernance(
          projects,
          governance,
          ids,
          clock,
        ).createReview({
          projectId: requiredOption(p, "project"),
          subjectType: type as
            "task" | "agent_run" | "requirement" | "adr" | "milestone",
          subjectId: requiredOption(p, "subject"),
          reviewer: requiredOption(p, "reviewer"),
        });
        io.stdout(`Review created: ${id}`);
        return 0;
      }
      case "review:decide": {
        const p = parseArguments(
          commandArguments,
          new Set(["project", "review", "actor", "decision", "rationale"]),
        );
        const decision = requiredOption(p, "decision");
        if (decision !== "approved" && decision !== "rejected")
          throw new CliUsageError("Decision must be approved or rejected");
        const id = await new ManageGovernance(
          projects,
          governance,
          ids,
          clock,
        ).approve({
          projectId: requiredOption(p, "project"),
          reviewId: requiredOption(p, "review"),
          actor: requiredOption(p, "actor"),
          decision,
          ...(p.options.get("rationale") === undefined
            ? {}
            : { rationale: p.options.get("rationale")! }),
        });
        io.stdout(`Review decision saved: ${id}`);
        return 0;
      }
      case "governance:profile":
      case "governance:export": {
        const p = parseArguments(commandArguments, new Set(["project"]));
        const projectId = requiredOption(p, "project");
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
          options.projectRoot,
          ".ai-office",
          "generated",
          "governance.md",
        );
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, markdown, "utf8");
        io.stdout(`Governance exported: ${outputPath}`);
        return 0;
      }
    }
  } catch (error) {
    if (
      error instanceof CliPromptRequiredError &&
      options.propagatePromptRequired === true
    ) {
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

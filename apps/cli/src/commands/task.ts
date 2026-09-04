import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import { ManageTaskLifecycle } from "@ai-office/application/commands/manage-task-lifecycle.ts";
import { ManageTaskRequirements } from "@ai-office/application/commands/manage-task-requirements.ts";
import {
  ReconcileTasks,
  requirementProgress,
  type TaskReconciliationIssue,
} from "@ai-office/application/commands/reconcile-tasks.ts";
import { ListTaskBoard } from "@ai-office/application/queries/list-task-board.ts";
import type { LinkedRequirement } from "@ai-office/application/ports/task-requirement-repository.port.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

/** Lifecycle commands and the service method each one invokes. */
const lifecycleCommands = {
  "task:start": "start",
  "task:submit-review": "submit-review",
  "task:complete": "complete",
  "task:block": "block",
  "task:unblock": "unblock",
  "task:fail": "fail",
  "task:cancel": "cancel",
} as const;

type LifecycleCommand = keyof typeof lifecycleCommands;

/** Transitions whose reason is mandatory, because "why" is the whole record. */
const reasonRequired = new Set<LifecycleCommand>(["task:block", "task:fail"]);
/** Transitions where a reason is welcome but not demanded. */
const reasonOptional = new Set<LifecycleCommand>(["task:cancel"]);

function isLifecycleCommand(value: string): value is LifecycleCommand {
  return Object.hasOwn(lifecycleCommands, value);
}

/** `2/3 verified` — never a status, always progress beside one. */
function requirementCell(requirements: readonly LinkedRequirement[]): string {
  if (requirements.length === 0) return "—";
  const progress = requirementProgress(requirements);
  return `${progress.verified}/${progress.total} verified`;
}

function issueLine(issue: TaskReconciliationIssue): string {
  const suffix =
    issue.suggestedCommand === null ? "" : ` (suggested: ${issue.suggestedCommand})`;
  return `  ${issue.taskId}  ${issue.finding}: ${issue.summary}${suffix}`;
}

export async function handleTaskCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const {
    projects,
    tasks,
    governance,
    taskRequirements,
    pipelines,
    runtime,
    audit,
    ids,
    clock,
    transactions,
    principal,
    io,
  } = context;

  const lifecycle = new ManageTaskLifecycle(
    projects,
    tasks,
    audit,
    clock,
    transactions,
  );

  if (command === "task:create") {
    const parsed = parseArguments(
      args,
      new Set(["project", "title", "description", "priority"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError("task:create only accepts named options");
    const priorityValue = parsed.options.get("priority");
    const priority =
      priorityValue === undefined ? undefined : Number(priorityValue);
    const description = parsed.options.get("description");
    const id = await new CreateTask(projects, tasks, ids, clock).execute({
      projectId: requiredOption(parsed, "project"),
      title: requiredOption(parsed, "title"),
      ...(description === undefined ? {} : { description }),
      ...(priority === undefined ? {} : { priority }),
    });
    io.stdout(`Task created: ${id}`);
    return 0;
  }

  if (command === "task:list") {
    const parsed = parseArguments(args, new Set(["project"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError("task:list only accepts named options");
    const projectId = requiredOption(parsed, "project");
    const rows = await new ListTaskBoard(
      projects,
      tasks,
      taskRequirements,
    ).execute(projectId);
    if (rows.length === 0) {
      io.stdout(`No tasks found for project ${projectId}.`);
      return 0;
    }

    // STATUS is the task's own state and nothing else. Requirement progress is
    // a separate column, and a contradiction between them is marked rather than
    // resolved: rewriting the displayed status would hide the defect.
    io.stdout("ID\tSTATUS\tREQUIREMENTS\tPRIORITY\tTITLE");
    for (const row of rows)
      io.stdout(
        `${row.taskId}\t${row.status}${row.contradictsRequirements ? " !" : ""}\t${requirementCell(row.requirements)}\t${row.priority}\t${row.title}`,
      );
    for (const row of rows.filter((value) => value.contradictsRequirements))
      io.stderr(
        `warning: task ${row.taskId} is ${row.status} while all linked requirements are terminal; run ai-office task:reconcile --project ${projectId} for details`,
      );
    return 0;
  }

  if (command === "task:transitions") {
    const parsed = parseArguments(
      args,
      new Set(["project", "task"]),
      new Set(["json"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError("task:transitions only accepts named options");
    const report = await lifecycle.transitions({
      projectId: requiredOption(parsed, "project"),
      taskId: requiredOption(parsed, "task"),
    });
    if (parsed.flags.has("json")) {
      io.stdout(JSON.stringify(report));
      return 0;
    }
    io.stdout(`Current state: ${report.status}`);
    io.stdout("");
    if (report.allowed.length === 0)
      io.stdout("Allowed transitions:\n  (none: this state is terminal)");
    else {
      io.stdout("Allowed transitions:");
      for (const transition of report.allowed)
        io.stdout(`  ${transition.to}\t${transition.command}`);
    }
    io.stdout("");
    io.stdout("Terminal:");
    for (const status of report.terminalStatuses) io.stdout(`  ${status}`);
    return 0;
  }

  if (isLifecycleCommand(command)) {
    const accepted = new Set(["project", "task"]);
    if (reasonRequired.has(command) || reasonOptional.has(command))
      accepted.add("reason");
    const parsed = parseArguments(args, accepted);
    if (parsed.positionals.length > 0)
      throw new CliUsageError(`${command} only accepts named options`);
    const reason = parsed.options.get("reason");
    if (reasonRequired.has(command) && reason === undefined)
      throw new CliUsageError(`${command} requires --reason`);
    const input = {
      projectId: requiredOption(parsed, "project"),
      taskId: requiredOption(parsed, "task"),
      actorId: principal.id,
    };
    const operation = lifecycleCommands[command];
    const status =
      operation === "start"
        ? await lifecycle.start(input)
        : operation === "submit-review"
          ? await lifecycle.submitForReview(input)
          : operation === "complete"
            ? await lifecycle.complete(input)
            : operation === "block"
              ? await lifecycle.block({ ...input, reason: reason! })
              : operation === "unblock"
                ? await lifecycle.unblock(input)
                : operation === "fail"
                  ? await lifecycle.fail({ ...input, reason: reason! })
                  : await lifecycle.cancel({
                      ...input,
                      ...(reason === undefined ? {} : { reason }),
                    });
    io.stdout(`Task ${input.taskId} is now ${status}`);
    return 0;
  }

  if (command === "task:link-requirement" || command === "task:unlink-requirement") {
    const parsed = parseArguments(
      args,
      new Set(["project", "task", "requirement"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError(`${command} only accepts named options`);
    const service = new ManageTaskRequirements(
      projects,
      tasks,
      governance,
      taskRequirements,
      audit,
      clock,
      transactions,
    );
    const input = {
      projectId: requiredOption(parsed, "project"),
      taskId: requiredOption(parsed, "task"),
      requirementId: requiredOption(parsed, "requirement"),
      actorId: principal.id,
    };
    if (command === "task:link-requirement") {
      const { created } = await service.link(input);
      io.stdout(
        created
          ? `Linked requirement ${input.requirementId} to task ${input.taskId}`
          : `Requirement ${input.requirementId} was already linked to task ${input.taskId}`,
      );
      return 0;
    }
    const { removed } = await service.unlink(input);
    io.stdout(
      removed
        ? `Unlinked requirement ${input.requirementId} from task ${input.taskId}`
        : `Requirement ${input.requirementId} was not linked to task ${input.taskId}`,
    );
    return 0;
  }

  if (command === "task:reconcile") {
    const parsed = parseArguments(
      args,
      new Set(["project", "approve"]),
      new Set(["fix", "json"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError("task:reconcile only accepts named options");
    const projectId = requiredOption(parsed, "project");
    const service = new ReconcileTasks(
      projects,
      tasks,
      pipelines,
      runtime,
      taskRequirements,
      lifecycle,
      clock,
    );

    const approve = parsed.options.get("approve");
    if (parsed.flags.has("fix")) {
      // Repair never runs off a fresh inspection alone: the operator must have
      // seen the plan and approved its hash, exactly as client:apply and
      // runtime:purge require.
      if (approve === undefined)
        throw new CliUsageError(
          "task:reconcile --fix requires --approve <planHash> from a preceding read-only run",
        );
      const result = await service.repair({
        projectId,
        approvedPlanHash: approve,
        actorId: principal.id,
      });
      if (parsed.flags.has("json")) {
        io.stdout(JSON.stringify(result));
        return 0;
      }
      for (const applied of result.applied)
        io.stdout(
          `${applied.taskId}: ${applied.from} -> ${applied.to} (${applied.operation})`,
        );
      if (result.applied.length === 0) io.stdout("No repairs applied.");
      for (const issue of result.refused)
        io.stdout(
          `${issue.taskId}: repair REFUSED — ${issue.refusalReason ?? "ambiguous"}`,
        );
      return 0;
    }

    const report = await service.inspect(projectId);
    if (parsed.flags.has("json")) {
      io.stdout(JSON.stringify(report));
      return 0;
    }
    io.stdout(
      `Inspected ${report.tasksInspected} task(s) in project ${projectId}.`,
    );
    if (report.issues.length === 0) {
      io.stdout("No inconsistencies found.");
      return 0;
    }
    const inconsistent = report.issues.filter(
      (issue) => issue.severity === "inconsistent",
    );
    const warnings = report.issues.filter(
      (issue) => issue.severity === "warning",
    );
    if (inconsistent.length > 0) {
      io.stdout("");
      io.stdout("Inconsistent:");
      for (const issue of inconsistent) io.stdout(issueLine(issue));
    }
    if (warnings.length > 0) {
      io.stdout("");
      io.stdout("Warnings:");
      for (const issue of warnings) io.stdout(issueLine(issue));
    }
    const refused = report.issues.filter((issue) => !issue.repairable);
    if (refused.length > 0) {
      io.stdout("");
      io.stdout("Automatic repair REFUSED for:");
      for (const issue of refused)
        io.stdout(`  ${issue.taskId}: ${issue.refusalReason ?? "ambiguous"}`);
    }
    io.stdout("");
    if (report.planHash === null)
      io.stdout(
        "No automatic repair is available. Use the task lifecycle commands to correct state explicitly.",
      );
    else
      io.stdout(
        `Repairable: ${report.issues.filter((issue) => issue.repairable).length}. Apply with:\n  ai-office task:reconcile --project ${projectId} --fix --approve ${report.planHash}`,
      );
    return 0;
  }

  return null;
}

import { SimulatedAgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

export async function handleRunCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const { projects, tasks, runtime, ids, clock, transactions, io } = context;
  if (command === "run:schedule") {
    const parsed = parseArguments(args, new Set(["project", "task", "agent"]));
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
  if (command === "run:tick") {
    const parsed = parseArguments(args, new Set(["project", "capacity"]));
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
  if (command === "run:list") {
    const parsed = parseArguments(args, new Set(["project"]));
    const values = await runtime.listRuns(requiredOption(parsed, "project"));
    if (values.length === 0) {
      io.stdout("No agent runs found.");
      return 0;
    }
    io.stdout("ID\tSTATUS\tTASK\tAGENT");
    for (const value of values) {
      const snapshot = value.snapshot();
      io.stdout(
        `${snapshot.id}\t${snapshot.status}\t${snapshot.taskId}\t${snapshot.agentId}`,
      );
    }
    return 0;
  }
  return null;
}

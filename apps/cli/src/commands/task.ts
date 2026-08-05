import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import { ListTasks } from "@ai-office/application/queries/list-tasks.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

export async function handleTaskCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  const { projects, tasks, ids, clock, io } = context;
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
    const values = await new ListTasks(tasks).execute(projectId);
    if (values.length === 0) {
      io.stdout(`No tasks found for project ${projectId}.`);
      return 0;
    }
    io.stdout("ID\tSTATUS\tPRIORITY\tTITLE");
    for (const value of values)
      io.stdout(
        `${value.id}\t${value.status}\t${value.priority}\t${value.title}`,
      );
    return 0;
  }
  return null;
}

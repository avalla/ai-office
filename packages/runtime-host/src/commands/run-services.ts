import { ManageAgentRuns } from "@ai-office/application/commands/manage-agent-runs.ts";
import type { CommandContext } from "./shared.ts";

export function manageAgentRuns(c: CommandContext): ManageAgentRuns {
  return new ManageAgentRuns(
    c.runtime,
    c.capabilities,
    c.controlled,
    c.executionControl,
    c.audit,
    c.transactions,
    c.clock,
  );
}

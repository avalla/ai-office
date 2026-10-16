import { ManageAgentRuns } from "@ai-office/application/commands/manage-agent-runs.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
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

export function managePipelineRuns(c: CommandContext): ManagePipelineRuns {
  return new ManagePipelineRuns(
    c.officeManifests,
    c.pipelines,
    c.tasks,
    c.runtime,
    c.audit,
    c.ids,
    c.clock,
    c.transactions,
    c.jobOutbox,
    c.taskDependencies,
    // M16.5 activation resolves selected-pack workflows and policies, and
    // freezes the selected definition with its configuration pin at start.
    c.projectConfiguration,
  );
}

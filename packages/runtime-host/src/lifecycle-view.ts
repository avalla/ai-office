import type {
  LifecycleClientStatus,
  LifecycleHealth,
  ProjectLifecycleStatus,
} from "@ai-office/application/project-lifecycle/manage-project-lifecycle.ts";
import type { ProjectHandoverReport } from "@ai-office/application/project-lifecycle/assess-project-handover.ts";
import { renderStatusGuidance } from "./handover-view.ts";
import type { CommandIo } from "./commands/shared.ts";

/**
 * Text rendering for a project lifecycle status.
 *
 * It is deliberately free of command composition so both the Runtime `status`
 * command and client-side offline inspection can print the same report without
 * the client depending on Runtime command wiring.
 */
export function clientLine(client: LifecycleClientStatus): string {
  const state =
    client.detection === "detected"
      ? client.configuration
      : client.configuration === "not_configured"
        ? "not detected"
        : `${client.configuration} (client not detected)`;
  return `  ${client.displayName}: ${state}`;
}

export function printProjectLifecycleStatus(
  result: ProjectLifecycleStatus,
  context: { io: CommandIo },
  handover?: ProjectHandoverReport,
): void {
  context.io.stdout("AI Office");
  context.io.stdout("");
  context.io.stdout("Project");
  context.io.stdout(`  name: ${result.project.name ?? "unavailable"}`);
  context.io.stdout(`  id: ${result.project.id ?? "unavailable"}`);
  context.io.stdout(`  root: ${result.project.root}`);
  context.io.stdout(
    `  repository identity: ${result.project.repositoryIdentity.state}`,
  );
  context.io.stdout(
    `  repository id: ${result.project.repositoryIdentity.id ?? "unavailable"}`,
  );
  context.io.stdout(
    `  runtime association: ${result.project.runtimeAssociation.state}`,
  );
  if (result.project.stateRevision !== undefined)
    context.io.stdout(
      `  state revision: ${result.project.stateRevision.head ?? "not exported"}`,
    );
  context.io.stdout("");
  context.io.stdout("Runtime");
  context.io.stdout(`  persistent host: ${result.runtime.daemon}`);
  context.io.stdout(`  home: ${result.runtime.home}`);
  context.io.stdout(`  state: ${result.runtime.authoritativeState}`);
  context.io.stdout("");
  context.io.stdout("Office");
  context.io.stdout(`  state: ${result.office.state}`);
  context.io.stdout(`  onboarding: ${result.office.onboarding}`);
  context.io.stdout(`  revision: ${result.office.revision ?? "unavailable"}`);
  context.io.stdout(`  roles: ${result.office.roles.length}`);
  context.io.stdout("");
  context.io.stdout("Clients");
  if (result.clients.length === 0) context.io.stdout("  unavailable");
  for (const client of result.clients) context.io.stdout(clientLine(client));
  if (result.tasks !== null) {
    context.io.stdout("");
    context.io.stdout("Tasks");
    context.io.stdout(`  open: ${result.tasks.open}`);
    context.io.stdout(`  wip: ${result.tasks.wip}`);
  }
  if (result.pipeline !== undefined) {
    context.io.stdout("");
    context.io.stdout("Pipeline");
    context.io.stdout(`  state: ${result.pipeline.state}`);
    context.io.stdout(`  active runs: ${result.pipeline.activeRuns}`);
    context.io.stdout(
      `  configured: ${result.pipeline.configured
        .map((pipeline) => `${pipeline.id} (${pipeline.mode})`)
        .join(", ")}`,
    );
    if (result.pipeline.currentStages.length > 0)
      context.io.stdout(
        `  current stages: ${result.pipeline.currentStages.join(", ")}`,
      );
  }
  if (result.issues.length > 0) {
    context.io.stdout("");
    context.io.stdout("Issues");
    for (const issue of result.issues) {
      context.io.stdout(`  ${issue.code}: ${issue.message}`);
      if (issue.recovery !== undefined)
        context.io.stdout(`    ${issue.recovery}`);
    }
  }
  context.io.stdout("");
  context.io.stdout(`Status: ${result.health}`);
  if (handover !== undefined)
    renderStatusGuidance(handover.handover, context.io);
}

/**
 * Process exit code for `status`, online or offline.
 *
 * `0` means nothing that needs attention was found in what was actually
 * inspected; `1` means a problem was found or the repository is not installed.
 * `unverified` maps to `0` because explicit offline inspection found no local
 * problem — it simply did not read authoritative state, which the report says.
 */
export function projectStatusExitCode(health: LifecycleHealth): number {
  return health === "healthy" || health === "unverified" ? 0 : 1;
}

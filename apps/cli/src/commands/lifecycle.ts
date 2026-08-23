import { ApplyOfficeManifest } from "@ai-office/application/commands/apply-office-manifest.ts";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { ManageAgentClientIntegration } from "@ai-office/application/agent-client/manage-agent-client-integration.ts";
import {
  ManageProjectLifecycle,
  type LifecycleClientStatus,
  type ProjectInstallResult,
  type ProjectLifecycleStatus,
  type ProjectUninstallPlan,
  type ProjectUninstallResult,
} from "@ai-office/application/project-lifecycle/manage-project-lifecycle.ts";
import { LocalProjectScanner } from "../local-project-scanner.ts";
import {
  CliUsageError,
  parseArguments,
  type CommandContext,
} from "./shared.ts";

function service(context: CommandContext): ManageProjectLifecycle {
  return new ManageProjectLifecycle({
    projects: context.projects,
    profiles: context.profiles,
    manifests: context.officeManifests,
    tasks: context.tasks,
    importer: new ImportProject(
      context.projects,
      context.profiles,
      new LocalProjectScanner(),
      context.ids,
      context.clock,
      context.transactions,
    ),
    manifestApplicator: new ApplyOfficeManifest(
      context.projects,
      context.officeManifests,
      context.audit,
      context.ids,
      context.clock,
      context.transactions,
    ),
    clients: new ManageAgentClientIntegration(context.agentClients),
    bindings: context.projectBindings,
    defaultManifest: context.defaultOfficeManifest,
  });
}

function clientLine(client: LifecycleClientStatus): string {
  const state =
    client.detection === "detected"
      ? client.configuration
      : client.configuration === "not_configured"
        ? "not detected"
        : `${client.configuration} (client not detected)`;
  return `  ${client.displayName}: ${state}`;
}

function printInstall(
  result: ProjectInstallResult,
  context: CommandContext,
): void {
  context.io.stdout("AI Office installed successfully.");
  context.io.stdout("");
  context.io.stdout("Project");
  context.io.stdout(`  name: ${result.project.name}`);
  context.io.stdout(`  id: ${result.project.id}`);
  context.io.stdout(`  root: ${result.project.root}`);
  context.io.stdout("");
  context.io.stdout("Created or updated");
  if (result.binding.action !== "none")
    context.io.stdout(`  ${result.binding.path}`);
  for (const change of result.changes)
    context.io.stdout(`  ${change.relativePath} (${change.kind})`);
  if (result.binding.action === "none" && result.changes.length === 0)
    context.io.stdout("  no filesystem changes");
  context.io.stdout("");
  context.io.stdout("Office");
  context.io.stdout(`  revision: ${result.office.revision}`);
  context.io.stdout(`  roles: ${result.office.roles.join(", ")}`);
  context.io.stdout("");
  context.io.stdout("Clients");
  for (const client of result.clients) context.io.stdout(clientLine(client));
  for (const warning of result.warnings)
    context.io.stdout(`  warning: ${warning}`);
  context.io.stdout("");
  context.io.stdout("Next");
  context.io.stdout("  ai-office status");
  context.io.stdout("  ai-office task:list");
}

export function printProjectLifecycleStatus(
  result: ProjectLifecycleStatus,
  context: Pick<CommandContext, "io">,
): void {
  context.io.stdout("AI Office");
  context.io.stdout("");
  context.io.stdout("Project");
  context.io.stdout(`  name: ${result.project.name ?? "unavailable"}`);
  context.io.stdout(`  id: ${result.project.id ?? "unavailable"}`);
  context.io.stdout(`  root: ${result.project.root}`);
  context.io.stdout(`  binding: ${result.project.binding.state}`);
  context.io.stdout("");
  context.io.stdout("Runtime");
  context.io.stdout(`  daemon: ${result.runtime.daemon}`);
  context.io.stdout(`  state: ${result.runtime.authoritativeState}`);
  context.io.stdout("");
  context.io.stdout("Office");
  context.io.stdout(`  state: ${result.office.state}`);
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
}

function printUninstallPlan(
  result: ProjectUninstallPlan,
  context: CommandContext,
): void {
  if (!result.installed) {
    context.io.stdout("AI Office is not installed for this repository.");
    return;
  }
  context.io.stdout("AI Office uninstall plan");
  context.io.stdout("");
  context.io.stdout(`Project: ${result.projectId ?? "unknown"}`);
  context.io.stdout(`Root: ${result.rootPath}`);
  context.io.stdout("Changes");
  for (const change of result.changes)
    context.io.stdout(`  ${change.kind}: ${change.relativePath}`);
  if (result.changes.length === 0) context.io.stdout("  none");
  for (const item of result.preserved)
    context.io.stdout(`  preserved: ${item}`);
  context.io.stdout("");
  context.io.stdout(
    "Runtime project state and global memory will be preserved.",
  );
  context.io.stdout("");
  context.io.stdout("Approve this exact plan with:");
  context.io.stdout(`  ai-office uninstall . --approve ${result.planHash}`);
}

function printUninstallResult(
  result: ProjectUninstallResult,
  context: CommandContext,
): void {
  context.io.stdout(
    result.uninstalled
      ? "AI Office uninstalled from this repository."
      : "AI Office was not installed for this repository.",
  );
  context.io.stdout(`Root: ${result.rootPath}`);
  for (const path of result.removedPaths) context.io.stdout(`Removed: ${path}`);
  context.io.stdout("Authoritative runtime state: preserved");
  context.io.stdout("Global memory: preserved");
}

export async function handleLifecycleCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (command !== "install" && command !== "status" && command !== "uninstall")
    return null;

  if (command === "install") {
    const parsed = parseArguments(args, new Set(), new Set(["json", "rebind"]));
    if (parsed.positionals.length > 1)
      throw new CliUsageError("install accepts at most one project path");
    const result = await service(context).install({
      rootPath: parsed.positionals[0] ?? context.projectRoot,
      rebind: parsed.flags.has("rebind"),
    });
    if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(result));
    else printInstall(result, context);
    return 0;
  }

  if (command === "status") {
    const parsed = parseArguments(args, new Set(), new Set(["json"]));
    if (parsed.positionals.length > 1)
      throw new CliUsageError("status accepts at most one project path");
    const result = await service(context).status(
      parsed.positionals[0] ?? context.projectRoot,
    );
    if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(result));
    else printProjectLifecycleStatus(result, context);
    return result.health === "healthy" ? 0 : 1;
  }

  const parsed = parseArguments(args, new Set(["approve"]), new Set(["json"]));
  if (parsed.positionals.length > 1)
    throw new CliUsageError("uninstall accepts at most one project path");
  const rootPath = parsed.positionals[0] ?? context.projectRoot;
  const approvedPlanHash = parsed.options.get("approve");
  if (approvedPlanHash === undefined) {
    const plan = await service(context).planUninstall(rootPath);
    if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(plan));
    else printUninstallPlan(plan, context);
    return 0;
  }
  const result = await service(context).uninstall({
    rootPath,
    approvedPlanHash,
  });
  if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(result));
  else printUninstallResult(result, context);
  return 0;
}

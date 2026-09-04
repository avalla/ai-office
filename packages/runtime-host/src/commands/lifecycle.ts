import { ApplyOfficeManifest } from "@ai-office/application/commands/apply-office-manifest.ts";
import {
  ImportProject,
  ProjectSourceAssociationError,
} from "@ai-office/application/commands/import-project.ts";
import { ManageAgentClientIntegration } from "@ai-office/application/agent-client/manage-agent-client-integration.ts";
import { AgentClientIntegrationError } from "@ai-office/application/agent-client/errors.ts";
import {
  ManageProjectLifecycle,
  ProjectInstallPartialError,
  ProjectLifecycleError,
  ProjectUninstallPartialError,
  type ProjectInstallResult,
  type ProjectUninstallPlan,
  type ProjectUninstallResult,
} from "@ai-office/application/project-lifecycle/manage-project-lifecycle.ts";
import { ProjectBindingError } from "@ai-office/application/project-lifecycle/project-binding.ts";
import {
  AssessProjectHandover,
  type ProjectHandoverReport,
} from "@ai-office/application/project-lifecycle/assess-project-handover.ts";
import { InvalidProjectInstructionContractError } from "@ai-office/domain/agent/project-instruction-contract.ts";
import { LocalProjectScanner } from "../local-project-scanner.ts";
import {
  renderHandoverReport,
  renderNextSteps,
  renderWelcome,
} from "@ai-office/command-support/handover-view.ts";
import {
  clientLine,
  printProjectLifecycleStatus,
  projectStatusExitCode,
} from "@ai-office/command-support/lifecycle-view.ts";
import { ConfirmRepositoryUnderstanding } from "@ai-office/application/project-lifecycle/confirm-repository-understanding.ts";
import {
  CliUsageError,
  parseArguments,
  requiredOption,
  requiredPositional,
  type CommandContext,
} from "./shared.ts";

function service(context: CommandContext): ManageProjectLifecycle {
  return new ManageProjectLifecycle({
    projects: context.projects,
    profiles: context.profiles,
    identities: context.repositoryIdentities,
    manifests: context.officeManifests,
    tasks: context.tasks,
    pipelines: context.pipelines,
    states: context.projectStates,
    importer: new ImportProject(
      context.projects,
      context.profiles,
      new LocalProjectScanner(),
      context.repositoryIdentities,
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
    ids: context.ids,
    clock: context.clock,
    runtimeHome: context.runtimeHome,
    defaultManifest: context.defaultOfficeManifest,
  });
}

function handoverService(context: CommandContext): AssessProjectHandover {
  return new AssessProjectHandover({
    lifecycle: service(context),
    profiles: context.profiles,
    manifests: context.officeManifests,
    governance: context.governance,
    tasks: context.tasks,
  });
}

/**
 * A first connection is the moment this repository became known to this
 * runtime. Reinstalling an already connected repository is reconciliation and
 * must not replay the welcome.
 */
function isFirstConnection(result: ProjectInstallResult): boolean {
  return (
    result.project.created ||
    result.project.association === "created" ||
    result.repositoryIdentity.action === "create"
  );
}

function lifecycleFailureMessage(error: unknown): string | null {
  return error instanceof ProjectLifecycleError ||
    error instanceof ProjectBindingError ||
    error instanceof ProjectSourceAssociationError ||
    error instanceof AgentClientIntegrationError ||
    error instanceof InvalidProjectInstructionContractError
    ? error.message
    : null;
}

function printJsonFailure(
  operation: "install" | "uninstall",
  message: string,
  context: CommandContext,
): void {
  context.io.stdout(
    JSON.stringify({
      schemaVersion: 2,
      outcome: "failed",
      operation,
      error: {
        message,
        recovery:
          operation === "install"
            ? "Resolve the reported issue, run ai-office status, then rerun ai-office install ."
            : "No lifecycle mutation was started for this attempt. Inspect current state and request a new uninstall plan.",
      },
    }),
  );
}

function printInstall(
  result: ProjectInstallResult,
  handover: ProjectHandoverReport,
  context: CommandContext,
): void {
  if (isFirstConnection(result)) renderWelcome(context.io);
  context.io.stdout(
    result.outcome === "installed"
      ? "AI Office installed."
      : "AI Office installed with warnings.",
  );
  context.io.stdout("");
  context.io.stdout("Project");
  context.io.stdout(`  name: ${result.project.name}`);
  context.io.stdout(`  id: ${result.project.id}`);
  context.io.stdout(`  repository id: ${result.project.repositoryId}`);
  context.io.stdout(`  root: ${result.project.root}`);
  context.io.stdout("");
  context.io.stdout("Created or updated");
  if (result.repositoryIdentity.action !== "none")
    context.io.stdout(`  ${result.repositoryIdentity.path}`);
  for (const change of result.changes)
    context.io.stdout(`  ${change.relativePath} (${change.kind})`);
  if (
    result.repositoryIdentity.action === "none" &&
    result.changes.length === 0
  )
    context.io.stdout("  no filesystem changes");
  context.io.stdout("");
  context.io.stdout("Office");
  context.io.stdout(`  state: ${result.office.state}`);
  context.io.stdout(`  onboarding: ${result.office.onboarding}`);
  context.io.stdout(`  revision: ${result.office.revision}`);
  context.io.stdout(`  roles: ${result.office.roles.join(", ")}`);
  context.io.stdout("");
  context.io.stdout("Clients");
  for (const client of result.clients) context.io.stdout(clientLine(client));
  for (const issue of result.issues) {
    context.io.stdout(`  ${issue.severity}: ${issue.message}`);
    if (issue.recovery !== undefined)
      context.io.stdout(`    ${issue.recovery}`);
  }
  context.io.stdout("");
  renderNextSteps(handover.handover, context.io);
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
  context.io.stdout(`Repository: ${result.repositoryId ?? "unknown"}`);
  context.io.stdout(`Root: ${result.rootPath}`);
  context.io.stdout("Changes");
  for (const change of result.changes)
    context.io.stdout(`  ${change.kind}: ${change.relativePath}`);
  if (result.changes.length === 0) context.io.stdout("  none");
  for (const item of result.preserved)
    context.io.stdout(`  preserved: ${item}`);
  context.io.stdout("");
  context.io.stdout(
    "Portable repository identity, runtime project state, and global memory will be preserved.",
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
  context.io.stdout("Portable repository identity: preserved");
  context.io.stdout("Global memory: preserved");
}

export async function handleLifecycleCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (
    command !== "install" &&
    command !== "status" &&
    command !== "uninstall" &&
    command !== "next" &&
    command !== "handover:confirm"
  )
    return null;

  if (command === "handover:confirm") {
    const parsed = parseArguments(
      args,
      new Set(["project", "summary"]),
      new Set(["json"]),
    );
    if (parsed.positionals.length > 0)
      throw new CliUsageError("handover:confirm only accepts named options");
    const result = await new ConfirmRepositoryUnderstanding(
      context.projects,
      context.profiles,
      context.ids,
      context.clock,
      context.transactions,
    ).execute({
      projectId: requiredOption(parsed, "project"),
      summary: requiredOption(parsed, "summary"),
    });
    if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(result));
    else {
      context.io.stdout("Handover repository review confirmed.");
      context.io.stdout(`  project: ${result.projectId}`);
      context.io.stdout(`  scan: ${result.scanId ?? "not recorded"}`);
      context.io.stdout(`  evidence: ${result.fingerprint.slice(0, 16)}`);
      context.io.stdout(
        "  This records project knowledge only; it grants no capability.",
      );
    }
    return 0;
  }

  if (command === "next") {
    const parsed = parseArguments(args, new Set(), new Set(["json"]));
    if (parsed.positionals.length > 1)
      throw new CliUsageError("next accepts at most one project path");
    const report = await handoverService(context).execute(
      requiredPositional(parsed, `${command} path`),
    );
    if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(report));
    else renderHandoverReport(report, context.io);
    return report.handover.state === "unknown" ? 1 : 0;
  }

  if (command === "install") {
    const parsed = parseArguments(args, new Set(), new Set(["json", "rebind"]));
    if (parsed.positionals.length > 1)
      throw new CliUsageError("install accepts at most one project path");
    try {
      const result = await service(context).install({
        rootPath: requiredPositional(parsed, `${command} path`),
        rebind: parsed.flags.has("rebind"),
      });
      if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(result));
      else
        printInstall(
          result,
          await handoverService(context).execute(result.project.root),
          context,
        );
      return result.outcome === "installed" ? 0 : 2;
    } catch (error) {
      if (error instanceof ProjectInstallPartialError) {
        if (parsed.flags.has("json"))
          context.io.stdout(JSON.stringify(error.result));
        else {
          context.io.stderr("AI Office installation is partial.");
          context.io.stderr(error.result.error.message);
          context.io.stderr(error.result.error.recovery);
        }
        return 1;
      }
      const message = lifecycleFailureMessage(error);
      if (parsed.flags.has("json") && message !== null) {
        printJsonFailure("install", message, context);
        return 1;
      }
      throw error;
    }
  }

  if (command === "status") {
    const parsed = parseArguments(args, new Set(), new Set(["json"]));
    if (parsed.positionals.length > 1)
      throw new CliUsageError("status accepts at most one project path");
    const result = await service(context).status(
      requiredPositional(parsed, `${command} path`),
    );
    if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(result));
    else
      printProjectLifecycleStatus(
        result,
        context,
        await handoverService(context).fromStatus(result),
      );
    return projectStatusExitCode(result.health);
  }

  const parsed = parseArguments(args, new Set(["approve"]), new Set(["json"]));
  if (parsed.positionals.length > 1)
    throw new CliUsageError("uninstall accepts at most one project path");
  const rootPath = requiredPositional(parsed, `${command} path`);
  const approvedPlanHash = parsed.options.get("approve");
  if (approvedPlanHash === undefined) {
    try {
      const plan = await service(context).planUninstall(rootPath);
      if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(plan));
      else printUninstallPlan(plan, context);
      return 0;
    } catch (error) {
      const message = lifecycleFailureMessage(error);
      if (parsed.flags.has("json") && message !== null) {
        printJsonFailure("uninstall", message, context);
        return 1;
      }
      throw error;
    }
  }
  try {
    const result = await service(context).uninstall({
      rootPath,
      approvedPlanHash,
    });
    if (parsed.flags.has("json")) context.io.stdout(JSON.stringify(result));
    else printUninstallResult(result, context);
    return 0;
  } catch (error) {
    if (error instanceof ProjectUninstallPartialError) {
      if (parsed.flags.has("json"))
        context.io.stdout(JSON.stringify(error.result));
      else {
        context.io.stderr("AI Office uninstall is partial.");
        context.io.stderr(error.result.error.message);
        for (const path of error.result.removedPaths)
          context.io.stderr(`Already removed: ${path}`);
        for (const path of error.result.possiblyModifiedPaths)
          context.io.stderr(`Inspect: ${path}`);
        context.io.stderr(error.result.error.recovery);
      }
      return 1;
    }
    const message = lifecycleFailureMessage(error);
    if (parsed.flags.has("json") && message !== null) {
      printJsonFailure("uninstall", message, context);
      return 1;
    }
    throw error;
  }
}

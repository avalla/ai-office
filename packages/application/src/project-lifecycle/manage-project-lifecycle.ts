import { createHash } from "node:crypto";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type {
  AgentClientDetection,
  AgentClientId,
  AgentClientInspection,
} from "../ports/agent-client-adapter.port.ts";
import type { ProjectBindingAdapter } from "../ports/project-binding-adapter.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { OfficeManifestRepository } from "../ports/office-manifest-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { ImportProject } from "../commands/import-project.ts";
import type { ApplyOfficeManifest } from "../commands/apply-office-manifest.ts";
import {
  ManageAgentClientIntegration,
  type AgentClientIntegrationPlan,
} from "../agent-client/manage-agent-client-integration.ts";
import {
  ProjectBindingError,
  projectBindingFile,
  type ProjectBindingInspection,
  type ProjectBindingRemovePlan,
} from "./project-binding.ts";
import { buildProjectInstructionContract } from "./build-project-instructions.ts";

export type LifecycleHealth = "healthy" | "needs_attention" | "not_installed";

export type LifecycleBindingState =
  "valid" | "missing" | "invalid" | "stale" | "conflicting" | "unverified";

export interface LifecycleIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  recovery?: string;
}

export interface LifecycleClientStatus {
  clientId: AgentClientId;
  displayName: string;
  detection: AgentClientDetection["status"];
  configuration:
    | "configured"
    | "unmanaged"
    | "drifted"
    | "missing"
    | "conflict"
    | "not_configured";
  issues: readonly string[];
}

export interface ProjectLifecycleStatus {
  schemaVersion: 1;
  installed: boolean;
  health: LifecycleHealth;
  project: {
    id: string | null;
    name: string | null;
    root: string;
    binding: {
      path: string;
      state: LifecycleBindingState;
    };
  };
  runtime: {
    daemon: "reachable" | "unreachable";
    authoritativeState: "available" | "unavailable" | "project_missing";
  };
  office: {
    state: "configured" | "missing" | "unavailable";
    revision: number | null;
    name: string | null;
    roles: readonly string[];
  };
  clients: readonly LifecycleClientStatus[];
  tasks: {
    open: number;
    wip: number;
  } | null;
  issues: readonly LifecycleIssue[];
}

export interface ProjectInstallResult {
  schemaVersion: 1;
  project: {
    id: string;
    name: string;
    root: string;
    created: boolean;
  };
  office: {
    revision: number;
    created: boolean;
    name: string;
    roles: readonly string[];
  };
  binding: {
    path: typeof projectBindingFile;
    action: "create" | "update" | "none";
  };
  clients: readonly LifecycleClientStatus[];
  changes: readonly {
    kind: "create" | "update";
    relativePath: string;
  }[];
  warnings: readonly string[];
}

interface ClientUninstallStep {
  clientId: AgentClientId;
  inspection: AgentClientInspection;
  plan: AgentClientIntegrationPlan;
}

export interface ProjectUninstallPlan {
  schemaVersion: 1;
  action: "uninstall";
  rootPath: string;
  projectId: string | null;
  installed: boolean;
  planHash: string;
  changes: readonly {
    kind: "delete" | "update";
    relativePath: string;
    owner: "ai-office";
  }[];
  preserved: readonly string[];
  warnings: readonly string[];
  bindingPlan: ProjectBindingRemovePlan;
  clientSteps: readonly ClientUninstallStep[];
}

export interface ProjectUninstallResult {
  schemaVersion: 1;
  uninstalled: boolean;
  rootPath: string;
  projectId: string | null;
  removedPaths: readonly string[];
  preserved: readonly string[];
  runtimeStatePreserved: true;
  globalMemoryPreserved: true;
}

export class ProjectLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectLifecycleError";
  }
}

interface ProjectLifecycleDependencies {
  projects: ProjectRepository;
  profiles: ProjectProfileRepository;
  manifests: OfficeManifestRepository;
  tasks: TaskRepository;
  importer: ImportProject;
  manifestApplicator: ApplyOfficeManifest;
  clients: ManageAgentClientIntegration;
  bindings: ProjectBindingAdapter;
  defaultManifest: OfficeManifest;
}

function lifecycleHash(value: Readonly<object>): string {
  return createHash("sha256")
    .update(canonicalStringify(value), "utf8")
    .digest("hex");
}

function clientChangesMatch(
  actual: AgentClientIntegrationPlan["changes"],
  expected: readonly {
    kind: "create" | "update" | "delete";
    relativePath: string;
    expectedSha256: string | null;
  }[],
): boolean {
  const projection = (
    change: (typeof actual)[number] | (typeof expected)[number],
  ) => ({
    kind: change.kind,
    relativePath: change.relativePath,
    expectedSha256: change.expectedSha256,
  });
  return (
    canonicalStringify(actual.map(projection)) ===
    canonicalStringify(expected.map(projection))
  );
}

function issueMessages(inspection: AgentClientInspection): string[] {
  return inspection.issues.map((issue) => issue.message).sort();
}

function hasManagedClientState(
  clientId: AgentClientId,
  inspection: AgentClientInspection,
): boolean {
  if (clientId === "codex")
    return inspection.canonicalInstructions.ownership === "ai_office_owned";
  return (
    inspection.clientInstructions?.ownership === "ai_office_owned" ||
    inspection.clientInstructions?.ownership === "merged"
  );
}

async function clientStatus(
  service: ManageAgentClientIntegration,
  detection: AgentClientDetection,
  rootPath: string,
  manifest: OfficeManifest | null,
  projectName: string | null,
): Promise<LifecycleClientStatus> {
  const inspection = await service.inspect(detection.clientId, rootPath);
  const validation = await service.validate(detection.clientId, rootPath);
  const hasConflict = [...inspection.issues, ...validation.issues].some(
    (issue) => issue.severity === "conflict",
  );
  let configuration: LifecycleClientStatus["configuration"];

  if (hasConflict) configuration = "conflict";
  else if (inspection.canonicalInstructions.integrationStatus === "unmanaged")
    configuration = "unmanaged";
  else if (manifest !== null && projectName !== null) {
    const plan = await service.plan({
      clientId: detection.clientId,
      rootPath,
      contract: buildProjectInstructionContract({ projectName, manifest }),
    });
    if (validation.valid && plan.changes.length === 0)
      configuration = "configured";
    else if (hasManagedClientState(detection.clientId, inspection))
      configuration = "drifted";
    else configuration = "missing";
  } else if (validation.valid) configuration = "configured";
  else if (hasManagedClientState(detection.clientId, inspection))
    configuration = "drifted";
  else
    configuration =
      detection.status === "detected" ? "missing" : "not_configured";

  return {
    clientId: detection.clientId,
    displayName: detection.displayName,
    detection: detection.status,
    configuration,
    issues: issueMessages(inspection),
  };
}

function assertUsableInspection(
  inspection: ProjectBindingInspection,
): asserts inspection is ProjectBindingInspection & {
  status: "valid";
  binding: { schemaVersion: 1; managedBy: "ai-office"; projectId: string };
  sha256: string;
} {
  if (inspection.status === "invalid")
    throw new ProjectBindingError(
      `${inspection.issue ?? "Project binding is invalid"}. Resolve or remove ${projectBindingFile} explicitly.`,
    );
  if (inspection.status !== "valid" || inspection.binding === undefined)
    throw new ProjectLifecycleError(
      "AI Office is not installed for this repository",
    );
}

export class ManageProjectLifecycle {
  constructor(private readonly dependencies: ProjectLifecycleDependencies) {}

  async install(input: {
    rootPath: string;
    rebind?: boolean;
  }): Promise<ProjectInstallResult> {
    const { bindings, profiles, projects } = this.dependencies;
    const discovered = await bindings.inspect(input.rootPath);
    if (discovered.status === "invalid") assertUsableInspection(discovered);
    const rootPath = discovered.rootPath;
    const boundProjectId = discovered.binding?.projectId;
    const projectAtPath = await profiles.findProjectIdByLocalPath(rootPath);

    let projectId: string;
    let projectCreated = false;
    if (boundProjectId !== undefined && input.rebind !== true) {
      const boundProject = await projects.findById(boundProjectId);
      if (boundProject === null)
        throw new ProjectLifecycleError(
          `The local binding points to project ${boundProjectId}, but that project is missing from the current runtime. Run install with --rebind only if you intend to create a new runtime association.`,
        );
      if (projectAtPath !== boundProjectId)
        throw new ProjectLifecycleError(
          projectAtPath === null
            ? `Project ${boundProjectId} exists, but this canonical root is not associated with it. The repository may have moved or been cloned; use --rebind to create a new association without changing the existing project.`
            : `This canonical root belongs to project ${projectAtPath}, but its binding points to ${boundProjectId}. Resolve the conflicting association explicitly.`,
        );
      projectId = boundProjectId;
    } else if (projectAtPath !== null) {
      projectId = projectAtPath;
    } else {
      const imported = await this.dependencies.importer.execute({ rootPath });
      projectId = imported.projectId;
      projectCreated = imported.created;
    }

    const project = await projects.findById(projectId);
    if (project === null)
      throw new ProjectLifecycleError(
        `Project ${projectId} disappeared during installation`,
      );
    const projectSnapshot = project.snapshot();

    let office = await this.dependencies.manifests.findLatest(projectId);
    const prospectiveManifest =
      office?.manifest ?? this.dependencies.defaultManifest;

    const detections = await this.dependencies.clients.detect();
    const initialInspections = await Promise.all(
      detections.map(async (detection) => ({
        detection,
        inspection: await this.dependencies.clients.inspect(
          detection.clientId,
          rootPath,
        ),
      })),
    );
    const candidates = initialInspections.filter(
      ({ detection, inspection }) =>
        detection.status === "detected" ||
        hasManagedClientState(detection.clientId, inspection),
    );
    const contract = buildProjectInstructionContract({
      projectName: projectSnapshot.name,
      manifest: prospectiveManifest,
    });
    for (const { detection } of candidates) {
      const preflight = await this.dependencies.clients.plan({
        clientId: detection.clientId,
        rootPath,
        contract,
      });
      if (preflight.issues.some((issue) => issue.severity === "conflict"))
        throw new ProjectLifecycleError(
          `${detection.displayName} integration has a conflict: ${preflight.issues
            .filter((issue) => issue.severity === "conflict")
            .map((issue) => issue.message)
            .join("; ")}`,
        );
    }

    let officeCreated = false;
    if (office === null) {
      office = await this.dependencies.manifestApplicator.execute(
        projectId,
        prospectiveManifest,
      );
      officeCreated = true;
    }

    const bindingPlan = await bindings.planWrite(rootPath, {
      schemaVersion: 1,
      managedBy: "ai-office",
      projectId,
    });
    await bindings.applyWrite(bindingPlan);

    const changes: Array<{
      kind: "create" | "update";
      relativePath: string;
    }> = [];
    for (const { detection } of candidates) {
      const plan = await this.dependencies.clients.plan({
        clientId: detection.clientId,
        rootPath,
        contract,
      });
      await this.dependencies.clients.apply({
        clientId: detection.clientId,
        rootPath,
        contract,
        approvedPlanHash: plan.planHash,
      });
      changes.push(
        ...plan.changes
          .filter(
            (
              change,
            ): change is typeof change & {
              kind: "create" | "update";
            } => change.kind !== "delete",
          )
          .map((change) => ({
            kind: change.kind,
            relativePath: change.relativePath,
          })),
      );
    }

    const clients = await Promise.all(
      detections.map((detection) =>
        clientStatus(
          this.dependencies.clients,
          detection,
          rootPath,
          office.manifest,
          projectSnapshot.name,
        ),
      ),
    );
    const candidateIds = new Set(
      candidates.map(({ detection }) => detection.clientId),
    );
    const warnings = clients
      .filter((client) => candidateIds.has(client.clientId))
      .flatMap((client) => client.issues);
    return {
      schemaVersion: 1,
      project: {
        id: projectId,
        name: projectSnapshot.name,
        root: rootPath,
        created: projectCreated,
      },
      office: {
        revision: office.revision,
        created: officeCreated,
        name: office.manifest.office.name,
        roles: office.manifest.office.roles.map((role) => role.title),
      },
      binding: { path: projectBindingFile, action: bindingPlan.action },
      clients,
      changes,
      warnings: [...new Set(warnings)].sort(),
    };
  }

  async status(rootPath: string): Promise<ProjectLifecycleStatus> {
    const inspection = await this.dependencies.bindings.inspect(rootPath, {
      ancestors: true,
    });
    if (inspection.status !== "valid" || inspection.binding === undefined) {
      const issue: LifecycleIssue =
        inspection.status === "invalid"
          ? {
              severity: "error",
              code: "binding_invalid",
              message: inspection.issue ?? "Project binding is invalid",
              recovery: `Repair or remove ${projectBindingFile} explicitly`,
            }
          : {
              severity: "warning",
              code: "not_installed",
              message: "AI Office is not installed for this repository",
              recovery: "Run: ai-office install .",
            };
      return {
        schemaVersion: 1,
        installed: false,
        health:
          inspection.status === "invalid" ? "needs_attention" : "not_installed",
        project: {
          id: null,
          name: null,
          root: inspection.rootPath,
          binding: {
            path: inspection.bindingPath,
            state: inspection.status === "invalid" ? "invalid" : "missing",
          },
        },
        runtime: { daemon: "reachable", authoritativeState: "available" },
        office: { state: "unavailable", revision: null, name: null, roles: [] },
        clients: [],
        tasks: null,
        issues: [issue],
      };
    }

    const projectId = inspection.binding.projectId;
    const project = await this.dependencies.projects.findById(projectId);
    const projectAtPath =
      await this.dependencies.profiles.findProjectIdByLocalPath(
        inspection.rootPath,
      );
    const issues: LifecycleIssue[] = [];
    let bindingState: LifecycleBindingState = "valid";
    if (project === null) {
      bindingState = "stale";
      issues.push({
        severity: "error",
        code: "project_missing",
        message: `Project ${projectId} is missing from authoritative runtime state`,
        recovery:
          "Run install with --rebind only if a new association is intended",
      });
    } else if (projectAtPath !== projectId) {
      bindingState = "conflicting";
      issues.push({
        severity: "error",
        code: "binding_root_mismatch",
        message:
          projectAtPath === null
            ? "The canonical repository root is not associated with the bound project"
            : `The canonical repository root is associated with project ${projectAtPath}`,
        recovery:
          "Resolve the project association explicitly before reinstalling",
      });
    }

    const office =
      project === null
        ? null
        : await this.dependencies.manifests.findLatest(projectId);
    if (project !== null && office === null)
      issues.push({
        severity: "warning",
        code: "office_missing",
        message: "No office manifest is configured for this project",
        recovery:
          "Run ai-office install . to apply the default office baseline",
      });

    const detections = await this.dependencies.clients.detect();
    const projectName = project?.snapshot().name ?? null;
    const clients = await Promise.all(
      detections.map((detection) =>
        clientStatus(
          this.dependencies.clients,
          detection,
          inspection.rootPath,
          office?.manifest ?? null,
          projectName,
        ),
      ),
    );
    for (const client of clients) {
      if (
        client.detection === "detected" &&
        client.configuration !== "configured"
      )
        issues.push({
          severity: client.configuration === "conflict" ? "error" : "warning",
          code: `client_${client.clientId}_${client.configuration}`,
          message: `${client.displayName} integration is ${client.configuration}`,
          recovery:
            "Run ai-office install . after resolving user-owned conflicts",
        });
    }

    const tasks =
      project === null
        ? null
        : await this.dependencies.tasks.listByProject(projectId);
    const snapshots = tasks?.map((task) => task.snapshot()) ?? [];
    const terminal = new Set(["completed", "failed", "cancelled"]);
    const wip = new Set(["assigned", "running", "blocked", "waiting_review"]);
    const healthy =
      bindingState === "valid" &&
      office !== null &&
      issues.every((issue) => issue.severity !== "error") &&
      clients.every(
        (client) =>
          client.detection !== "detected" ||
          client.configuration === "configured",
      );
    return {
      schemaVersion: 1,
      installed: true,
      health: healthy ? "healthy" : "needs_attention",
      project: {
        id: projectId,
        name: projectName,
        root: inspection.rootPath,
        binding: { path: inspection.bindingPath, state: bindingState },
      },
      runtime: {
        daemon: "reachable",
        authoritativeState: project === null ? "project_missing" : "available",
      },
      office:
        office === null
          ? { state: "missing", revision: null, name: null, roles: [] }
          : {
              state: "configured",
              revision: office.revision,
              name: office.manifest.office.name,
              roles: office.manifest.office.roles.map((role) => role.title),
            },
      clients,
      tasks:
        tasks === null
          ? null
          : {
              open: snapshots.filter((task) => !terminal.has(task.status))
                .length,
              wip: snapshots.filter((task) => wip.has(task.status)).length,
            },
      issues,
    };
  }

  async planUninstall(rootPath: string): Promise<ProjectUninstallPlan> {
    const inspection = await this.dependencies.bindings.inspect(rootPath, {
      ancestors: true,
    });
    if (inspection.status === "invalid") assertUsableInspection(inspection);
    const bindingPlan = await this.dependencies.bindings.planRemove(
      inspection.rootPath,
    );
    const detections = await this.dependencies.clients.detect();
    const clientSteps: ClientUninstallStep[] = [];
    for (const clientId of inspection.status === "valid"
      ? (["claude", "codex"] as const)
      : ([] as const)) {
      const detection = detections.find((item) => item.clientId === clientId);
      if (detection === undefined) continue;
      clientSteps.push({
        clientId,
        inspection: await this.dependencies.clients.inspect(
          clientId,
          inspection.rootPath,
        ),
        plan: await this.dependencies.clients.planUninstall({
          clientId,
          rootPath: inspection.rootPath,
        }),
      });
    }
    const changes: Array<{
      kind: "delete" | "update";
      relativePath: string;
      owner: "ai-office";
    }> = [
      ...clientSteps.flatMap((step) =>
        step.plan.changes.map((change) => ({
          kind:
            change.kind === "delete"
              ? ("delete" as const)
              : ("update" as const),
          relativePath: change.relativePath,
          owner: "ai-office" as const,
        })),
      ),
      ...(bindingPlan.action === "delete"
        ? [
            {
              kind: "delete" as const,
              relativePath: projectBindingFile,
              owner: "ai-office" as const,
            },
          ]
        : []),
    ];
    const claudeStep = clientSteps.find((step) => step.clientId === "claude");
    const codexStep = clientSteps.find((step) => step.clientId === "codex");
    const removesClaudeDependency =
      claudeStep?.plan.changes.some(
        (change) => change.relativePath === "CLAUDE.md",
      ) === true;
    const managedCanonical =
      codexStep?.inspection.canonicalInstructions.ownership ===
      "ai_office_owned";
    if (
      removesClaudeDependency &&
      managedCanonical &&
      !changes.some((change) => change.relativePath === "AGENTS.md")
    )
      changes.push({
        kind: "delete",
        relativePath: "AGENTS.md",
        owner: "ai-office",
      });
    changes.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    const preserved = clientSteps.flatMap((step) =>
      step.plan.issues
        .filter(
          (issue) =>
            issue.severity === "warning" &&
            !(
              removesClaudeDependency &&
              managedCanonical &&
              issue.code === "claude_canonical_dependency_preserved"
            ),
        )
        .map((issue) => `${step.clientId}: ${issue.message}`),
    );
    const warnings = clientSteps.flatMap((step) =>
      step.plan.issues
        .filter(
          (issue) =>
            !(
              removesClaudeDependency &&
              managedCanonical &&
              issue.code === "claude_canonical_dependency_preserved"
            ),
        )
        .map((issue) => issue.message),
    );
    const publicBasis = {
      schemaVersion: 1 as const,
      action: "uninstall" as const,
      rootPath: inspection.rootPath,
      projectId: inspection.binding?.projectId ?? null,
      installed: inspection.status === "valid",
      changes,
      preserved,
      warnings,
      bindingPlan,
      clientSteps,
    };
    return { ...publicBasis, planHash: lifecycleHash(publicBasis) };
  }

  async uninstall(input: {
    rootPath: string;
    approvedPlanHash: string;
  }): Promise<ProjectUninstallResult> {
    const current = await this.planUninstall(input.rootPath);
    if (current.planHash !== input.approvedPlanHash)
      throw new ProjectLifecycleError(
        "Project uninstall approval does not match the current plan",
      );
    if (!current.installed)
      return {
        schemaVersion: 1,
        uninstalled: false,
        rootPath: current.rootPath,
        projectId: null,
        removedPaths: [],
        preserved: [],
        runtimeStatePreserved: true,
        globalMemoryPreserved: true,
      };
    if (
      current.clientSteps.some((step) =>
        step.plan.issues.some((issue) => issue.severity === "conflict"),
      )
    )
      throw new ProjectLifecycleError(
        "Project uninstall is blocked by an ambiguous client integration",
      );

    const removedPaths: string[] = [];
    for (const clientId of ["claude", "codex"] as const) {
      const approvedStep = current.clientSteps.find(
        (step) => step.clientId === clientId,
      );
      if (approvedStep === undefined) continue;
      const plan = await this.dependencies.clients.planUninstall({
        clientId,
        rootPath: current.rootPath,
      });
      const expectedChanges = [...approvedStep.plan.changes];
      if (
        clientId === "codex" &&
        current.changes.some(
          (change) =>
            change.kind === "delete" && change.relativePath === "AGENTS.md",
        ) &&
        !expectedChanges.some((change) => change.relativePath === "AGENTS.md")
      ) {
        const expectedSha256 =
          approvedStep.inspection.canonicalInstructions.sha256;
        if (expectedSha256 === undefined)
          throw new ProjectLifecycleError(
            "The approved uninstall plan has no AGENTS.md precondition",
          );
        expectedChanges.push({
          kind: "delete",
          relativePath: "AGENTS.md",
          expectedSha256,
          ownershipAfter: "absent",
          summary: "Delete AI Office-managed canonical project instructions",
        });
      }
      if (!clientChangesMatch(plan.changes, expectedChanges))
        throw new ProjectLifecycleError(
          "Client integration changed after lifecycle approval; request a new uninstall plan",
        );
      await this.dependencies.clients.uninstall({
        clientId,
        rootPath: current.rootPath,
        approvedPlanHash: plan.planHash,
      });
      removedPaths.push(...plan.changes.map((change) => change.relativePath));
    }
    await this.dependencies.bindings.applyRemove(current.bindingPlan);
    if (current.bindingPlan.action === "delete")
      removedPaths.push(projectBindingFile);
    return {
      schemaVersion: 1,
      uninstalled: current.installed,
      rootPath: current.rootPath,
      projectId: current.projectId,
      removedPaths: [...new Set(removedPaths)],
      preserved: current.preserved,
      runtimeStatePreserved: true,
      globalMemoryPreserved: true,
    };
  }
}

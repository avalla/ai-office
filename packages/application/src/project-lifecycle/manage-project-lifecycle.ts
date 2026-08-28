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
import type { RepositoryIdentityRepository } from "../ports/repository-identity-repository.port.ts";
import type { OfficeManifestRepository } from "../ports/office-manifest-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";
import {
  ProjectSourceAssociationError,
  type ImportProject,
} from "../commands/import-project.ts";
import type { ApplyOfficeManifest } from "../commands/apply-office-manifest.ts";
import {
  ManageAgentClientIntegration,
  type AgentClientIntegrationPlan,
} from "../agent-client/manage-agent-client-integration.ts";
import {
  ProjectBindingError,
  projectBindingFile,
  repositoryIdFromLegacyProjectId,
  type ProjectBindingInspection,
} from "./project-binding.ts";
import { buildProjectInstructionContract } from "./build-project-instructions.ts";

export type LifecycleHealth = "healthy" | "needs_attention" | "not_installed";
export type RepositoryIdentityState =
  "valid" | "legacy" | "missing" | "invalid";
export type RuntimeAssociationState =
  "valid" | "missing" | "unverified" | "conflicting" | "project_missing";

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
    | "unverified"
    | "missing"
    | "conflict"
    | "not_configured";
  issues: readonly string[];
}

export interface ProjectLifecycleStatus {
  schemaVersion: 3;
  installed: boolean | null;
  health: LifecycleHealth;
  project: {
    id: string | null;
    name: string | null;
    root: string;
    repositoryIdentity: {
      id: string | null;
      path: string;
      state: RepositoryIdentityState;
    };
    runtimeAssociation: {
      projectId: string | null;
      state: RuntimeAssociationState;
    };
  };
  runtime: {
    daemon: "reachable" | "unreachable";
    home: string;
    authoritativeState:
      | "available"
      | "unavailable"
      | "project_missing"
      | "repository_unassociated";
  };
  office: {
    state: "default_baseline" | "configured" | "missing" | "unavailable";
    onboarding: "not_completed" | "not_tracked" | "unavailable";
    revision: number | null;
    name: string | null;
    roles: readonly string[];
  };
  clients: readonly LifecycleClientStatus[];
  tasks: { open: number; wip: number } | null;
  pipeline?: {
    state:
      | "guidance_only"
      | "enforcement_enabled_no_run"
      | "active"
      | "awaiting_approval"
      | "assignment_missing"
      | "drifted"
      | "unavailable";
    configured: readonly { id: string; mode: "guidance" | "enforced" }[];
    activeRuns: number;
    currentStages: readonly string[];
  };
  issues: readonly LifecycleIssue[];
}

export interface ProjectInstallResult {
  schemaVersion: 2;
  outcome: "installed" | "installed_with_warnings";
  project: {
    id: string;
    repositoryId: string;
    name: string;
    root: string;
    created: boolean;
    association: "created" | "reused";
  };
  office: {
    revision: number;
    created: boolean;
    state: "default_baseline" | "configured";
    onboarding: "not_completed" | "not_tracked";
    name: string;
    roles: readonly string[];
  };
  repositoryIdentity: {
    path: typeof projectBindingFile;
    action: "create" | "update" | "none";
    migratedFromSchemaVersion: 1 | null;
  };
  clients: readonly LifecycleClientStatus[];
  changes: readonly { kind: "create" | "update"; relativePath: string }[];
  issues: readonly LifecycleIssue[];
}

export interface ProjectInstallPartialResult {
  schemaVersion: 2;
  outcome: "partial";
  project: {
    id: string;
    repositoryId: string;
    name: string;
    root: string;
  };
  completed: {
    projectCreated: boolean;
    sourceAssociated: boolean;
    repositoryMapped: boolean;
    officeApplied: boolean;
    repositoryIdentityWritten: boolean;
    clientPaths: readonly string[];
  };
  error: { message: string; recovery: string };
}

interface ClientUninstallStep {
  clientId: AgentClientId;
  inspection: AgentClientInspection;
  plan: AgentClientIntegrationPlan;
}

export interface ProjectUninstallPlan {
  schemaVersion: 2;
  action: "uninstall";
  rootPath: string;
  repositoryId: string | null;
  projectId: string | null;
  installed: boolean;
  planHash: string;
  changes: readonly {
    kind: "delete" | "update" | "detach";
    relativePath: string;
    owner: "ai-office";
  }[];
  preserved: readonly string[];
  warnings: readonly string[];
  repositoryIdentitySha256: string | null;
  clientSteps: readonly ClientUninstallStep[];
}

export interface ProjectUninstallResult {
  schemaVersion: 2;
  uninstalled: boolean;
  rootPath: string;
  repositoryId: string | null;
  projectId: string | null;
  removedPaths: readonly string[];
  preserved: readonly string[];
  repositoryIdentityPreserved: true;
  runtimeStatePreserved: true;
  globalMemoryPreserved: true;
}

export interface ProjectUninstallPartialResult {
  schemaVersion: 2;
  outcome: "partial";
  rootPath: string;
  repositoryId: string | null;
  projectId: string | null;
  removedPaths: readonly string[];
  possiblyModifiedPaths: readonly string[];
  associationRemoved: boolean;
  repositoryIdentityPreserved: true;
  error: { message: string; recovery: string };
}

export class ProjectLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectLifecycleError";
  }
}

export class ProjectInstallPartialError extends ProjectLifecycleError {
  constructor(readonly result: ProjectInstallPartialResult) {
    super(result.error.message);
    this.name = "ProjectInstallPartialError";
  }
}

export class ProjectUninstallPartialError extends ProjectLifecycleError {
  constructor(readonly result: ProjectUninstallPartialResult) {
    super(result.error.message);
    this.name = "ProjectUninstallPartialError";
  }
}

interface ProjectLifecycleDependencies {
  projects: ProjectRepository;
  profiles: ProjectProfileRepository;
  identities: RepositoryIdentityRepository;
  manifests: OfficeManifestRepository;
  tasks: TaskRepository;
  pipelines?: PipelineRunRepository;
  importer: ImportProject;
  manifestApplicator: ApplyOfficeManifest;
  clients: ManageAgentClientIntegration;
  bindings: ProjectBindingAdapter;
  ids: IdGenerator;
  clock: Clock;
  runtimeHome: string;
  defaultManifest: OfficeManifest;
}

function lifecycleHash(value: Readonly<object>): string {
  return createHash("sha256")
    .update(canonicalStringify(value), "utf8")
    .digest("hex");
}

function isDefaultManifest(
  manifest: OfficeManifest,
  baseline: OfficeManifest,
): boolean {
  return canonicalStringify(manifest) === canonicalStringify(baseline);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown lifecycle failure";
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
    return inspection.clientInstructions?.ownership === "ai_office_owned";
  return (
    inspection.skillInstructions?.ownership === "ai_office_owned" ||
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
  const hasConflict =
    inspection.issues.some((issue) => issue.severity === "conflict") ||
    (detection.status === "detected" &&
      validation.issues.some((issue) => issue.severity === "conflict"));
  let configuration: LifecycleClientStatus["configuration"];

  if (hasConflict) configuration = "conflict";
  else if (
    inspection.canonicalInstructions.integrationStatus === "unmanaged" ||
    (inspection.clientInstructions?.ownership === "user_owned" &&
      inspection.clientInstructions.integrationStatus === "integrated") ||
    inspection.clientInstructions?.integrationStatus === "unmanaged" ||
    inspection.sharedSkillInstructions?.integrationStatus === "unmanaged" ||
    inspection.skillInstructions?.integrationStatus === "unmanaged"
  )
    configuration = "unmanaged";
  else if (
    detection.status === "not_detected" &&
    !hasManagedClientState(detection.clientId, inspection)
  )
    configuration = "not_configured";
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

function clientIssues(
  clients: readonly LifecycleClientStatus[],
): LifecycleIssue[] {
  const issues: LifecycleIssue[] = [];
  if (!clients.some((client) => client.detection === "detected"))
    issues.push({
      severity: "warning",
      code: "no_supported_client_detected",
      message: "No supported coding client was detected",
      recovery:
        "Install a supported client separately if desired, then rerun ai-office install .",
    });
  for (const client of clients) {
    const requiresAttention =
      (client.detection === "detected" &&
        client.configuration !== "configured") ||
      (client.detection === "not_detected" &&
        (client.configuration === "drifted" ||
          client.configuration === "conflict"));
    if (requiresAttention)
      issues.push({
        severity: client.configuration === "conflict" ? "error" : "warning",
        code: `client_${client.clientId}_${client.configuration}`,
        message: `${client.displayName} integration is ${client.configuration}`,
        recovery:
          "Inspect the user-owned files, resolve conflicts, and rerun ai-office install .",
      });
  }
  return issues;
}

function repositoryIdFor(
  inspection: ProjectBindingInspection,
  ids: IdGenerator,
  rebind: boolean,
): { repositoryId: string; legacyProjectId: string | null } {
  if (rebind)
    return { repositoryId: `repo_${ids.generate()}`, legacyProjectId: null };
  if (inspection.binding?.schemaVersion === 2)
    return {
      repositoryId: inspection.binding.repositoryId,
      legacyProjectId: null,
    };
  if (inspection.binding?.schemaVersion === 1)
    return {
      repositoryId: repositoryIdFromLegacyProjectId(
        inspection.binding.projectId,
      ),
      legacyProjectId: inspection.binding.projectId,
    };
  return { repositoryId: `repo_${ids.generate()}`, legacyProjectId: null };
}

export class ManageProjectLifecycle {
  constructor(private readonly dependencies: ProjectLifecycleDependencies) {}

  async install(input: {
    rootPath: string;
    rebind?: boolean;
  }): Promise<ProjectInstallResult> {
    const { bindings, profiles, projects, identities } = this.dependencies;
    const resolvedRoot = await bindings.resolveProjectRoot(input.rootPath);
    const inspection = await bindings.inspect(resolvedRoot);
    if (inspection.status === "invalid")
      throw new ProjectBindingError(
        `${inspection.issue ?? "Project binding is invalid"}. Resolve or remove ${projectBindingFile} explicitly.`,
      );
    const rootPath = inspection.rootPath;
    const projectAtPath = await profiles.findProjectIdByLocalPath(rootPath);
    let { repositoryId, legacyProjectId } = repositoryIdFor(
      inspection,
      this.dependencies.ids,
      input.rebind === true,
    );
    if (input.rebind === true && projectAtPath !== null) {
      repositoryId =
        (await identities.findRepositoryId(projectAtPath)) ?? repositoryId;
      legacyProjectId = null;
    }
    const projectByIdentity = await identities.findProjectId(repositoryId);
    if (
      projectAtPath !== null &&
      projectByIdentity !== null &&
      projectAtPath !== projectByIdentity
    )
      throw new ProjectLifecycleError(
        `Repository identity ${repositoryId} belongs to project ${projectByIdentity}, but this canonical path belongs to ${projectAtPath}. Resolve the copied or conflicting identity explicitly.`,
      );

    let projectId: string;
    let projectCreated = false;
    let sourceAssociated = false;
    if (projectByIdentity !== null) {
      projectId = projectByIdentity;
      if (projectAtPath === null) {
        await this.dependencies.importer.execute({ rootPath, projectId });
        sourceAssociated = true;
      }
    } else if (projectAtPath !== null) projectId = projectAtPath;
    else {
      const legacyProject =
        legacyProjectId === null
          ? null
          : await projects.findById(legacyProjectId);
      if (legacyProject !== null) {
        projectId = legacyProjectId!;
        await this.dependencies.importer.execute({ rootPath, projectId });
        sourceAssociated = true;
      } else {
        const imported = await this.dependencies.importer.execute({ rootPath });
        projectId = imported.projectId;
        projectCreated = imported.created;
      }
    }

    const project = await projects.findById(projectId);
    if (project === null)
      throw new ProjectLifecycleError(
        `Project ${projectId} disappeared during installation`,
      );
    const projectSnapshot = project.snapshot();
    let repositoryMapped = false;
    let officeApplied = false;
    let repositoryIdentityWritten = false;
    const clientPaths: string[] = [];

    try {
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
        ({ detection, inspection: clientInspection }) =>
          detection.status === "detected" ||
          hasManagedClientState(detection.clientId, clientInspection),
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

      const association = await identities.associate({
        repositoryId,
        projectId,
        createdAt: this.dependencies.clock.now(),
      });
      if (association === "conflict")
        throw new ProjectLifecycleError(
          `Repository identity ${repositoryId} conflicts with an existing runtime association`,
        );
      repositoryMapped = association === "created";

      let officeCreated = false;
      if (office === null) {
        office = await this.dependencies.manifestApplicator.execute(
          projectId,
          prospectiveManifest,
        );
        officeCreated = true;
        officeApplied = true;
      }

      const bindingPlan = await bindings.planWrite(rootPath, {
        schemaVersion: 2,
        managedBy: "ai-office",
        repositoryId,
      });
      await bindings.applyWrite(bindingPlan);
      repositoryIdentityWritten = bindingPlan.action !== "none";

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
        const applied = plan.changes
          .filter(
            (change): change is typeof change & { kind: "create" | "update" } =>
              change.kind !== "delete",
          )
          .map((change) => ({
            kind: change.kind,
            relativePath: change.relativePath,
          }));
        changes.push(...applied);
        clientPaths.push(...applied.map((change) => change.relativePath));
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
      const issues = clientIssues(clients);
      const baseline = isDefaultManifest(
        office.manifest,
        this.dependencies.defaultManifest,
      );
      return {
        schemaVersion: 2,
        outcome: issues.length === 0 ? "installed" : "installed_with_warnings",
        project: {
          id: projectId,
          repositoryId,
          name: projectSnapshot.name,
          root: rootPath,
          created: projectCreated,
          association:
            projectCreated || sourceAssociated || repositoryMapped
              ? "created"
              : "reused",
        },
        office: {
          revision: office.revision,
          created: officeCreated,
          state: baseline ? "default_baseline" : "configured",
          onboarding: baseline ? "not_completed" : "not_tracked",
          name: office.manifest.office.name,
          roles: office.manifest.office.roles.map((role) => role.title),
        },
        repositoryIdentity: {
          path: projectBindingFile,
          action: bindingPlan.action,
          migratedFromSchemaVersion:
            inspection.binding?.schemaVersion === 1 ? 1 : null,
        },
        clients,
        changes,
        issues,
      };
    } catch (error) {
      const changed =
        projectCreated ||
        sourceAssociated ||
        repositoryMapped ||
        officeApplied ||
        repositoryIdentityWritten ||
        clientPaths.length > 0;
      if (!changed || error instanceof ProjectSourceAssociationError)
        throw error;
      throw new ProjectInstallPartialError({
        schemaVersion: 2,
        outcome: "partial",
        project: {
          id: projectId,
          repositoryId,
          name: projectSnapshot.name,
          root: rootPath,
        },
        completed: {
          projectCreated,
          sourceAssociated,
          repositoryMapped,
          officeApplied,
          repositoryIdentityWritten,
          clientPaths: [...new Set(clientPaths)],
        },
        error: {
          message: errorMessage(error),
          recovery:
            "No rollback was attempted. Run ai-office status, resolve the reported conflict, then rerun ai-office install .",
        },
      });
    }
  }

  async status(rootPath: string): Promise<ProjectLifecycleStatus> {
    const resolvedRoot =
      await this.dependencies.bindings.resolveProjectRoot(rootPath);
    const inspection = await this.dependencies.bindings.inspect(resolvedRoot);
    const baseProject = {
      id: null,
      name: null,
      root: inspection.rootPath,
      repositoryIdentity: {
        id: null,
        path: inspection.bindingPath,
        state: (inspection.status === "invalid"
          ? "invalid"
          : "missing") as RepositoryIdentityState,
      },
      runtimeAssociation: {
        projectId: null,
        state: "missing" as RuntimeAssociationState,
      },
    };
    if (inspection.status !== "valid" || inspection.binding === undefined) {
      const invalid = inspection.status === "invalid";
      return {
        schemaVersion: 3,
        installed: false,
        health: invalid ? "needs_attention" : "not_installed",
        project: baseProject,
        runtime: {
          daemon: "reachable",
          home: this.dependencies.runtimeHome,
          authoritativeState: "repository_unassociated",
        },
        office: {
          state: "unavailable",
          onboarding: "unavailable",
          revision: null,
          name: null,
          roles: [],
        },
        clients: [],
        tasks: null,
        issues: [
          invalid
            ? {
                severity: "error",
                code: "repository_identity_invalid",
                message: inspection.issue ?? "Repository identity is invalid",
                recovery: `Repair or remove ${projectBindingFile} explicitly`,
              }
            : {
                severity: "warning",
                code: "not_installed",
                message: "AI Office is not installed for this repository",
                recovery: "Run: ai-office install .",
              },
        ],
      };
    }

    const binding = inspection.binding;
    const legacy = binding.schemaVersion === 1;
    const repositoryId =
      binding.schemaVersion === 1
        ? repositoryIdFromLegacyProjectId(binding.projectId)
        : binding.repositoryId;
    const identityProject =
      binding.schemaVersion === 1
        ? binding.projectId
        : await this.dependencies.identities.findProjectId(repositoryId);
    const pathProject =
      await this.dependencies.profiles.findProjectIdByLocalPath(
        inspection.rootPath,
      );
    let associationState: RuntimeAssociationState = "missing";
    let projectId: string | null = null;
    if (
      identityProject !== null &&
      pathProject !== null &&
      identityProject !== pathProject
    ) {
      associationState = "conflicting";
      projectId = identityProject;
    } else if (identityProject !== null && identityProject === pathProject) {
      associationState = "valid";
      projectId = identityProject;
    } else projectId = identityProject ?? pathProject;

    const project =
      projectId === null
        ? null
        : await this.dependencies.projects.findById(projectId);
    if (projectId !== null && project === null)
      associationState = "project_missing";
    const issues: LifecycleIssue[] = [];
    if (legacy)
      issues.push({
        severity: "warning",
        code: "repository_identity_legacy",
        message: "The repository uses the legacy runtime-specific binding",
        recovery: "Run ai-office install . to migrate it to schema version 2",
      });
    if (associationState === "missing")
      issues.push({
        severity: "warning",
        code: "runtime_association_missing",
        message:
          "The portable repository identity is not associated with this checkout in the current runtime",
        recovery: "Run: ai-office install .",
      });
    if (associationState === "conflicting")
      issues.push({
        severity: "error",
        code: "runtime_association_conflicting",
        message:
          "Repository identity and canonical checkout path resolve to different projects",
        recovery:
          "Resolve the copied identity or run install --rebind explicitly",
      });
    if (associationState === "project_missing")
      issues.push({
        severity: "error",
        code: "project_missing",
        message: `Project ${projectId} is missing from authoritative state`,
        recovery:
          "Run ai-office install . to establish a new runtime association",
      });

    const office =
      project === null
        ? null
        : await this.dependencies.manifests.findLatest(projectId!);
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
    issues.push(...clientIssues(clients));
    const tasks =
      project === null
        ? null
        : await this.dependencies.tasks.listByProject(projectId!);
    const snapshots = tasks?.map((task) => task.snapshot()) ?? [];
    const terminal = new Set(["completed", "failed", "cancelled"]);
    const wip = new Set(["assigned", "running", "blocked", "waiting_review"]);
    const baseline =
      office === null
        ? false
        : isDefaultManifest(office.manifest, this.dependencies.defaultManifest);
    const installed = associationState === "valid";
    const configuredPipelines =
      office?.manifest.pipelines.map((pipeline) => ({
        id: pipeline.id,
        mode: pipeline.enforcement ?? ("guidance" as const),
      })) ?? [];
    const activePipelineRuns =
      projectId === null || this.dependencies.pipelines === undefined
        ? []
        : await this.dependencies.pipelines.listActiveByProject(projectId);
    const currentPipelineStages = activePipelineRuns
      .map((run) => run.currentStage())
      .filter((stage) => stage !== null);
    const pipelineState: NonNullable<
      ProjectLifecycleStatus["pipeline"]
    >["state"] =
      this.dependencies.pipelines === undefined
        ? "unavailable"
        : configuredPipelines.every((pipeline) => pipeline.mode === "guidance")
          ? "guidance_only"
          : activePipelineRuns.length === 0
            ? "enforcement_enabled_no_run"
            : activePipelineRuns.some(
                  (run) =>
                    office !== null &&
                    run.snapshot().manifestRevision !== office.revision,
                )
              ? "drifted"
              : currentPipelineStages.some(
                    (stage) => stage.status === "awaiting_approval",
                  )
                ? "awaiting_approval"
                : currentPipelineStages.some(
                      (stage) => stage.assignedAgentId === undefined,
                    )
                  ? "assignment_missing"
                  : "active";
    if (pipelineState === "drifted")
      issues.push({
        severity: "warning",
        code: "pipeline_definition_drifted",
        message: "An active pipeline is pinned to an older office revision",
        recovery:
          "Complete or cancel the pinned run before starting a new revision",
      });
    if (pipelineState === "assignment_missing")
      issues.push({
        severity: "warning",
        code: "pipeline_agent_assignment_missing",
        message: "An active pipeline stage has no assigned runtime agent",
        recovery: "Assign a matching registered agent with pipeline:assign",
      });
    return {
      schemaVersion: 3,
      installed,
      health: installed && issues.length === 0 ? "healthy" : "needs_attention",
      project: {
        id: projectId,
        name: projectName,
        root: inspection.rootPath,
        repositoryIdentity: {
          id: repositoryId,
          path: inspection.bindingPath,
          state: legacy ? "legacy" : "valid",
        },
        runtimeAssociation: { projectId, state: associationState },
      },
      runtime: {
        daemon: "reachable",
        home: this.dependencies.runtimeHome,
        authoritativeState:
          associationState === "valid"
            ? "available"
            : associationState === "project_missing"
              ? "project_missing"
              : "repository_unassociated",
      },
      office:
        office === null
          ? {
              state: "missing",
              onboarding: "unavailable",
              revision: null,
              name: null,
              roles: [],
            }
          : {
              state: baseline ? "default_baseline" : "configured",
              onboarding: baseline ? "not_completed" : "not_tracked",
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
      pipeline: {
        state: pipelineState,
        configured: configuredPipelines,
        activeRuns: activePipelineRuns.length,
        currentStages: currentPipelineStages.map((stage) => stage.stageId),
      },
      issues,
    };
  }

  async planUninstall(rootPath: string): Promise<ProjectUninstallPlan> {
    const resolvedRoot =
      await this.dependencies.bindings.resolveProjectRoot(rootPath);
    const inspection = await this.dependencies.bindings.inspect(resolvedRoot);
    if (inspection.status === "invalid")
      throw new ProjectBindingError(
        inspection.issue ?? "Repository identity is invalid",
      );
    let repositoryId: string | null = null;
    let identityProject: string | null = null;
    if (inspection.binding?.schemaVersion === 2) {
      repositoryId = inspection.binding.repositoryId;
      identityProject =
        await this.dependencies.identities.findProjectId(repositoryId);
    } else if (inspection.binding?.schemaVersion === 1) {
      repositoryId = repositoryIdFromLegacyProjectId(
        inspection.binding.projectId,
      );
      identityProject = inspection.binding.projectId;
    }
    const pathProject =
      inspection.status === "valid"
        ? await this.dependencies.profiles.findProjectIdByLocalPath(
            inspection.rootPath,
          )
        : null;
    const installed =
      inspection.status === "valid" &&
      identityProject !== null &&
      identityProject === pathProject;
    if (
      inspection.status === "valid" &&
      identityProject !== null &&
      pathProject !== null &&
      identityProject !== pathProject
    )
      throw new ProjectLifecycleError(
        "Repository identity and runtime checkout association conflict; uninstall stopped",
      );

    const detections = await this.dependencies.clients.detect();
    const clientSteps: ClientUninstallStep[] = [];
    for (const clientId of installed
      ? (["claude", "codex"] as const)
      : ([] as const)) {
      if (!detections.some((item) => item.clientId === clientId)) continue;
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
      kind: "delete" | "update" | "detach";
      relativePath: string;
      owner: "ai-office";
    }> = clientSteps.flatMap((step) =>
      step.plan.changes.map((change) => ({
        kind: change.kind === "delete" ? "delete" : "update",
        relativePath: change.relativePath,
        owner: "ai-office",
      })),
    );
    const claudeStep = clientSteps.find((step) => step.clientId === "claude");
    const codexStep = clientSteps.find((step) => step.clientId === "codex");
    const userOwnedCodexHost =
      codexStep?.inspection.clientInstructions?.ownership === "user_owned";
    const removesClaudeDependency =
      claudeStep?.plan.changes.some(
        (change) => change.relativePath === "CLAUDE.md",
      ) === true;
    const managedCanonical =
      codexStep?.inspection.canonicalInstructions.ownership ===
      "ai_office_owned";
    if (
      removesClaudeDependency &&
      !userOwnedCodexHost &&
      managedCanonical &&
      !changes.some((change) => change.relativePath === "AI-OFFICE.md")
    )
      changes.push({
        kind: "delete",
        relativePath: "AI-OFFICE.md",
        owner: "ai-office",
      });
    const managedProjectSkill =
      codexStep?.inspection.skillInstructions?.ownership === "ai_office_owned";
    if (
      removesClaudeDependency &&
      !userOwnedCodexHost &&
      managedProjectSkill &&
      !changes.some(
        (change) => change.relativePath === ".agents/skills/ai-office/SKILL.md",
      )
    )
      changes.push({
        kind: "delete",
        relativePath: ".agents/skills/ai-office/SKILL.md",
        owner: "ai-office",
      });
    if (installed)
      changes.push({
        kind: "detach",
        relativePath: "runtime checkout association",
        owner: "ai-office",
      });
    changes.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    const ignoredDependencyIssue = (code: string) =>
      removesClaudeDependency &&
      !userOwnedCodexHost &&
      managedCanonical &&
      (code === "claude_canonical_dependency_preserved" ||
        code === "canonical_instructions_shared_preserved");
    const preserved = [
      ...(inspection.status === "valid"
        ? [`${projectBindingFile}: portable repository identity preserved`]
        : []),
      ...clientSteps.flatMap((step) =>
        step.plan.issues
          .filter(
            (issue) =>
              issue.severity === "warning" &&
              !ignoredDependencyIssue(issue.code),
          )
          .map((issue) => `${step.clientId}: ${issue.message}`),
      ),
    ];
    const warnings = clientSteps.flatMap((step) =>
      step.plan.issues
        .filter((issue) => !ignoredDependencyIssue(issue.code))
        .map((issue) => issue.message),
    );
    const publicBasis = {
      schemaVersion: 2 as const,
      action: "uninstall" as const,
      rootPath: inspection.rootPath,
      repositoryId,
      projectId: installed ? identityProject : null,
      installed,
      changes,
      preserved,
      warnings,
      repositoryIdentitySha256: inspection.sha256 ?? null,
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
        schemaVersion: 2,
        uninstalled: false,
        rootPath: current.rootPath,
        repositoryId: current.repositoryId,
        projectId: null,
        removedPaths: [],
        preserved: current.preserved,
        repositoryIdentityPreserved: true,
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

    const preflight = await this.planUninstall(current.rootPath);
    if (preflight.planHash !== current.planHash)
      throw new ProjectLifecycleError(
        "Project uninstall state changed during preflight; request a new plan",
      );

    const removedPaths: string[] = [];
    let associationRemoved = false;
    let activePlanPaths: string[] = [];
    try {
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
          current.changes.some((change) => change.kind === "delete")
        ) {
          const deferredSharedArtifacts = [
            {
              relativePath: ".agents/skills/ai-office/SKILL.md",
              sha256: approvedStep.inspection.skillInstructions?.sha256,
              summary: "Delete the repository-local AI Office skill",
            },
            {
              relativePath: "AI-OFFICE.md",
              sha256: approvedStep.inspection.canonicalInstructions.sha256,
              summary: "Delete AI Office-managed project guidance",
            },
          ];
          for (const artifact of deferredSharedArtifacts) {
            if (
              !current.changes.some(
                (change) =>
                  change.kind === "delete" &&
                  change.relativePath === artifact.relativePath,
              ) ||
              expectedChanges.some(
                (change) => change.relativePath === artifact.relativePath,
              )
            )
              continue;
            if (artifact.sha256 === undefined)
              throw new ProjectLifecycleError(
                `The approved uninstall plan has no ${artifact.relativePath} precondition`,
              );
            expectedChanges.push({
              kind: "delete",
              relativePath: artifact.relativePath,
              expectedSha256: artifact.sha256,
              ownershipAfter: "absent",
              summary: artifact.summary,
            });
          }
        }
        if (!clientChangesMatch(plan.changes, expectedChanges))
          throw new ProjectLifecycleError(
            "Client integration changed after lifecycle approval; request a new uninstall plan",
          );
        activePlanPaths = plan.changes.map((change) => change.relativePath);
        await this.dependencies.clients.uninstall({
          clientId,
          rootPath: current.rootPath,
          approvedPlanHash: plan.planHash,
        });
        removedPaths.push(...activePlanPaths);
        activePlanPaths = [];
      }

      const identity = await this.dependencies.bindings.inspect(
        current.rootPath,
      );
      if (
        identity.status !== "valid" ||
        identity.sha256 !== current.repositoryIdentitySha256
      )
        throw new ProjectLifecycleError(
          "Repository identity changed during uninstall; runtime association was preserved",
        );
      associationRemoved = await this.dependencies.profiles.removeSource(
        current.projectId!,
        current.rootPath,
      );
      if (!associationRemoved)
        throw new ProjectLifecycleError(
          "Runtime checkout association changed during uninstall",
        );
    } catch (error) {
      throw new ProjectUninstallPartialError({
        schemaVersion: 2,
        outcome: "partial",
        rootPath: current.rootPath,
        repositoryId: current.repositoryId,
        projectId: current.projectId,
        removedPaths: [...new Set(removedPaths)],
        possiblyModifiedPaths: [...new Set(activePlanPaths)],
        associationRemoved,
        repositoryIdentityPreserved: true,
        error: {
          message: errorMessage(error),
          recovery:
            "Inspect ai-office status and request a new uninstall plan. Already removed AI Office-owned artifacts are listed and user-owned content remains preserved.",
        },
      });
    }
    return {
      schemaVersion: 2,
      uninstalled: true,
      rootPath: current.rootPath,
      repositoryId: current.repositoryId,
      projectId: current.projectId,
      removedPaths: [...new Set(removedPaths)],
      preserved: current.preserved,
      repositoryIdentityPreserved: true,
      runtimeStatePreserved: true,
      globalMemoryPreserved: true,
    };
  }
}

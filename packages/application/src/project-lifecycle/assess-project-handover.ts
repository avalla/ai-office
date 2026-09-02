import {
  assessProjectHandover,
  type ProjectHandoverAssessment,
  type ProjectHandoverConnection,
  type ProjectHandoverKnowledge,
  type RepositorySignals,
} from "@ai-office/domain/project/project-handover.ts";
import type { ProjectProfileEntry } from "@ai-office/domain/project/project-profile.ts";
import type { GovernanceRepository } from "../ports/governance-repository.port.ts";
import type { OfficeManifestRepository } from "../ports/office-manifest-repository.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type {
  ManageProjectLifecycle,
  ProjectLifecycleStatus,
} from "./manage-project-lifecycle.ts";

/**
 * Machine-readable handover surface. It is versioned independently from
 * `ProjectLifecycleStatus` so that lifecycle status output stays stable.
 */
export interface ProjectHandoverReport {
  schemaVersion: 1;
  project: {
    id: string | null;
    name: string | null;
    root: string;
  };
  runtime: {
    daemon: ProjectLifecycleStatus["runtime"]["daemon"];
    authoritativeState: ProjectLifecycleStatus["runtime"]["authoritativeState"];
  };
  handover: ProjectHandoverAssessment;
}

interface AssessProjectHandoverDependencies {
  lifecycle: ManageProjectLifecycle;
  profiles: ProjectProfileRepository;
  manifests: OfficeManifestRepository;
  governance: GovernanceRepository;
  tasks: TaskRepository;
}

const workInProgressStatuses = new Set([
  "assigned",
  "running",
  "blocked",
  "waiting_review",
]);
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export function handoverConnectionFromStatus(
  status: ProjectLifecycleStatus,
): ProjectHandoverConnection {
  return {
    daemonReachable: status.runtime.daemon === "reachable",
    repositoryIdentity: status.project.repositoryIdentity.state,
    runtimeAssociation: status.project.runtimeAssociation.state,
    authoritativeStateAvailable:
      status.runtime.authoritativeState === "available",
    officeManifestPresent:
      status.office.state === "default_baseline" ||
      status.office.state === "configured",
    blockingIssueCount: status.issues.filter(
      (issue) => issue.severity === "error",
    ).length,
    clients: status.clients.map((client) => ({
      detected: client.detection === "detected",
      configured: client.configuration === "configured",
    })),
  };
}

/**
 * Builds a report for a status that cannot be enriched with authoritative
 * management knowledge, such as the offline status fallback.
 */
export function degradedProjectHandoverReport(
  status: ProjectLifecycleStatus,
): ProjectHandoverReport {
  return report(
    status,
    assessProjectHandover({
      connection: handoverConnectionFromStatus(status),
      knowledge: null,
    }),
  );
}

function report(
  status: ProjectLifecycleStatus,
  handover: ProjectHandoverAssessment,
): ProjectHandoverReport {
  return {
    schemaVersion: 1,
    project: {
      id: status.project.id,
      name: status.project.name,
      root: status.project.root,
    },
    runtime: {
      daemon: status.runtime.daemon,
      authoritativeState: status.runtime.authoritativeState,
    },
    handover,
  };
}

function detectedValue(
  entries: readonly ProjectProfileEntry[],
  category: string,
  key: string,
): unknown {
  return entries.find(
    (entry) =>
      entry.origin === "detected" &&
      entry.category === category &&
      entry.key === key,
  )?.value;
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function presentText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function repositorySignals(
  entries: readonly ProjectProfileEntry[],
): RepositorySignals {
  return {
    languageCount: listLength(detectedValue(entries, "stack", "languages")),
    frameworkCount: listLength(detectedValue(entries, "stack", "frameworks")),
    documentationCount: listLength(
      detectedValue(entries, "documentation", "files"),
    ),
    testingCount: listLength(detectedValue(entries, "quality", "testing")),
    hasPackageManager: presentText(
      detectedValue(entries, "tooling", "package_manager"),
    ),
    hasGitHistory: presentText(
      detectedValue(entries, "repository", "current_branch"),
    ),
  };
}

function userEntryCount(
  entries: readonly ProjectProfileEntry[],
  category: string,
): number {
  return entries.filter(
    (entry) => entry.origin === "user" && entry.category === category,
  ).length;
}

export class AssessProjectHandover {
  constructor(
    private readonly dependencies: AssessProjectHandoverDependencies,
  ) {}

  async execute(rootPath: string): Promise<ProjectHandoverReport> {
    return this.fromStatus(await this.dependencies.lifecycle.status(rootPath));
  }

  async fromStatus(
    status: ProjectLifecycleStatus,
  ): Promise<ProjectHandoverReport> {
    const connection = handoverConnectionFromStatus(status);
    const projectId = status.project.id;
    const knowledge =
      projectId === null || !connection.authoritativeStateAvailable
        ? null
        : await this.knowledge(projectId, status);
    return report(status, assessProjectHandover({ connection, knowledge }));
  }

  private async knowledge(
    projectId: string,
    status: ProjectLifecycleStatus,
  ): Promise<ProjectHandoverKnowledge> {
    const [entries, questions, office, governance, tasks] = await Promise.all([
      this.dependencies.profiles.listActiveProfileEntries(projectId),
      this.dependencies.profiles.listQuestions(projectId),
      this.dependencies.manifests.findLatest(projectId),
      this.dependencies.governance.getSnapshot(projectId),
      this.dependencies.tasks.listByProject(projectId),
    ]);
    const detected = entries.filter((entry) => entry.origin === "detected");
    const project = office?.manifest.project;
    const snapshots = tasks.map((task) => task.snapshot());
    return {
      repositoryScanned: detected.length > 0,
      repositorySignals: repositorySignals(entries),
      officeConfigured: status.office.state === "configured",
      mission: project?.mission ?? null,
      goalCount: project?.goals.length ?? 0,
      constraintCount: project?.constraints.length ?? 0,
      preferenceCount: project?.preferences.length ?? 0,
      roleCount: office?.manifest.office.roles.length ?? 0,
      userGoalCount: userEntryCount(entries, "goal"),
      userConstraintCount: userEntryCount(entries, "constraint"),
      openQuestionCount: questions.filter(
        (question) => question.answer === undefined,
      ).length,
      milestoneTotal: governance.milestones.length,
      activeMilestones: governance.milestones.filter(
        (milestone) => milestone.status === "active",
      ).length,
      requirementTotal: governance.requirements.length,
      taskTotal: snapshots.length,
      tasksOpen: snapshots.filter((task) => !terminalStatuses.has(task.status))
        .length,
      tasksInProgress: snapshots.filter((task) =>
        workInProgressStatuses.has(task.status),
      ).length,
    };
  }
}

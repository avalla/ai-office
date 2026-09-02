import {
  assessProjectHandover,
  type OpenHandoverQuestions,
  type ProjectHandoverAssessment,
  type ProjectHandoverConnection,
  type ProjectHandoverKnowledge,
  type RepositoryReviewState,
} from "@ai-office/domain/project/project-handover.ts";
import type { ProjectQuestion } from "@ai-office/domain/project/project-profile.ts";
import type { GovernanceRepository } from "../ports/governance-repository.port.ts";
import type { OfficeManifestRepository } from "../ports/office-manifest-repository.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import {
  readRecordedRepositoryReview,
  repositoryFactsFromProfile,
  repositorySignalsFromFacts,
  repositoryUnderstandingFingerprint,
} from "./repository-understanding.ts";
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

/**
 * Goal and constraint answers define product direction and the working
 * agreement, so an unanswered one is missing handover context. Preference and
 * permission answers refine an existing agreement and stay advisory.
 */
const blockingAnswerCategories = new Set(["goal", "constraint"]);

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

function openQuestionCounts(
  questions: readonly ProjectQuestion[],
): OpenHandoverQuestions {
  const blocking = questions.filter((question) =>
    blockingAnswerCategories.has(question.answerCategory),
  ).length;
  return { blocking, advisory: questions.length - blocking };
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
      this.dependencies.profiles.listOpenQuestions(projectId),
      this.dependencies.manifests.findLatest(projectId),
      this.dependencies.governance.getSnapshot(projectId),
      this.dependencies.tasks.listByProject(projectId),
    ]);
    const facts = repositoryFactsFromProfile(entries);
    const recorded = readRecordedRepositoryReview(entries);
    // An approved office manifest records the organizational model; it never
    // certifies that this repository was reviewed. Only an explicit, confirmed
    // review does, and only for the repository evidence it was confirmed
    // against.
    const repositoryReview: RepositoryReviewState =
      facts === null || recorded === null
        ? "not_reviewed"
        : recorded.review.fingerprint ===
            repositoryUnderstandingFingerprint(facts)
          ? "current"
          : "stale";
    const project = office?.manifest.project;
    const snapshots = tasks.map((task) => task.snapshot());
    return {
      repositoryScanned: facts !== null,
      repositorySignals:
        facts === null
          ? {
              languageCount: 0,
              frameworkCount: 0,
              documentationCount: 0,
              sourceFileCount: null,
              hasCommitHistory: null,
            }
          : repositorySignalsFromFacts(facts),
      repositoryReview,
      officeConfigured: status.office.state === "configured",
      goalCount: project?.goals.length ?? 0,
      constraintCount: project?.constraints.length ?? 0,
      preferenceCount: project?.preferences.length ?? 0,
      milestoneTotal: governance.milestones.length,
      activeMilestones: governance.milestones.filter(
        (milestone) => milestone.status === "active",
      ).length,
      requirementTotal: governance.requirements.length,
      tasksOpen: snapshots.filter((task) => !terminalStatuses.has(task.status))
        .length,
      tasksInProgress: snapshots.filter((task) =>
        workInProgressStatuses.has(task.status),
      ).length,
      openQuestions: openQuestionCounts(questions),
    };
  }
}

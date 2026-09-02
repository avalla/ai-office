import { describe, expect, test } from "vitest";
import {
  assessProjectHandover,
  classifyRepositoryMaturity,
  maximumRecommendedActions,
  type ProjectHandoverConnection,
  type ProjectHandoverKnowledge,
  type RepositorySignals,
} from "@ai-office/domain/project/project-handover.ts";

function signals(
  overrides: Partial<RepositorySignals> = {},
): RepositorySignals {
  return {
    languageCount: 1,
    frameworkCount: 1,
    documentationCount: 2,
    testingCount: 1,
    hasPackageManager: true,
    hasGitHistory: true,
    ...overrides,
  };
}

function connection(
  overrides: Partial<ProjectHandoverConnection> = {},
): ProjectHandoverConnection {
  return {
    daemonReachable: true,
    repositoryIdentity: "valid",
    runtimeAssociation: "valid",
    authoritativeStateAvailable: true,
    officeManifestPresent: true,
    blockingIssueCount: 0,
    clients: [{ detected: true, configured: true }],
    ...overrides,
  };
}

function knowledge(
  overrides: Partial<ProjectHandoverKnowledge> = {},
): ProjectHandoverKnowledge {
  return {
    repositoryScanned: true,
    repositorySignals: signals(),
    officeConfigured: true,
    mission: "Ship the product",
    goalCount: 2,
    constraintCount: 1,
    preferenceCount: 1,
    roleCount: 4,
    userGoalCount: 0,
    userConstraintCount: 0,
    openQuestionCount: 0,
    milestoneTotal: 1,
    activeMilestones: 1,
    requirementTotal: 2,
    taskTotal: 0,
    tasksOpen: 0,
    tasksInProgress: 0,
    ...overrides,
  };
}

function dimensionState(
  assessment: ReturnType<typeof assessProjectHandover>,
  id: string,
): string {
  return assessment.dimensions.find((entry) => entry.id === id)!.state;
}

function actionIds(
  assessment: ReturnType<typeof assessProjectHandover>,
): string[] {
  return assessment.recommendedActions.map((action) => action.id);
}

describe("repository maturity classification", () => {
  test("treats a repository with at least two structural signals as existing", () => {
    expect(classifyRepositoryMaturity(signals())).toBe("existing");
    expect(
      classifyRepositoryMaturity(
        signals({
          frameworkCount: 0,
          testingCount: 0,
          documentationCount: 1,
        }),
      ),
    ).toBe("existing");
  });

  test("treats a scaffold with a single signal as new", () => {
    expect(
      classifyRepositoryMaturity(
        signals({
          languageCount: 0,
          frameworkCount: 0,
          testingCount: 0,
          documentationCount: 1,
          hasPackageManager: false,
        }),
      ),
    ).toBe("new");
    expect(
      classifyRepositoryMaturity(
        signals({
          frameworkCount: 0,
          testingCount: 0,
          documentationCount: 0,
          hasPackageManager: false,
        }),
      ),
    ).toBe("new");
  });
});

describe("project handover assessment", () => {
  test("reports a repository without an identity as not connected", () => {
    const assessment = assessProjectHandover({
      connection: connection({
        repositoryIdentity: "missing",
        runtimeAssociation: "missing",
        authoritativeStateAvailable: false,
        officeManifestPresent: false,
      }),
      knowledge: null,
    });

    expect(assessment.state).toBe("not_connected");
    expect(assessment.repository).toBe("unknown");
    expect(actionIds(assessment)).toEqual(["install_project"]);
    expect(assessment.recommendedActions[0]?.command).toBe(
      "ai-office install .",
    );
  });

  test("asks for an explicit repair when the identity file is invalid", () => {
    const assessment = assessProjectHandover({
      connection: connection({
        repositoryIdentity: "invalid",
        runtimeAssociation: "missing",
        authoritativeStateAvailable: false,
        officeManifestPresent: false,
      }),
      knowledge: null,
    });

    expect(actionIds(assessment)).toEqual(["repair_project_connection"]);
  });

  test("never claims or denies handover state while the runtime is unreachable", () => {
    const assessment = assessProjectHandover({
      connection: connection({
        daemonReachable: false,
        runtimeAssociation: "unverified",
        authoritativeStateAvailable: false,
        officeManifestPresent: false,
        clients: [],
      }),
      knowledge: null,
    });

    expect(assessment.state).toBe("unknown");
    expect(
      assessment.dimensions.every((entry) => entry.state === "unknown"),
    ).toBe(true);
    expect(actionIds(assessment)).toEqual(["start_runtime"]);
  });

  test("reports a connected but unscanned repository as not imported", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({
        repositoryScanned: false,
        officeConfigured: false,
        goalCount: 0,
        constraintCount: 0,
        preferenceCount: 0,
        milestoneTotal: 0,
        activeMilestones: 0,
        requirementTotal: 0,
      }),
    });

    expect(assessment.state).toBe("not_imported");
    expect(dimensionState(assessment, "repository_understanding")).toBe(
      "not_started",
    );
    expect(actionIds(assessment)).toContain("import_repository");
  });

  test("reports a scanned baseline project as needing handover", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({
        officeConfigured: false,
        milestoneTotal: 0,
        activeMilestones: 0,
        requirementTotal: 0,
      }),
    });

    expect(assessment.state).toBe("needs_handover");
    expect(assessment.repository).toBe("existing");
    expect(dimensionState(assessment, "repository_understanding")).toBe(
      "discovered",
    );
    expect(dimensionState(assessment, "product_direction")).toBe("needs_input");
    const handover = assessment.recommendedActions[0];
    expect(handover?.id).toBe("complete_project_handover");
    expect(handover?.kind).toBe("conversational");
    expect(handover?.prompt).toContain("Take this project in charge");
    expect(assessment.suggestedPrompts).not.toContain(handover?.prompt);
  });

  test("distinguishes a new repository in the handover reason", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({
        officeConfigured: false,
        repositorySignals: signals({
          languageCount: 0,
          frameworkCount: 0,
          testingCount: 0,
          documentationCount: 1,
          hasPackageManager: false,
        }),
        milestoneTotal: 0,
        activeMilestones: 0,
      }),
    });

    expect(assessment.repository).toBe("new");
    expect(assessment.recommendedActions[0]?.reason).not.toContain(
      "existing codebase",
    );
  });

  test("reports partial handover and asks only for the missing context", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ milestoneTotal: 0, activeMilestones: 0 }),
    });

    expect(assessment.state).toBe("in_progress");
    expect(dimensionState(assessment, "product_direction")).toBe("ready");
    expect(dimensionState(assessment, "delivery_plan")).toBe("needs_input");
    expect(actionIds(assessment)).toEqual(["plan_next_milestone"]);
  });

  test("reports a fully handed-over project as ready", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge(),
    });

    expect(assessment.state).toBe("ready");
    expect(
      assessment.dimensions.every((entry) => entry.state === "ready"),
    ).toBe(true);
    expect(actionIds(assessment)).toEqual(["start_next_work"]);
  });

  test("surfaces existing work before proposing new work", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ taskTotal: 4, tasksOpen: 3, tasksInProgress: 2 }),
    });

    expect(assessment.state).toBe("ready");
    expect(actionIds(assessment)[0]).toBe("review_active_work");
    expect(assessment.recommendedActions[0]?.title).toBe(
      "Review 2 task(s) in progress",
    );
  });

  test("reports untouched open work without claiming it is in progress", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ taskTotal: 1, tasksOpen: 1 }),
    });

    expect(assessment.recommendedActions[0]?.title).toBe(
      "Review 1 open task(s)",
    );
  });

  test("prioritizes blocking lifecycle issues and caps the action list", () => {
    const assessment = assessProjectHandover({
      connection: connection({
        blockingIssueCount: 2,
        clients: [{ detected: true, configured: false }],
      }),
      knowledge: knowledge({
        officeConfigured: false,
        taskTotal: 1,
        tasksOpen: 1,
        tasksInProgress: 1,
        milestoneTotal: 0,
        activeMilestones: 0,
      }),
    });

    expect(assessment.recommendedActions.length).toBeLessThanOrEqual(
      maximumRecommendedActions,
    );
    expect(actionIds(assessment).slice(0, 2)).toEqual([
      "resolve_lifecycle_issues",
      "complete_project_handover",
    ]);
  });

  test("is deterministic for identical input", () => {
    const input = {
      connection: connection(),
      knowledge: knowledge({ officeConfigured: false }),
    };

    expect(JSON.stringify(assessProjectHandover(input))).toBe(
      JSON.stringify(assessProjectHandover(input)),
    );
  });

  test("reports uninspected agent clients as unknown rather than absent", () => {
    const assessment = assessProjectHandover({
      connection: connection({ clients: [] }),
      knowledge: knowledge(),
    });

    expect(dimensionState(assessment, "agent_clients")).toBe("unknown");
    expect(assessment.state).toBe("in_progress");
  });

  test("recommends client reconciliation when a detected client is unconfigured", () => {
    const assessment = assessProjectHandover({
      connection: connection({
        clients: [{ detected: true, configured: false }],
      }),
      knowledge: knowledge(),
    });

    expect(dimensionState(assessment, "agent_clients")).toBe("needs_input");
    expect(actionIds(assessment)).toContain("reconcile_agent_clients");
  });
});

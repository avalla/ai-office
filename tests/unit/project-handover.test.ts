import { describe, expect, test } from "vitest";
import {
  assessProjectHandover,
  classifyRepositoryMaturity,
  maximumRecommendedActions,
  repositoryScaleBucket,
  repositoryUnderstandingFingerprintSource,
  type ProjectHandoverConnection,
  type ProjectHandoverKnowledge,
  type RepositorySignals,
  type RepositoryUnderstandingFacts,
} from "@ai-office/domain/project/project-handover.ts";

function signals(
  overrides: Partial<RepositorySignals> = {},
): RepositorySignals {
  return {
    languageCount: 1,
    frameworkCount: 1,
    documentationCount: 2,
    sourceFileCount: 120,
    hasCommitHistory: true,
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

/** A fully handed-over project: every dimension satisfied. */
function knowledge(
  overrides: Partial<ProjectHandoverKnowledge> = {},
): ProjectHandoverKnowledge {
  return {
    repositoryScanned: true,
    repositorySignals: signals(),
    repositoryReview: "current",
    officeConfigured: true,
    goalCount: 2,
    constraintCount: 1,
    preferenceCount: 1,
    milestoneTotal: 1,
    activeMilestones: 1,
    requirementTotal: 2,
    tasksOpen: 0,
    tasksInProgress: 0,
    openQuestions: { blocking: 0, advisory: 0 },
    ...overrides,
  };
}

function facts(
  overrides: Partial<RepositoryUnderstandingFacts> = {},
): RepositoryUnderstandingFacts {
  return {
    languages: ["TypeScript"],
    frameworks: ["Vite"],
    databases: [],
    testing: ["Vitest"],
    documentation: ["README.md"],
    packageManager: "bun",
    remoteUrl: "git@github.com:example/demo.git",
    sourceFileCount: 40,
    hasCommitHistory: true,
    ...overrides,
  };
}

function dimensionState(
  assessment: ReturnType<typeof assessProjectHandover>,
  id: string,
): string {
  return assessment.dimensions.find((entry) => entry.id === id)!.state;
}

function dimensionDetail(
  assessment: ReturnType<typeof assessProjectHandover>,
  id: string,
): string {
  return assessment.dimensions.find((entry) => entry.id === id)!.detail;
}

function actionIds(
  assessment: ReturnType<typeof assessProjectHandover>,
): string[] {
  return assessment.recommendedActions.map((action) => action.id);
}

describe("repository maturity classification", () => {
  test("classifies an empty or README-only repository as new", () => {
    expect(
      classifyRepositoryMaturity(
        signals({
          languageCount: 0,
          frameworkCount: 0,
          documentationCount: 0,
          sourceFileCount: 0,
          hasCommitHistory: false,
        }),
      ),
    ).toBe("new");
    expect(
      classifyRepositoryMaturity(
        signals({
          languageCount: 0,
          frameworkCount: 0,
          documentationCount: 1,
          sourceFileCount: 0,
          hasCommitHistory: true,
        }),
      ),
    ).toBe("new");
  });

  test("classifies a fresh scaffold with full tooling as new", () => {
    // A new Vite + React project already declares a language, a framework, a
    // package manager, and a test runner, but almost no application code.
    expect(
      classifyRepositoryMaturity(
        signals({
          languageCount: 1,
          frameworkCount: 2,
          documentationCount: 1,
          sourceFileCount: 6,
          hasCommitHistory: true,
        }),
      ),
    ).toBe("new");
  });

  test("classifies a mature single-language project with no tooling as existing", () => {
    // A long-lived Python repository: one language, no detected framework,
    // no detected package manager or test runner, one README.
    expect(
      classifyRepositoryMaturity(
        signals({
          languageCount: 1,
          frameworkCount: 0,
          documentationCount: 1,
          sourceFileCount: 180,
          hasCommitHistory: true,
        }),
      ),
    ).toBe("existing");
  });

  test("classifies an established monorepo as existing", () => {
    expect(
      classifyRepositoryMaturity(
        signals({ sourceFileCount: 420, documentationCount: 6 }),
      ),
    ).toBe("existing");
  });

  test("classifies a modest repository with real history and documentation as existing", () => {
    expect(
      classifyRepositoryMaturity(
        signals({
          languageCount: 1,
          frameworkCount: 0,
          documentationCount: 2,
          sourceFileCount: 12,
          hasCommitHistory: true,
        }),
      ),
    ).toBe("existing");
  });

  test("does not treat a branch pointer without commits as history", () => {
    expect(
      classifyRepositoryMaturity(
        signals({
          documentationCount: 2,
          sourceFileCount: 12,
          hasCommitHistory: false,
        }),
      ),
    ).toBe("new");
  });

  test("reports unknown maturity when the scan recorded no file evidence", () => {
    expect(
      classifyRepositoryMaturity(
        signals({ sourceFileCount: null, hasCommitHistory: null }),
      ),
    ).toBe("unknown");
  });
});

describe("repository understanding fingerprint", () => {
  test("is stable across ordinary edits and file ordering", () => {
    expect(repositoryUnderstandingFingerprintSource(facts())).toBe(
      repositoryUnderstandingFingerprintSource(
        facts({ sourceFileCount: 44, languages: ["TypeScript"] }),
      ),
    );
  });

  test("changes when the repository changes materially", () => {
    const base = repositoryUnderstandingFingerprintSource(facts());
    expect(
      repositoryUnderstandingFingerprintSource(
        facts({ languages: ["TypeScript", "Python"] }),
      ),
    ).not.toBe(base);
    expect(
      repositoryUnderstandingFingerprintSource(facts({ sourceFileCount: 400 })),
    ).not.toBe(base);
    expect(
      repositoryUnderstandingFingerprintSource(
        facts({ documentation: ["README.md", "ARCHITECTURE.md"] }),
      ),
    ).not.toBe(base);
  });

  test("buckets repository scale deterministically", () => {
    expect(repositoryScaleBucket(null)).toBe("unrecorded");
    expect(repositoryScaleBucket(0)).toBe("none");
    expect(repositoryScaleBucket(9)).toBe("tiny");
    expect(repositoryScaleBucket(24)).toBe("small");
    expect(repositoryScaleBucket(99)).toBe("medium");
    expect(repositoryScaleBucket(499)).toBe("large");
    expect(repositoryScaleBucket(500)).toBe("very_large");
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
        repositoryReview: "not_reviewed",
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
    expect(actionIds(assessment)).toContain("import_repository");
  });

  test("a scan alone never makes repository understanding ready", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({
        repositoryReview: "not_reviewed",
        officeConfigured: false,
        milestoneTotal: 0,
        activeMilestones: 0,
        requirementTotal: 0,
      }),
    });

    expect(dimensionState(assessment, "repository_understanding")).toBe(
      "discovered",
    );
    expect(assessment.state).toBe("needs_handover");
    expect(actionIds(assessment)[0]).toBe("complete_project_handover");
  });

  test("an approved office manifest does not confirm repository understanding", () => {
    // This is the upgrade shape for a project configured before the handover
    // feature existed: office, milestone, and clients are already in place but
    // no repository review was ever confirmed.
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ repositoryReview: "not_reviewed" }),
    });

    expect(dimensionState(assessment, "repository_understanding")).toBe(
      "discovered",
    );
    expect(dimensionDetail(assessment, "repository_understanding")).toContain(
      "no confirmed handover repository review",
    );
    expect(assessment.state).toBe("in_progress");
    expect(actionIds(assessment)[0]).toBe("confirm_repository_review");
  });

  test("a confirmed review makes repository understanding ready", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge(),
    });

    expect(dimensionState(assessment, "repository_understanding")).toBe(
      "ready",
    );
    expect(assessment.state).toBe("ready");
    expect(actionIds(assessment)).toEqual(["start_next_work"]);
  });

  test("a materially changed repository makes the confirmation stale", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ repositoryReview: "stale" }),
    });

    expect(dimensionState(assessment, "repository_understanding")).toBe(
      "needs_input",
    );
    expect(assessment.state).toBe("in_progress");
    expect(actionIds(assessment)[0]).toBe("review_repository_changes");
  });

  test("distinguishes a new repository in the handover reason", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({
        repositoryReview: "not_reviewed",
        officeConfigured: false,
        repositorySignals: signals({
          sourceFileCount: 4,
          documentationCount: 1,
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
    expect(dimensionState(assessment, "delivery_plan")).toBe("needs_input");
    expect(actionIds(assessment)).toEqual(["plan_next_milestone"]);
  });

  test("surfaces existing work before proposing new work", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ tasksOpen: 3, tasksInProgress: 2 }),
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
      knowledge: knowledge({ tasksOpen: 1 }),
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
        repositoryReview: "not_reviewed",
        officeConfigured: false,
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
      knowledge: knowledge({ repositoryReview: "not_reviewed" as const }),
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

describe("open handover questions", () => {
  test("a blocking open question prevents readiness", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ openQuestions: { blocking: 2, advisory: 1 } }),
    });

    expect(assessment.state).toBe("in_progress");
    expect(assessment.openQuestions).toEqual({ blocking: 2, advisory: 1 });
    const action = assessment.recommendedActions.find(
      (candidate) => candidate.id === "answer_open_questions",
    );
    expect(action?.title).toBe("Complete 2 remaining project question(s)");
    expect(action?.priority).toBe("high");
  });

  test("advisory questions alone do not block readiness", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ openQuestions: { blocking: 0, advisory: 3 } }),
    });

    expect(assessment.state).toBe("ready");
    expect(actionIds(assessment)).not.toContain("answer_open_questions");
  });

  test("answering the blocking questions restores readiness", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ openQuestions: { blocking: 0, advisory: 0 } }),
    });

    expect(assessment.state).toBe("ready");
  });
});

describe("working agreement source of truth", () => {
  test("derives readiness and detail from the approved office only", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ constraintCount: 0, preferenceCount: 0 }),
    });

    expect(dimensionState(assessment, "working_agreement")).toBe("needs_input");
    expect(dimensionDetail(assessment, "working_agreement")).toBe(
      "The approved office records 0 constraint(s) and 0 preference(s)",
    );
    expect(assessment.state).toBe("in_progress");
    expect(actionIds(assessment)).toContain("record_working_agreement");
  });

  test("reports the baseline office as not started rather than agreed", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({
        officeConfigured: false,
        repositoryReview: "not_reviewed",
      }),
    });

    expect(dimensionState(assessment, "working_agreement")).toBe("not_started");
  });

  test("reports an approved agreement as ready with matching detail", () => {
    const assessment = assessProjectHandover({
      connection: connection(),
      knowledge: knowledge({ constraintCount: 3, preferenceCount: 2 }),
    });

    expect(dimensionState(assessment, "working_agreement")).toBe("ready");
    expect(dimensionDetail(assessment, "working_agreement")).toBe(
      "The approved office records 3 constraint(s) and 2 preference(s)",
    );
  });
});

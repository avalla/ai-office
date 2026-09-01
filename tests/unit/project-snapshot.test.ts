import { describe, expect, test } from "vitest";
import {
  createPortableProjectArchive,
  parsePortableProjectArchive,
  portableStateChecksum,
  serializePortableProjectArchive,
  type PortableProjectManifest,
  type PortableProjectState,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import { portableGitRemote } from "@ai-office/application/project-portability/project-git-provenance.ts";

const timestamp = "2026-09-01T08:00:00.000Z";

function state(value: unknown = ["TypeScript"]): PortableProjectState {
  return {
    project: { name: "Portable", createdAt: timestamp, updatedAt: timestamp },
    tasks: [
      {
        id: "task-1",
        title: "Move machines",
        status: "pending",
        priority: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    profileEntries: [
      {
        id: "profile-1",
        category: "stack",
        key: "languages",
        value,
        origin: "detected",
        confidence: 1,
        confirmedAt: timestamp,
        createdAt: timestamp,
      },
    ],
    officeManifests: [],
    governance: {
      milestones: [],
      requirements: [],
      adrs: [],
      reviews: [],
      approvals: [],
    },
    agents: { roles: [], definitions: [], terminalRuns: [] },
  };
}

function manifest(value: PortableProjectState): PortableProjectManifest {
  return {
    format: "ai-office-project",
    formatVersion: 1,
    projectIdentity: "repo_portable",
    createdAt: timestamp,
    revision: {
      id: "rev-1",
      stateChecksum: portableStateChecksum(value),
    },
    contents: [
      "project",
      "tasks",
      "profile",
      "office_manifests",
      "governance",
      "agent_definitions",
      "terminal_run_summaries",
    ],
  };
}

describe("portable project snapshot", () => {
  test("round-trips a strict versioned envelope with canonical integrity", () => {
    const value = state();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    const serialized = serializePortableProjectArchive(archive);
    expect(parsePortableProjectArchive(serialized)).toEqual(archive);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  test("rejects state and envelope checksum corruption", () => {
    const value = state();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    expect(() =>
      parsePortableProjectArchive(
        JSON.stringify({
          ...archive,
          state: {
            ...archive.state,
            project: { ...archive.state.project, name: "Tampered" },
          },
        }),
      ),
    ).toThrow("state checksum mismatch");
    expect(() =>
      parsePortableProjectArchive(
        JSON.stringify({
          ...archive,
          integrity: { ...archive.integrity, checksum: "0".repeat(64) },
        }),
      ),
    ).toThrow("integrity checksum mismatch");
  });

  test("rejects unsupported formats, embedded paths, and sensitive fields", () => {
    const value = state();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    expect(() =>
      parsePortableProjectArchive(
        JSON.stringify({
          ...archive,
          manifest: { ...archive.manifest, formatVersion: 2 },
        }),
      ),
    ).toThrow("formatVersion");
    expect(() =>
      parsePortableProjectArchive(
        JSON.stringify({ ...archive, artifacts: [{ path: "../../escape" }] }),
      ),
    ).toThrow("Unrecognized key");
    const sensitive = state({ token: "must-not-export" });
    expect(() =>
      createPortableProjectArchive({
        state: sensitive,
        manifest: manifest(sensitive),
      }),
    ).toThrow("sensitive field token");
  });

  test("requires the portable subset to be referentially closed", () => {
    const dangling = state();
    dangling.governance.requirements.push({
      id: "requirement-1",
      milestoneId: "missing-milestone",
      key: "REQ-1",
      title: "Closed state",
      description: "Every reference must resolve within the archive.",
      status: "proposed",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(() =>
      createPortableProjectArchive({
        state: dangling,
        manifest: manifest(dangling),
      }),
    ).toThrow("Referenced milestone missing-milestone is not portable");

    const decidedWithoutApproval = state();
    decidedWithoutApproval.governance.reviews.push({
      id: "review-1",
      subjectType: "task",
      subjectId: "task-1",
      reviewer: { type: "user", id: "reviewer" },
      status: "approved",
      createdAt: timestamp,
      completedAt: timestamp,
    });
    expect(() =>
      createPortableProjectArchive({
        state: decidedWithoutApproval,
        manifest: manifest(decidedWithoutApproval),
      }),
    ).toThrow("Decided review review-1 requires a portable approval");

    const danglingApproval = state();
    danglingApproval.governance.approvals.push({
      id: "approval-1",
      reviewId: "missing-review",
      decision: "approved",
      actor: { type: "user", id: "owner" },
      createdAt: timestamp,
    });
    expect(() =>
      createPortableProjectArchive({
        state: danglingApproval,
        manifest: manifest(danglingApproval),
      }),
    ).toThrow("Referenced review missing-review is not portable");

    const danglingAdr = state();
    danglingAdr.governance.adrs.push({
      id: "adr-1",
      title: "ADR",
      context: "Context",
      decision: "Decision",
      consequences: "Consequences",
      status: "superseded",
      supersededById: "missing-adr",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(() =>
      createPortableProjectArchive({
        state: danglingAdr,
        manifest: manifest(danglingAdr),
      }),
    ).toThrow("Referenced ADR missing-adr is not portable");

    const danglingAgent = state();
    danglingAgent.agents.definitions.push({
      id: "agent-1",
      roleId: "missing-role",
      name: "Agent",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(() =>
      createPortableProjectArchive({
        state: danglingAgent,
        manifest: manifest(danglingAgent),
      }),
    ).toThrow("Referenced role missing-role is not portable");

    const danglingReview = state();
    danglingReview.governance.reviews.push({
      id: "review-2",
      subjectType: "agent_run",
      subjectId: "missing-run",
      reviewer: { type: "user", id: "reviewer" },
      status: "pending",
      createdAt: timestamp,
    });
    expect(() =>
      createPortableProjectArchive({
        state: danglingReview,
        manifest: manifest(danglingReview),
      }),
    ).toThrow("Referenced agent_run missing-run is not portable");

    const danglingRun = state();
    danglingRun.agents.terminalRuns.push({
      id: "run-1",
      taskId: "missing-task",
      agentId: "missing-agent",
      status: "failed",
      createdAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    });
    expect(() =>
      createPortableProjectArchive({
        state: danglingRun,
        manifest: manifest(danglingRun),
      }),
    ).toThrow("Referenced task missing-task is not portable");
  });
});

describe("portable Git provenance", () => {
  test.each([
    [
      "https://alice:secret@example.test/team/repo.git?token=hidden#fragment",
      "https://example.test/team/repo.git",
    ],
    [
      "ssh://git@example.test/team/repo.git",
      "ssh://example.test/team/repo.git",
    ],
    ["git@example.test:team/repo.git", "ssh://example.test/team/repo.git"],
    ["git://example.test/team/repo.git", "git://example.test/team/repo.git"],
  ])("keeps only sanitized network provenance for %s", (remote, expected) => {
    expect(portableGitRemote(remote)).toBe(expected);
  });

  test.each([
    "file:///Users/alice/dev/upstream.git",
    "/Users/alice/dev/upstream.git",
    "../upstream.git",
    "./upstream.git",
    String.raw`C:\Users\Alice\repo.git`,
    String.raw`\\server\share\repo.git`,
    "ambiguous/repo.git",
  ])("omits machine-local or ambiguous remote %s", (remote) => {
    expect(portableGitRemote(remote)).toBeUndefined();
  });

  test("rejects non-portable provenance embedded in an archive manifest", () => {
    const value = state();
    expect(() =>
      createPortableProjectArchive({
        state: value,
        manifest: {
          ...manifest(value),
          source: {
            type: "git",
            remote: "file:///Users/alice/private/repository.git",
          },
        },
      }),
    ).toThrow("must be normalized network-safe Git provenance");
  });
});

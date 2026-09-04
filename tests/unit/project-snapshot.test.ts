import { describe, expect, test } from "vitest";
import {
  createPortableProjectArchive,
  parsePortableProjectArchive,
  portableProjectFormatVersionFor,
  portableProjectManifestFor,
  portableStateChecksum,
  serializePortableProjectArchive,
  sha256Canonical,
  type PortableProjectFormatVersion,
  type PortableProjectManifest,
  type PortableProjectState,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import {
  portableGitRemote,
  selectPortableGitProvenance,
} from "@ai-office/application/project-portability/project-git-provenance.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";

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

/**
 * The manifest a writer would produce for this state: version 1 while it has no
 * Task/Requirement links, version 2 once it does. A test that wants the wrong
 * pairing asks for it explicitly.
 */
function manifest(
  value: PortableProjectState,
  formatVersion: PortableProjectFormatVersion = portableProjectFormatVersionFor(
    value,
  ),
): PortableProjectManifest {
  return portableProjectManifestFor({
    formatVersion,
    projectIdentity: "repo_portable",
    createdAt: timestamp,
    revision: {
      id: "rev-1",
      stateChecksum: portableStateChecksum(value),
    },
  });
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

  test.each([
    "OPENAI_API_KEY",
    "apikey",
    "github_token",
    "access_token",
    "database_password",
    "client_secret",
    "credential_ref",
    "authorization",
  ])(
    "rejects a profile entry labelled as structured credential data by key %s",
    (key) => {
      const value = state("sk-test");
      value.profileEntries[0]!.key = key;
      expect(() =>
        createPortableProjectArchive({
          state: value,
          manifest: manifest(value),
        }),
      ).toThrow(`profile entry profile-1 is labelled as sensitive credential data (${key})`);
    },
  );

  test("rejects sensitive profile categories and nested sensitive fields without guessing prose", () => {
    const categorized = state("machine credential");
    categorized.profileEntries[0]!.category = "credential";
    expect(() =>
      createPortableProjectArchive({
        state: categorized,
        manifest: manifest(categorized),
      }),
    ).toThrow("sensitive credential data (credential)");

    const nested = state({ token: "secret" });
    expect(() =>
      createPortableProjectArchive({
        state: nested,
        manifest: manifest(nested),
      }),
    ).toThrow("sensitive field token");

    const ordinary = state("Prefer short-lived API sessions in documentation");
    ordinary.profileEntries[0]!.category = "preference";
    ordinary.profileEntries[0]!.key = "authentication_documentation";
    expect(() =>
      createPortableProjectArchive({
        state: ordinary,
        manifest: manifest(ordinary),
      }),
    ).not.toThrow();
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
          manifest: { ...archive.manifest, formatVersion: 3 },
        }),
      ),
    ).toThrow("does not declare a supported format version");
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
    expect(() =>
      createPortableProjectArchive({
        state: value,
        manifest: { ...manifest(value), createdAt: "2026-09-01" },
      }),
    ).toThrow("canonical UTC ISO-8601 timestamp");
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

  test("requires governance decisions to have exactly one matching approval", () => {
    const pendingWithApproval = state();
    pendingWithApproval.governance.reviews.push({
      id: "review-pending",
      subjectType: "task",
      subjectId: "task-1",
      reviewer: { type: "user", id: "reviewer" },
      status: "pending",
      createdAt: timestamp,
    });
    pendingWithApproval.governance.approvals.push({
      id: "approval-pending",
      reviewId: "review-pending",
      decision: "approved",
      actor: { type: "user", id: "owner" },
      createdAt: timestamp,
    });
    expect(() =>
      createPortableProjectArchive({
        state: pendingWithApproval,
        manifest: manifest(pendingWithApproval),
      }),
    ).toThrow("Pending review review-pending cannot have an approval");

    const multipleApprovals = state();
    multipleApprovals.governance.reviews.push({
      id: "review-decided",
      subjectType: "task",
      subjectId: "task-1",
      reviewer: { type: "user", id: "reviewer" },
      status: "approved",
      createdAt: timestamp,
      completedAt: timestamp,
    });
    multipleApprovals.governance.approvals.push(
      {
        id: "approval-one",
        reviewId: "review-decided",
        decision: "approved",
        actor: { type: "user", id: "owner" },
        createdAt: timestamp,
      },
      {
        id: "approval-two",
        reviewId: "review-decided",
        decision: "approved",
        actor: { type: "user", id: "owner" },
        createdAt: timestamp,
      },
    );
    expect(() =>
      createPortableProjectArchive({
        state: multipleApprovals,
        manifest: manifest(multipleApprovals),
      }),
    ).toThrow("Review review-decided has more than one approval");

    const matchingDecision = state();
    matchingDecision.governance.reviews.push({
      id: "review-valid",
      subjectType: "task",
      subjectId: "task-1",
      reviewer: { type: "user", id: "reviewer" },
      status: "rejected",
      createdAt: timestamp,
      completedAt: timestamp,
    });
    matchingDecision.governance.approvals.push({
      id: "approval-valid",
      reviewId: "review-valid",
      decision: "rejected",
      actor: { type: "user", id: "owner" },
      createdAt: timestamp,
    });
    expect(() =>
      createPortableProjectArchive({
        state: matchingDecision,
        manifest: manifest(matchingDecision),
      }),
    ).not.toThrow();
  });
});

describe("portable task/requirement linkage", () => {
  function linked(): PortableProjectState {
    const value = state();
    return {
      ...value,
      governance: {
        ...value.governance,
        requirements: [
          {
            id: "req-1",
            key: "AUC-03-R1",
            title: "Acceptance",
            description: "Must hold",
            status: "verified",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        taskRequirements: [
          {
            taskId: "task-1",
            requirementId: "req-1",
            createdAt: timestamp,
          },
        ],
      },
    };
  }

  test("round-trips links through a checksummed archive", () => {
    const value = linked();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    const parsed = parsePortableProjectArchive(
      serializePortableProjectArchive(archive),
    );
    expect(parsed.state.governance.taskRequirements).toEqual([
      { taskId: "task-1", requirementId: "req-1", createdAt: timestamp },
    ]);
  });

  test("stays byte-identical to a pre-linkage archive when there are none", () => {
    // The archive checksum is recomputed over the *parsed* state, so a field
    // that were always present would invalidate every existing v1 archive. A
    // project with no links must therefore serialize exactly as it did before
    // the field existed.
    const value = state();
    expect(Object.hasOwn(value.governance, "taskRequirements")).toBe(false);
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    const serialized = serializePortableProjectArchive(archive);
    expect(serialized).not.toContain("taskRequirements");
    // And an archive written before this field existed still validates.
    expect(parsePortableProjectArchive(serialized)).toEqual(archive);
  });

  test("requires both ends of a link to be inside the snapshot", () => {
    const value = linked();
    expect(() =>
      createPortableProjectArchive({
        state: {
          ...value,
          governance: {
            ...value.governance,
            taskRequirements: [
              { taskId: "task-9", requirementId: "req-1", createdAt: timestamp },
            ],
          },
        },
        manifest: manifest(value),
      }),
    ).toThrow(/Referenced task task-9 is not portable/u);

    expect(() =>
      createPortableProjectArchive({
        state: {
          ...value,
          governance: {
            ...value.governance,
            taskRequirements: [
              { taskId: "task-1", requirementId: "req-9", createdAt: timestamp },
            ],
          },
        },
        manifest: manifest(value),
      }),
    ).toThrow(/Referenced requirement req-9 is not portable/u);
  });

  test("rejects a duplicated link", () => {
    const value = linked();
    const duplicated = {
      ...value,
      governance: {
        ...value.governance,
        taskRequirements: [
          { taskId: "task-1", requirementId: "req-1", createdAt: timestamp },
          { taskId: "task-1", requirementId: "req-1", createdAt: timestamp },
        ],
      },
    };
    expect(() =>
      createPortableProjectArchive({
        state: duplicated,
        manifest: manifest(duplicated),
      }),
    ).toThrow(/linked to requirement req-1 more than once/u);
  });

  test("rejects a corrupted link reference in a serialized archive", () => {
    const value = linked();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    const corrupted = serializePortableProjectArchive(archive).replace(
      '"requirementId":"req-1"',
      '"requirementId":"req-tampered"',
    );
    expect(() => parsePortableProjectArchive(corrupted)).toThrow(
      /not portable|checksum/u,
    );
  });
});

/**
 * One `formatVersion` must identify one schema.
 *
 * Version 1 is frozen where it shipped and cannot express a Task/Requirement
 * link at all; version 2 carries the link and says so in `contents`. A reader
 * accepts both, a writer picks the lowest that loses nothing, and neither
 * version's checksum depends on the other.
 */
describe("portable archive format versions", () => {
  function linkedState(): PortableProjectState {
    const value = state();
    return {
      ...value,
      governance: {
        ...value.governance,
        requirements: [
          {
            id: "req-1",
            key: "AUC-03-R1",
            title: "Acceptance",
            description: "Must hold",
            status: "verified",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        taskRequirements: [
          { taskId: "task-1", requirementId: "req-1", createdAt: timestamp },
        ],
      },
    };
  }

  test("writes version 1 for a project with no links and version 2 once it has them", () => {
    expect(portableProjectFormatVersionFor(state())).toBe(1);
    expect(portableProjectFormatVersionFor(linkedState())).toBe(2);

    const unlinked = createPortableProjectArchive({
      state: state(),
      manifest: manifest(state()),
    });
    expect(unlinked.manifest.formatVersion).toBe(1);
    expect(unlinked.manifest.contents).not.toContain("task_requirements");

    const value = linkedState();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    expect(archive.manifest.formatVersion).toBe(2);
    expect(archive.manifest.contents).toContain("task_requirements");
  });

  test("keeps a historical version 1 archive readable byte for byte", () => {
    // Written by hand rather than by the current writer: this is the exact
    // envelope a build that predates linkage produced, and it must still parse.
    const value = state();
    const historical = {
      manifest: {
        format: "ai-office-project",
        formatVersion: 1,
        projectIdentity: "repo_portable",
        createdAt: timestamp,
        revision: { id: "rev-1", stateChecksum: portableStateChecksum(value) },
        contents: [
          "project",
          "tasks",
          "profile",
          "office_manifests",
          "governance",
          "agent_definitions",
          "terminal_run_summaries",
        ],
      },
      state: value,
    };
    const serialized = `${canonicalStringify({
      ...historical,
      integrity: {
        algorithm: "sha256",
        checksum: sha256Canonical(historical),
      },
    })}\n`;
    expect(serialized).not.toContain("taskRequirements");
    expect(serialized).not.toContain("task_requirements");
    const parsed = parsePortableProjectArchive(serialized);
    expect(parsed.manifest.formatVersion).toBe(1);
    expect(parsed.state.governance.taskRequirements).toBeUndefined();
    // Byte-compatible: the current writer reproduces it exactly.
    expect(
      serializePortableProjectArchive(
        createPortableProjectArchive({ state: value, manifest: manifest(value) }),
      ),
    ).toBe(serialized);
  });

  test("round-trips a version 2 archive exactly", () => {
    const value = linkedState();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    const serialized = serializePortableProjectArchive(archive);
    const parsed = parsePortableProjectArchive(serialized);
    expect(parsed).toEqual(archive);
    expect(serializePortableProjectArchive(parsed)).toBe(serialized);
    expect(parsed.state.governance.taskRequirements).toEqual([
      { taskId: "task-1", requirementId: "req-1", createdAt: timestamp },
    ]);
  });

  test("refuses to write linkage into a version 1 archive", () => {
    const value = linkedState();
    expect(() =>
      createPortableProjectArchive({ state: value, manifest: manifest(value, 1) }),
    ).toThrow(
      "format version 1 cannot carry Task/Requirement links; write format version 2",
    );
  });

  test("refuses to read linkage out of a version 1 archive", () => {
    // The strict v1 governance schema is what makes the version contract hold:
    // a v1 envelope carrying links is not a v1 archive at all.
    const value = linkedState();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    const downgraded = {
      ...archive,
      manifest: {
        ...archive.manifest,
        formatVersion: 1,
        contents: archive.manifest.contents.slice(0, 7),
      },
    };
    expect(() =>
      parsePortableProjectArchive(canonicalStringify(downgraded)),
    ).toThrow(/taskRequirements|Unrecognized key/u);
  });

  test("refuses a version 2 archive that omits the linkage field", () => {
    const value = linkedState();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    const { taskRequirements: _dropped, ...governance } =
      archive.state.governance;
    expect(() =>
      parsePortableProjectArchive(
        canonicalStringify({
          ...archive,
          state: { ...archive.state, governance },
        }),
      ),
    ).toThrow(/taskRequirements/u);
  });

  test("validates checksums independently within each version", () => {
    for (const value of [state(), linkedState()]) {
      const archive = createPortableProjectArchive({
        state: value,
        manifest: manifest(value),
      });
      // State tampering breaks the state checksum...
      expect(() =>
        parsePortableProjectArchive(
          canonicalStringify({
            ...archive,
            state: {
              ...archive.state,
              project: { ...archive.state.project, name: "Tampered" },
            },
          }),
        ),
      ).toThrow("state checksum mismatch");
      // ...and manifest tampering breaks the envelope checksum.
      expect(() =>
        parsePortableProjectArchive(
          canonicalStringify({
            ...archive,
            manifest: { ...archive.manifest, projectIdentity: "repo_other" },
          }),
        ),
      ).toThrow("integrity checksum mismatch");
    }
  });

  test("rejects an unknown format version by name", () => {
    const value = state();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    expect(() =>
      parsePortableProjectArchive(
        JSON.stringify({
          ...archive,
          manifest: { ...archive.manifest, formatVersion: 99 },
        }),
      ),
    ).toThrow("supported: 1, 2");
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
    String.raw`C:\repo.git`,
    String.raw`C:\Users\Alice\repo.git`,
    "C:/repo.git",
    "C:repo.git",
    "C:folder/repo.git",
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

  test.each([
    "git@example.test:team/repo.git",
    "example.test:team/repo.git",
  ])("normalizes SCP provenance idempotently for %s", (remote) => {
    const normalized = portableGitRemote(remote);
    expect(normalized).toBe("ssh://example.test/team/repo.git");
    expect(portableGitRemote(normalized)).toBe(normalized);
  });

  test("selects agreed provenance independently of source insertion order", () => {
    const sources = [
      {
        remoteUrl: "https://alice:secret@example.test/team/repo.git",
        defaultBranch: "main",
      },
      {
        remoteUrl: "https://example.test/team/repo.git",
        defaultBranch: "main",
      },
      { remoteUrl: "file:///Users/alice/upstream.git" },
    ];
    const expected = {
      type: "git" as const,
      remote: "https://example.test/team/repo.git",
      branch: "main",
    };
    expect(selectPortableGitProvenance(sources)).toEqual(expected);
    expect(selectPortableGitProvenance([...sources].reverse())).toEqual(
      expected,
    );
  });

  test("omits ambiguous remotes and conflicting branch provenance", () => {
    expect(
      selectPortableGitProvenance([
        { remoteUrl: "https://example.test/team/one.git" },
        { remoteUrl: "https://example.test/team/two.git" },
      ]),
    ).toBeUndefined();
    expect(
      selectPortableGitProvenance([
        {
          remoteUrl: "https://example.test/team/repo.git",
          defaultBranch: "main",
        },
        {
          remoteUrl: "https://example.test/team/repo.git",
          defaultBranch: "release",
        },
      ]),
    ).toEqual({
      type: "git",
      remote: "https://example.test/team/repo.git",
    });
    expect(
      selectPortableGitProvenance([
        { remoteUrl: "/Users/alice/upstream.git", defaultBranch: "main" },
      ]),
    ).toBeUndefined();
  });
});

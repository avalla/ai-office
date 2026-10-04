import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type { ProjectProfileEntry } from "@ai-office/domain/project/project-profile.ts";
import {
  ManageKnowledgeAdmission,
  type KnowledgeAdmissionInput,
  type KnowledgeAdmissionPlan,
} from "../../packages/application/src/agent-knowledge/manage-knowledge-admission.ts";
import {
  isNonRunKnowledgeProvenance,
  type AgentKnowledgeStore,
  type KnowledgeProvenance,
  type LegacyKnowledgeHit,
  type NonRunKnowledgeInput,
} from "../../packages/application/src/ports/agent-knowledge-store.port.ts";
import type { AgentRuntimeRepository } from "../../packages/application/src/ports/agent-runtime-repository.port.ts";
import type { Clock } from "../../packages/application/src/ports/clock.port.ts";
import type { GovernanceRepository } from "../../packages/application/src/ports/governance-repository.port.ts";
import type { ProjectProfileRepository } from "../../packages/application/src/ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../../packages/application/src/ports/project-repository.port.ts";
import type { RepositoryIdentityRepository } from "../../packages/application/src/ports/repository-identity-repository.port.ts";
import type { TaskRepository } from "../../packages/application/src/ports/task-repository.port.ts";
import type { RecordAuditEvent } from "../../packages/application/src/commands/record-audit-event.ts";
import {
  repositoryFactsFromProfile,
  repositoryUnderstandingFingerprint,
} from "../../packages/application/src/project-lifecycle/repository-understanding.ts";

const completedAt = new Date("2026-09-30T10:00:00.000Z");
const confirmedAt = new Date("2026-10-01T09:00:00.000Z");
const admittedAt = new Date("2026-10-02T11:00:00.000Z");
const text = "The daemon owns every knowledge write";

function detected(
  projectId: string,
  languages: string[],
): ProjectProfileEntry[] {
  return [
    {
      id: `${projectId}-languages`,
      projectId,
      category: "stack",
      key: "languages",
      value: languages,
      origin: "detected",
      confidence: 1,
      createdAt: completedAt,
    },
  ];
}

function review(
  projectId: string,
  scan: ProjectProfileEntry[],
  overrides: Partial<ProjectProfileEntry> = {},
): ProjectProfileEntry {
  return {
    id: "confirmation-1",
    projectId,
    category: "handover",
    key: "repository_review",
    value: {
      contractVersion: 1,
      fingerprint: repositoryUnderstandingFingerprint(
        repositoryFactsFromProfile(scan)!,
      ),
      scanId: "scan-1",
      summary: "Bun monorepo with a daemon-backed CLI",
    },
    origin: "user",
    confidence: 1,
    sourceReference: "scan-1",
    confirmedAt,
    createdAt: confirmedAt,
    ...overrides,
  };
}

/** A project that was scanned and whose repository review the user confirmed. */
function confirmedProfile(projectId = "project-1"): ProjectProfileEntry[] {
  const scan = detected(projectId, ["TypeScript"]);
  return [...scan, review(projectId, scan)];
}

function fixture(
  options: {
    profile?: Record<string, ProjectProfileEntry[]>;
    recordFails?: boolean;
    approvalAuditFails?: boolean;
  } = {},
) {
  const profile = options.profile ?? { "project-1": confirmedProfile() };
  const records = new Map<string, NonRunKnowledgeInput>();
  const events: Array<Parameters<RecordAuditEvent["execute"]>[0]> = [];
  const trace = async (
    _scope: unknown,
    id: string,
  ): Promise<KnowledgeProvenance | null> => {
    const record = records.get(id);
    if (record === undefined) return null;
    const { title, ...rest } = record;
    return {
      knowledge: {
        ...rest,
        title: title ?? null,
        agentId: null,
        runId: null,
        taskId: null,
      },
      source: record.source,
      runId: null,
      taskId: null,
      agentId: null,
    };
  };
  const recordNonRunKnowledge = vi.fn(async (input: NonRunKnowledgeInput) => {
    if (options.recordFails) throw new Error("backend secret");
    records.set(input.id, input);
  });
  const recordMemory = vi.fn(async () => {});
  const recordDecision = vi.fn(async () => {});
  const traceLegacyMemory = vi.fn(
    async (): Promise<LegacyKnowledgeHit | null> => null,
  );
  const store = {
    recordMemory,
    recordDecision,
    recordNonRunKnowledge,
    traceMemoryProvenance: vi.fn(trace),
    traceDecisionProvenance: vi.fn(trace),
    traceLegacyMemory,
  } as unknown as AgentKnowledgeStore;
  const service = new ManageKnowledgeAdmission(
    {
      findById: async (id: string) => (id in profile ? {} : null),
    } as unknown as ProjectRepository,
    {
      findById: async (id: string) =>
        id === "task-1" || id === "task-2"
          ? { snapshot: () => ({ projectId: "project-1" }) }
          : id === "task-other"
            ? { snapshot: () => ({ projectId: "project-2" }) }
            : null,
    } as unknown as TaskRepository,
    {
      findRun: async (id: string) =>
        id === "run-1"
          ? {
              snapshot: () => ({
                id: "run-1",
                projectId: "project-1",
                taskId: "task-1",
                agentId: "agent-1",
                status: "completed",
                completedAt,
                execution: { kind: "worker" },
                result: { summary: "Analysis" },
              }),
            }
          : null,
      findAgent: async (id: string) => ({ id, projectId: "project-1" }),
    } as unknown as AgentRuntimeRepository,
    {
      findRepositoryId: async (id: string) => `repo-${id}`,
    } as unknown as RepositoryIdentityRepository,
    { state: "connected", tenantId: "tenant-1", store },
    {
      execute: async (event: Parameters<RecordAuditEvent["execute"]>[0]) => {
        if (
          options.approvalAuditFails &&
          event.eventType === "knowledge.admission.approved"
        )
          throw new Error("audit unavailable");
        events.push(event);
        return `audit-${events.length}`;
      },
    } as unknown as RecordAuditEvent,
    { now: () => admittedAt } as Clock,
    {
      listActiveProfileEntries: async (id: string) => profile[id] ?? [],
    } as unknown as ProjectProfileRepository,
    {
      getSnapshot: async (id: string) => ({
        milestones: [],
        requirements:
          id === "project-1"
            ? [{ id: "req-1", projectId: "project-1", key: "AK-11" }]
            : [{ id: "req-other", projectId: "project-2", key: "X-1" }],
        adrs:
          id === "project-1" ? [{ id: "adr-1", projectId: "project-1" }] : [],
        reviews:
          id === "project-1"
            ? [
                { id: "review-1", projectId: "project-1", status: "approved" },
                {
                  id: "review-open",
                  projectId: "project-1",
                  status: "pending",
                },
              ]
            : [],
        approvals: [],
      }),
    } as unknown as GovernanceRepository,
  );
  return {
    service,
    events,
    records,
    recordNonRunKnowledge,
    recordMemory,
    recordDecision,
    traceLegacyMemory,
  };
}

const handover: KnowledgeAdmissionInput = {
  projectId: "project-1",
  source: { kind: "handover", confirmationId: "confirmation-1" },
  kind: "memory",
  text,
};

function operator(
  evidence: readonly { kind: string; id: string }[] = [
    { kind: "requirement", id: "req-1" },
    { kind: "task", id: "task-1" },
  ],
  confirmedBy = "andrea",
): KnowledgeAdmissionInput {
  return {
    projectId: "project-1",
    source: { kind: "operator_confirmed", confirmedBy, evidence },
    kind: "memory",
    text,
  };
}

/** A source shape the type system forbids, as an untyped caller could send it. */
function untyped(
  source: unknown,
  extra: Record<string, unknown> = {},
): KnowledgeAdmissionInput {
  return {
    projectId: "project-1",
    kind: "memory",
    text,
    source,
    ...extra,
  } as KnowledgeAdmissionInput;
}

function approve(input: KnowledgeAdmissionInput, plan: KnowledgeAdmissionPlan) {
  return { ...input, approval: plan.planHash, reviewedBy: "andrea" };
}

describe("agent-run admission stays compatible", () => {
  it("keeps the AK-05 plan hash, identity, and shorthand for a completed worker run", async () => {
    const f = fixture();
    const shorthand = await f.service.plan({
      projectId: "project-1",
      runId: "run-1",
      kind: "memory",
      text,
    });
    const explicit = await f.service.plan({
      projectId: "project-1",
      source: { kind: "agent_run", runId: "run-1" },
      kind: "memory",
      text,
    });
    expect(explicit).toEqual(shorthand);
    // The hash a pre-AK-11 Runtime computed for the same content and authority.
    const legacyHash = createHash("sha256")
      .update(
        canonicalStringify({
          schemaVersion: 1,
          projectId: "project-1",
          repositoryId: "repo-project-1",
          runId: "run-1",
          taskId: "task-1",
          agentId: "agent-1",
          kind: "memory",
          title: null,
          text,
          source: {
            kind: "run",
            id: "run-1",
            label: "Agent run run-1",
            locator: `sha256:${createHash("sha256")
              .update(canonicalStringify({ summary: "Analysis" }), "utf8")
              .digest("hex")}`,
          },
          createdAt: completedAt.toISOString(),
          tenantId: "tenant-1",
        }),
        "utf8",
      )
      .digest("hex");
    expect(shorthand).toMatchObject({
      schemaVersion: 1,
      planHash: legacyHash,
      id: `ak_${legacyHash}`,
      provenance: {
        kind: "agent_run",
        runId: "run-1",
        taskId: "task-1",
        agentId: "agent-1",
      },
    });
  });
});

describe("handover provenance", () => {
  it("plans from the confirmed repository review without inventing a run", async () => {
    const f = fixture();
    const plan = await f.service.plan(handover);
    const fingerprint = (
      confirmedProfile()[1]!.value as { fingerprint: string }
    ).fingerprint;
    expect(plan).toMatchObject({
      schemaVersion: 2,
      projectId: "project-1",
      repositoryId: "repo-project-1",
      runId: null,
      taskId: null,
      agentId: null,
      createdAt: confirmedAt.toISOString(),
      source: {
        kind: "handover",
        id: "confirmation-1",
        locator: `sha256:${fingerprint}`,
      },
      provenance: {
        kind: "handover",
        confirmationId: "confirmation-1",
        fingerprint,
        scanId: "scan-1",
        confirmedAt: confirmedAt.toISOString(),
      },
    });
    expect(plan.id).toBe(`ak_${plan.planHash}`);
    expect(f.events).toEqual([]);
    expect(f.recordNonRunKnowledge).not.toHaveBeenCalled();
  });

  it("rejects every state short of a confirmed review", async () => {
    const scan = detected("project-1", ["TypeScript"]);
    const cases: Record<string, ProjectProfileEntry[]> = {
      "never scanned": [],
      "scanned or imported only": scan,
      "agent interpretation recorded as detected evidence": [
        ...scan,
        review("project-1", scan, { origin: "detected" }),
      ],
      "review recorded without a confirmation time": [
        ...scan,
        (({ confirmedAt: _unconfirmed, ...entry }) => entry)(
          review("project-1", scan),
        ),
      ],
      "review without scan evidence": [review("project-1", scan)],
      "a superseded confirmation ID": [
        ...scan,
        review("project-1", scan, { id: "confirmation-2" }),
      ],
    };
    for (const [name, profile] of Object.entries(cases)) {
      const f = fixture({ profile: { "project-1": profile } });
      await expect(f.service.plan(handover), name).rejects.toMatchObject({
        code: "KNOWLEDGE_HANDOVER_NOT_CONFIRMED",
      });
    }
  });

  it("rejects a review confirmed against repository evidence that has since changed", async () => {
    const before = detected("project-1", ["TypeScript"]);
    const f = fixture({
      profile: {
        "project-1": [
          ...detected("project-1", ["TypeScript", "Rust"]),
          review("project-1", before),
        ],
      },
    });
    await expect(f.service.plan(handover)).rejects.toMatchObject({
      code: "KNOWLEDGE_HANDOVER_STALE",
    });
  });

  it("rejects another project's confirmation", async () => {
    const other = detected("project-2", ["Go"]);
    const f = fixture({
      profile: {
        "project-1": detected("project-1", ["TypeScript"]),
        "project-2": [
          ...other,
          review("project-2", other, { id: "confirmation-other" }),
        ],
      },
    });
    await expect(
      f.service.plan({
        ...handover,
        source: { kind: "handover", confirmationId: "confirmation-other" },
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_HANDOVER_NOT_CONFIRMED" });

    // An entry filed under this project but owned by another is not evidence.
    const scan = detected("project-1", ["TypeScript"]);
    const misfiled = fixture({
      profile: {
        "project-1": [
          ...scan,
          review("project-1", scan, { projectId: "project-2" }),
        ],
      },
    });
    await expect(misfiled.service.plan(handover)).rejects.toMatchObject({
      code: "KNOWLEDGE_HANDOVER_NOT_CONFIRMED",
    });
  });

  it("invalidates an approved plan when the handover evidence changes before admission", async () => {
    const scan = detected("project-1", ["TypeScript"]);
    const profile = { "project-1": [...scan, review("project-1", scan)] };
    const f = fixture({ profile });
    const plan = await f.service.plan(handover);

    // The user re-confirms: a new confirmation supersedes the planned one.
    profile["project-1"] = [
      ...scan,
      review("project-1", scan, { id: "confirmation-2" }),
    ];
    await expect(
      f.service.admit(approve(handover, plan)),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_HANDOVER_NOT_CONFIRMED" });
    const replanned = await f.service.plan({
      ...handover,
      source: { kind: "handover", confirmationId: "confirmation-2" },
    });
    expect(replanned.planHash).not.toBe(plan.planHash);

    // The repository changes under the planned confirmation.
    profile["project-1"] = [
      ...detected("project-1", ["TypeScript", "Rust"]),
      review("project-1", scan),
    ];
    await expect(
      f.service.admit(approve(handover, plan)),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_HANDOVER_STALE" });
    expect(f.events).toEqual([]);
    expect(f.recordNonRunKnowledge).not.toHaveBeenCalled();
  });

  it("admits the exact approved plan with handover provenance and a complete audit trail", async () => {
    const f = fixture();
    const plan = await f.service.plan(handover);
    const result = await f.service.admit(approve(handover, plan));
    expect(result).toMatchObject({ id: plan.id, outcome: "recorded" });
    expect(f.recordMemory).not.toHaveBeenCalled();
    expect(f.recordNonRunKnowledge).toHaveBeenCalledTimes(1);
    const written = f.recordNonRunKnowledge.mock.calls[0]![0];
    expect(isNonRunKnowledgeProvenance(written.provenance)).toBe(true);
    expect(written).toMatchObject({
      tenantId: "tenant-1",
      repositoryId: "repo-project-1",
      id: plan.id,
      kind: "memory",
      text,
      createdAt: confirmedAt,
      provenance: { kind: "handover", confirmationId: "confirmation-1" },
    });
    expect(written).not.toHaveProperty("runId");
    expect(written).not.toHaveProperty("agentId");

    expect(f.events.map((event) => event.eventType)).toEqual([
      "knowledge.admission.approved",
      "knowledge.admission.recorded",
    ]);
    for (const event of f.events)
      expect(event).toMatchObject({
        actorType: "cli",
        actorId: "andrea",
        aggregateType: "agent_knowledge",
        aggregateId: plan.id,
        projectId: "project-1",
        payload: {
          kind: "memory",
          planHash: plan.planHash,
          provenanceKind: "handover",
          provenance: plan.provenance,
        },
      });
    expect(f.events[1]!.payload).toMatchObject({
      outcome: "recorded",
      admittedAt: admittedAt.toISOString(),
    });
    expect(JSON.stringify(f.events)).not.toContain(text);

    // An exact retry reconciles instead of writing a second record.
    expect((await f.service.admit(approve(handover, plan))).outcome).toBe(
      "reconciled",
    );
    expect(f.recordNonRunKnowledge).toHaveBeenCalledTimes(1);
  });
});

describe("operator-confirmed provenance", () => {
  it("plans from evidence the Runtime resolves inside the project", async () => {
    const f = fixture();
    const plan = await f.service.plan(
      operator([
        { kind: "task", id: "task-1" },
        { kind: "review", id: "review-1" },
        { kind: "requirement", id: "req-1" },
        { kind: "handover", id: "confirmation-1" },
        { kind: "adr", id: "adr-1" },
      ]),
    );
    expect(plan).toMatchObject({
      schemaVersion: 2,
      runId: null,
      taskId: null,
      agentId: null,
      createdAt: null,
      source: { kind: "operator", id: "andrea" },
      provenance: {
        kind: "operator_confirmed",
        confirmedBy: "andrea",
        evidence: [
          { kind: "adr", id: "adr-1", label: "ADR adr-1" },
          {
            kind: "handover",
            id: "confirmation-1",
            label: "Handover review confirmation-1",
          },
          { kind: "requirement", id: "req-1", label: "Requirement AK-11" },
          { kind: "review", id: "review-1", label: "Review review-1" },
          { kind: "task", id: "task-1", label: "Task task-1" },
        ],
      },
    });
    expect(f.events).toEqual([]);
  });

  it("requires the named operator's explicit confirmation of the exact plan", async () => {
    const f = fixture();
    const input = operator();
    const plan = await f.service.plan(input);
    // Planning, however often, confirms nothing.
    await f.service.plan(input);
    expect(f.records.size).toBe(0);
    expect(f.events).toEqual([]);

    // Another identity cannot confirm a plan that names this operator.
    await expect(
      f.service.admit({
        ...input,
        approval: plan.planHash,
        reviewedBy: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_CONFIRMATION_MISMATCH" });
    await expect(
      f.service.admit({ ...input, approval: "", reviewedBy: "andrea" }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_APPROVAL_MISMATCH" });
    expect(f.events).toEqual([]);
    expect(f.recordNonRunKnowledge).not.toHaveBeenCalled();

    const result = await f.service.admit(approve(input, plan));
    expect(result.outcome).toBe("recorded");
    const written = f.recordNonRunKnowledge.mock.calls[0]![0];
    expect(written.createdAt).toEqual(admittedAt);
    expect(written.provenance).toEqual(plan.provenance);
    expect(f.events[0]).toMatchObject({
      eventType: "knowledge.admission.approved",
      actorId: "andrea",
      payload: {
        planHash: plan.planHash,
        provenanceKind: "operator_confirmed",
        provenance: {
          kind: "operator_confirmed",
          confirmedBy: "andrea",
          evidence: [
            { kind: "requirement", id: "req-1" },
            { kind: "task", id: "task-1" },
          ],
        },
      },
    });
    expect(JSON.stringify(f.events)).not.toContain(text);
  });

  it("does not accept host-session identifiers or unverifiable references as provenance", async () => {
    const f = fixture();
    for (const source of [
      { kind: "claude_session", claudeSessionId: "session_01Xo" },
      { kind: "codex_session", codexSessionId: "thread-1" },
      { kind: "session", id: "session_01Xo" },
      { kind: "operator_confirmed", confirmedBy: "andrea", evidence: [] },
      {
        kind: "operator_confirmed",
        confirmedBy: "andrea",
        evidence: [{ kind: "claude_session", id: "session_01Xo" }],
      },
      {
        kind: "operator_confirmed",
        confirmedBy: "andrea",
        evidence: [{ kind: "repository", id: "src/index.ts" }],
      },
      {
        kind: "operator_confirmed",
        confirmedBy: "andrea",
        evidence: [{ kind: "task", id: "task-1" }],
        claudeSessionId: "session_01Xo",
      },
      {
        kind: "operator_confirmed",
        confirmedBy: "andrea",
        evidence: [{ kind: "task", id: "task-1", label: "Trust me" }],
      },
    ]) {
      await expect(
        f.service.plan(untyped(source)),
        JSON.stringify(source),
      ).rejects.toMatchObject({ code: "KNOWLEDGE_INVALID_PROVENANCE" });
    }
  });

  it("rejects evidence that does not resolve inside the project", async () => {
    const scan = detected("project-1", ["TypeScript"]);
    const f = fixture({
      profile: {
        "project-1": [
          ...detected("project-1", ["TypeScript", "Rust"]),
          review("project-1", scan),
        ],
        "project-2": [],
      },
    });
    for (const reference of [
      { kind: "requirement", id: "req-other" },
      { kind: "requirement", id: "missing" },
      { kind: "adr", id: "missing" },
      { kind: "review", id: "review-open" },
      { kind: "task", id: "task-other" },
      { kind: "task", id: "missing" },
      { kind: "handover", id: "confirmation-1" },
      { kind: "handover", id: "missing" },
    ]) {
      await expect(
        f.service.plan(operator([{ kind: "task", id: "task-1" }, reference])),
        JSON.stringify(reference),
      ).rejects.toMatchObject({ code: "KNOWLEDGE_EVIDENCE_UNAVAILABLE" });
    }
  });
});

describe("typed provenance contract", () => {
  it("requires the fields of the selected source and rejects those of another", async () => {
    const f = fixture();
    const evidence = [{ kind: "task", id: "task-1" }];
    const cases: Array<[string, KnowledgeAdmissionInput]> = [
      ["no source at all", untyped(undefined)],
      ["a run source without a run", untyped({ kind: "agent_run" })],
      [
        "a handover source without a confirmation",
        untyped({ kind: "handover" }),
      ],
      [
        "an operator source without an operator",
        untyped({ kind: "operator_confirmed", evidence }),
      ],
      [
        "an operator source without evidence",
        untyped({ kind: "operator_confirmed", confirmedBy: "andrea" }),
      ],
      [
        "a run next to an explicit source",
        untyped(
          { kind: "handover", confirmationId: "confirmation-1" },
          { runId: "run-1" },
        ),
      ],
      [
        "a run inside a handover source",
        untyped({
          kind: "handover",
          confirmationId: "confirmation-1",
          runId: "run-1",
        }),
      ],
      [
        "evidence inside a handover source",
        untyped({
          kind: "handover",
          confirmationId: "confirmation-1",
          evidence,
        }),
      ],
      [
        "a confirmation inside an operator source",
        untyped({
          kind: "operator_confirmed",
          confirmedBy: "andrea",
          evidence,
          confirmationId: "confirmation-1",
        }),
      ],
      [
        "an operator inside a run source",
        untyped({ kind: "agent_run", runId: "run-1", confirmedBy: "andrea" }),
      ],
      [
        "duplicate evidence",
        untyped({
          kind: "operator_confirmed",
          confirmedBy: "andrea",
          evidence: [...evidence, ...evidence],
        }),
      ],
      [
        "more evidence than the bound",
        untyped({
          kind: "operator_confirmed",
          confirmedBy: "andrea",
          evidence: Array.from({ length: 9 }, (_, index) => ({
            kind: "task",
            id: `task-${index}`,
          })),
        }),
      ],
      [
        "a padded operator identity",
        untyped({
          kind: "operator_confirmed",
          confirmedBy: " andrea",
          evidence,
        }),
      ],
    ];
    for (const [name, input] of cases) {
      await expect(f.service.plan(input), name).rejects.toMatchObject({
        code: "KNOWLEDGE_INVALID_PROVENANCE",
      });
    }
  });

  it("binds the plan hash to the exact provenance", async () => {
    const f = fixture();
    const base = await f.service.plan(operator());
    const hashes = [
      base.planHash,
      (await f.service.plan(operator([{ kind: "task", id: "task-1" }])))
        .planHash,
      (
        await f.service.plan(
          operator([
            { kind: "requirement", id: "req-1" },
            { kind: "task", id: "task-2" },
          ]),
        )
      ).planHash,
      (await f.service.plan(operator(undefined, "someone-else"))).planHash,
      (await f.service.plan(handover)).planHash,
      (
        await f.service.plan({
          projectId: "project-1",
          runId: "run-1",
          kind: "memory",
          text,
        })
      ).planHash,
    ];
    expect(new Set(hashes).size).toBe(hashes.length);

    // The same evidence in another order is the same provenance.
    const reordered = await f.service.plan(
      operator([
        { kind: "task", id: "task-1" },
        { kind: "requirement", id: "req-1" },
      ]),
    );
    expect(reordered.planHash).toBe(base.planHash);
  });

  it("refuses an approval after the provenance was modified", async () => {
    const f = fixture();
    const plan = await f.service.plan(operator());
    for (const changed of [
      operator([{ kind: "task", id: "task-1" }]),
      operator(undefined, "someone-else"),
      handover,
      { projectId: "project-1", runId: "run-1", kind: "memory" as const, text },
    ]) {
      await expect(
        f.service.admit({
          ...changed,
          approval: plan.planHash,
          reviewedBy: "andrea",
        }),
      ).rejects.toMatchObject({ code: "KNOWLEDGE_APPROVAL_MISMATCH" });
    }
    expect(f.events).toEqual([]);
    expect(f.recordNonRunKnowledge).not.toHaveBeenCalled();
  });
});

describe("non-run admission atomicity", () => {
  it("writes the record and its provenance in one store call and reports a failed write without a record", async () => {
    const f = fixture({ recordFails: true });
    const plan = await f.service.plan(handover);
    await expect(
      f.service.admit(approve(handover, plan)),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ADMISSION_OUTCOME_UNKNOWN" });
    expect(f.recordNonRunKnowledge).toHaveBeenCalledTimes(1);
    expect(f.records.size).toBe(0);
    expect(f.events.map((event) => event.eventType)).toEqual([
      "knowledge.admission.approved",
      "knowledge.admission.failed",
    ]);
    expect(f.events[1]!.payload).toMatchObject({
      errorCode: "KNOWLEDGE_ADMISSION_OUTCOME_UNKNOWN",
      provenanceKind: "handover",
    });
    expect(JSON.stringify(f.events)).not.toContain("backend secret");
  });

  it("does not touch the store when the approval cannot be audited", async () => {
    const f = fixture({ approvalAuditFails: true });
    const input = operator();
    const plan = await f.service.plan(input);
    await expect(f.service.admit(approve(input, plan))).rejects.toMatchObject({
      code: "KNOWLEDGE_APPROVAL_AUDIT_FAILED",
    });
    expect(f.recordNonRunKnowledge).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
  });

  it("fails closed when an existing record carries different provenance", async () => {
    const f = fixture();
    const input = operator();
    const plan = await f.service.plan(input);
    await f.service.admit(approve(input, plan));
    const stored = f.records.get(plan.id)!;
    f.records.set(plan.id, {
      ...stored,
      provenance: {
        kind: "operator_confirmed",
        confirmedBy: "andrea",
        evidence: [{ kind: "task", id: "task-2", label: "Task task-2" }],
      },
    });
    await expect(f.service.admit(approve(input, plan))).rejects.toMatchObject({
      code: "KNOWLEDGE_ADMISSION_CONFLICT",
    });
    expect(f.recordNonRunKnowledge).toHaveBeenCalledTimes(1);
  });
});

describe("knowledge trace explanation", () => {
  it("explains handover and operator-confirmed records by their evidence and admission", async () => {
    const f = fixture();
    const handoverPlan = await f.service.plan(handover);
    await f.service.admit(approve(handover, handoverPlan));
    const operatorInput = {
      ...operator(),
      kind: "decision" as const,
      title: "Writes",
    };
    const operatorPlan = await f.service.plan(operatorInput);
    await f.service.admit(approve(operatorInput, operatorPlan));

    const fromHandover = await f.service.explain(
      "project-1",
      "memory",
      handoverPlan.id,
    );
    expect(fromHandover).toMatchObject({
      provenance: {
        runId: null,
        taskId: null,
        agentId: null,
        knowledge: { id: handoverPlan.id, text },
        source: { kind: "handover", id: "confirmation-1" },
      },
      admissionSource: { projectId: "project-1", ...handoverPlan.provenance },
      admission: {
        planHash: handoverPlan.planHash,
        audit: {
          aggregateType: "agent_knowledge",
          aggregateId: handoverPlan.id,
          eventTypes: [
            "knowledge.admission.approved",
            "knowledge.admission.recorded",
            "knowledge.admission.failed",
          ],
        },
      },
    });

    const fromOperator = await f.service.explain(
      "project-1",
      "decision",
      operatorPlan.id,
    );
    expect(fromOperator).toMatchObject({
      provenance: { knowledge: { title: "Writes" } },
      admissionSource: { projectId: "project-1", ...operatorPlan.provenance },
      admission: { planHash: operatorPlan.planHash },
    });
    expect(
      await f.service.explain("project-1", "memory", "ak_missing"),
    ).toBeNull();
  });

  it("explains an imported legacy record without inventing an admission", async () => {
    const f = fixture();
    f.traceLegacyMemory.mockResolvedValue({
      tenantId: "tenant-1",
      repositoryId: "repo-project-1",
      id: "ak_legacy",
      kind: "memory",
      text: "Imported note",
      title: null,
      agentId: null,
      runId: null,
      taskId: null,
      source: {
        kind: "external",
        id: "notes/old",
        label: "CairnKeep named scope",
      },
      createdAt: completedAt,
      legacy: {
        sourceScope: "aio-0123456789abcdef0123456789abcdef",
        sourceKey: "notes/old",
        sourceSha256: `sha256:${"a".repeat(64)}`,
      },
    });
    expect(
      await f.service.explain("project-1", "memory", "ak_legacy"),
    ).toMatchObject({
      admissionSource: {
        kind: "legacy_import",
        projectId: "project-1",
        sourceKey: "notes/old",
      },
      admission: null,
    });
  });
});

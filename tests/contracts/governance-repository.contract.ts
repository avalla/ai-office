import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DuplicateRequirementKeyError } from "@ai-office/application/governance-errors.ts";
import type {
  GovernanceEventRecord,
  GovernanceRepository,
} from "@ai-office/application/ports/governance-repository.port.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import type {
  AdrRecord,
  ApprovalRecord,
  MilestoneRecord,
  RequirementRecord,
  ReviewRecord,
} from "@ai-office/domain/governance/governance.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";

export interface GovernanceRepositoryContractHarness {
  projects: ProjectRepository;
  governance: GovernanceRepository;
  seedEvent(value: GovernanceEventRecord): Promise<void>;
  close(): Promise<void>;
}

export function defineGovernanceRepositoryContracts(
  createHarness: () => Promise<GovernanceRepositoryContractHarness>,
): void {
  let harness: GovernanceRepositoryContractHarness;
  let prefix: string;

  beforeEach(async () => {
    harness = await createHarness();
    prefix = `governance-contract-${randomUUID()}`;
  });

  afterEach(async () => {
    await harness.close();
  });

  test("round-trips milestones and requirements with nullable milestones", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const milestone: MilestoneRecord = {
      id: `${prefix}-milestone`,
      projectId: project.id,
      title: "Milestone",
      description: "Description",
      status: "planned",
      createdAt: date("2026-01-01T00:00:00.000Z"),
      updatedAt: date("2026-01-01T00:00:00.000Z"),
    };
    await harness.governance.saveMilestone(milestone);

    const requirement: RequirementRecord = {
      id: `${prefix}-requirement`,
      projectId: project.id,
      milestoneId: milestone.id,
      key: "REQ-001",
      title: "Requirement",
      description: "Description",
      status: "proposed",
      createdAt: date("2026-01-02T00:00:00.000Z"),
      updatedAt: date("2026-01-02T00:00:00.000Z"),
    };
    await harness.governance.saveRequirement(requirement);

    const snapshot = await harness.governance.getSnapshot(project.id);
    expect(snapshot.milestones).toEqual([milestone]);
    expect(snapshot.requirements).toEqual([requirement]);
  });

  test("updates a milestone title and appends an audit event", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const milestone: MilestoneRecord = {
      id: `${prefix}-milestone`,
      projectId: project.id,
      title: "Before",
      status: "planned",
      createdAt: date("2026-01-01T00:00:00.000Z"),
      updatedAt: date("2026-01-01T00:00:00.000Z"),
    };
    await harness.governance.saveMilestone(milestone);

    const changedAt = date("2026-01-02T00:00:00.000Z");
    await expect(
      harness.governance.updateMilestoneTitle(
        milestone.id,
        project.id,
        milestone.title,
        "After",
        changedAt,
        `${prefix}-title-changed`,
      ),
    ).resolves.toBe(true);
    await expect(
      harness.governance.updateMilestoneTitle(
        milestone.id,
        project.id,
        milestone.title,
        "Stale update",
        date("2026-01-03T00:00:00.000Z"),
        `${prefix}-stale-title-changed`,
      ),
    ).resolves.toBe(false);

    expect((await harness.governance.getSnapshot(project.id)).milestones).toEqual(
      [{ ...milestone, title: "After", updatedAt: changedAt }],
    );
    expect(
      (await harness.governance.listEvents(project.id)).map((event) => ({
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        metadata: event.metadata,
      })),
    ).toEqual([
      {
        eventType: "milestone.created",
        aggregateId: milestone.id,
        metadata: {},
      },
      {
        eventType: "milestone.title_changed",
        aggregateId: milestone.id,
        metadata: { from: "Before", to: "After" },
      },
    ]);
  });

  test("rejects duplicate requirement keys within a project", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const first = requirement(project.id, `${prefix}-first`, "REQ-001");
    await harness.governance.saveRequirement(first);

    await expect(
      harness.governance.saveRequirement({
        ...first,
        id: `${prefix}-second`,
        title: "Second",
      }),
    ).rejects.toBeInstanceOf(DuplicateRequirementKeyError);
  });

  test("enforces same-project milestone ownership", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const otherProject = await createProject(harness, `${prefix}-other`);
    const milestone: MilestoneRecord = {
      id: `${prefix}-other-milestone`,
      projectId: otherProject.id,
      title: "Other",
      status: "planned",
      createdAt: date("2026-01-01T00:00:00.000Z"),
      updatedAt: date("2026-01-01T00:00:00.000Z"),
    };
    await harness.governance.saveMilestone(milestone);

    await expect(
      harness.governance.saveRequirement({
        ...requirement(project.id, `${prefix}-requirement`, "REQ-001"),
        milestoneId: milestone.id,
      }),
    ).rejects.toThrow();
  });

  test("round-trips ADRs and enforces superseding ownership", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const otherProject = await createProject(harness, `${prefix}-other`);
    const target = adr(project.id, `${prefix}-target`, "Target");
    await harness.governance.saveAdr(target);

    const source: AdrRecord = {
      ...adr(project.id, `${prefix}-source`, "Source"),
      status: "superseded",
      supersededById: target.id,
    };
    await harness.governance.saveAdr(source);

    await expect(
      harness.governance.saveAdr({
        ...adr(project.id, `${prefix}-cross`, "Cross"),
        supersededById: (
          await saveAdr(harness, otherProject.id, `${prefix}-other-adr`)
        ).id,
      }),
    ).rejects.toThrow();

    expect((await harness.governance.getSnapshot(project.id)).adrs).toEqual([
      source,
      target,
    ]);
  });

  test("lists each project deterministically and isolates other projects", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const otherProject = await createProject(harness, `${prefix}-other`);
    const sameTime = date("2026-01-01T00:00:00.000Z");

    await harness.governance.saveMilestone({
      id: `${prefix}-milestone-b`,
      projectId: project.id,
      title: "B",
      status: "planned",
      createdAt: sameTime,
      updatedAt: sameTime,
    });
    await harness.governance.saveMilestone({
      id: `${prefix}-milestone-a`,
      projectId: project.id,
      title: "A",
      status: "planned",
      createdAt: sameTime,
      updatedAt: sameTime,
    });
    await harness.governance.saveMilestone({
      id: `${prefix}-other-milestone`,
      projectId: otherProject.id,
      title: "Other",
      status: "planned",
      createdAt: sameTime,
      updatedAt: sameTime,
    });
    await harness.governance.saveRequirement(
      requirement(project.id, `${prefix}-requirement-z`, "Z-001"),
    );
    await harness.governance.saveRequirement(
      requirement(project.id, `${prefix}-requirement-a`, "A-001"),
    );

    const snapshot = await harness.governance.getSnapshot(project.id);
    expect(snapshot.milestones.map((value) => value.id)).toEqual([
      `${prefix}-milestone-a`,
      `${prefix}-milestone-b`,
    ]);
    expect(snapshot.requirements.map((value) => value.key)).toEqual([
      "A-001",
      "Z-001",
    ]);
    expect(
      snapshot.milestones.every((value) => value.projectId === project.id),
    ).toBe(true);
  });

  test("round-trips reviews and rejects missing subjects", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    await expect(
      harness.governance.saveReview({
        id: `${prefix}-missing-review`,
        projectId: project.id,
        subjectType: "requirement",
        subjectId: `${prefix}-missing`,
        reviewer: { type: "user", id: "reviewer" },
        status: "pending",
        createdAt: date("2026-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow();

    const savedRequirement = requirement(
      project.id,
      `${prefix}-requirement`,
      "REQ-001",
    );
    await harness.governance.saveRequirement(savedRequirement);
    const review: ReviewRecord = {
      id: `${prefix}-review`,
      projectId: project.id,
      subjectType: "requirement",
      subjectId: savedRequirement.id,
      reviewer: {
        type: "agent",
        id: "review-agent",
        displayName: "Review Agent",
      },
      status: "pending",
      summary: "Review summary",
      createdAt: date("2026-01-02T00:00:00.000Z"),
    };
    await harness.governance.saveReview(review);

    expect(await harness.governance.findReview(review.id, project.id)).toEqual(
      review,
    );
  });

  test("finalizes a review atomically and rejects duplicate finalization", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const savedRequirement = requirement(
      project.id,
      `${prefix}-requirement`,
      "REQ-001",
    );
    await harness.governance.saveRequirement(savedRequirement);
    const review: ReviewRecord = {
      id: `${prefix}-review`,
      projectId: project.id,
      subjectType: "requirement",
      subjectId: savedRequirement.id,
      reviewer: { type: "user", id: "reviewer" },
      status: "pending",
      createdAt: date("2026-01-02T00:00:00.000Z"),
    };
    await harness.governance.saveReview(review);

    const approval: ApprovalRecord = {
      id: `${prefix}-approval`,
      projectId: project.id,
      reviewId: review.id,
      decision: "approved",
      actor: { type: "user", id: "approver" },
      createdAt: date("2026-01-03T00:00:00.000Z"),
    };
    await expect(harness.governance.decideReview(approval)).resolves.toBe(
      "decided",
    );
    await expect(
      harness.governance.decideReview({
        ...approval,
        id: `${prefix}-second-approval`,
        decision: "rejected",
      }),
    ).resolves.toBe("already_finalized");

    const snapshot = await harness.governance.getSnapshot(project.id);
    expect(snapshot.approvals).toEqual([approval]);
    expect(snapshot.reviews[0]).toMatchObject({
      id: review.id,
      status: "approved",
      completedAt: approval.createdAt,
    });
  });

  test("persists ordered governance events and rolls back aggregate-plus-event writes", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const first: MilestoneRecord = {
      id: `${prefix}-first`,
      projectId: project.id,
      title: "First",
      status: "planned",
      createdAt: date("2026-01-01T00:00:00.000Z"),
      updatedAt: date("2026-01-01T00:00:00.000Z"),
    };
    await harness.governance.saveMilestone(first);
    await harness.governance.updateStatus(
      "milestone",
      first.id,
      project.id,
      "planned",
      "active",
      date("2026-01-02T00:00:00.000Z"),
    );
    expect(
      (await harness.governance.listEvents(project.id)).map(
        (event) => event.eventType,
      ),
    ).toEqual(["milestone.created", "milestone.status_changed"]);

    const blockedId = `${prefix}-blocked`;
    await harness.seedEvent({
      id: `milestone:${blockedId}:created`,
      projectId: project.id,
      eventType: "milestone.created",
      aggregateId: blockedId,
      metadata: {},
      occurredAt: date("2026-01-03T00:00:00.000Z"),
    });
    await expect(
      harness.governance.saveMilestone({
        ...first,
        id: blockedId,
        title: "Blocked",
      }),
    ).rejects.toThrow();

    expect(
      (await harness.governance.getSnapshot(project.id)).milestones.map(
        (value) => value.id,
      ),
    ).toEqual([first.id]);
    expect(
      (await harness.governance.listEvents(project.id)).map(
        (event) => event.id,
      ),
    ).toEqual([
      `milestone:${first.id}:created`,
      `milestone:${first.id}:status:active`,
      `milestone:${blockedId}:created`,
    ]);
  });
}

async function createProject(
  harness: GovernanceRepositoryContractHarness,
  id: string,
): Promise<{ id: string }> {
  const project = Project.create({
    id,
    name: id,
    now: date("2026-01-01T00:00:00.000Z"),
  });
  await harness.projects.save(project);
  return { id };
}

function requirement(
  projectId: string,
  id: string,
  key: string,
): RequirementRecord {
  return {
    id,
    projectId,
    key,
    title: key,
    description: `Description for ${key}`,
    status: "proposed",
    createdAt: date("2026-01-01T00:00:00.000Z"),
    updatedAt: date("2026-01-01T00:00:00.000Z"),
  };
}

function adr(projectId: string, id: string, title: string): AdrRecord {
  return {
    id,
    projectId,
    title,
    context: "Context",
    decision: "Decision",
    consequences: "Consequences",
    status: "proposed",
    createdAt: date("2026-01-01T00:00:00.000Z"),
    updatedAt: date("2026-01-01T00:00:00.000Z"),
  };
}

async function saveAdr(
  harness: GovernanceRepositoryContractHarness,
  projectId: string,
  id: string,
): Promise<AdrRecord> {
  const value = adr(projectId, id, id);
  await harness.governance.saveAdr(value);
  return value;
}

function date(value: string): Date {
  return new Date(value);
}

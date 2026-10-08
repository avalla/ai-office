import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import {
  DuplicateRequirementKeyError,
  GovernanceCrossProjectReferenceError,
  GovernanceSubjectNotFoundError,
  RequirementNotEditableError,
} from "@ai-office/application/governance-errors.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
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
  /** Makes appending the audit event with this id fail, as a storage fault. */
  failEventAppend(eventId: string): Promise<void>;
  restoreEventAppend(): Promise<void>;
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

    expect(
      (await harness.governance.getSnapshot(project.id)).milestones,
    ).toEqual([{ ...milestone, title: "After", updatedAt: changedAt }]);
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

  test("updates a milestone description without losing the old record or exposing prose in event metadata", async () => {
    const project = await createProject(
      harness,
      `${prefix}-description-project`,
    );
    const createdAt = date("2026-01-01T00:00:00.000Z");
    const milestone: MilestoneRecord = {
      id: `${prefix}-description-milestone`,
      projectId: project.id,
      title: "Milestone",
      description: "Old count",
      status: "completed",
      createdAt,
      updatedAt: createdAt,
    };
    await harness.governance.saveMilestone(milestone);
    const changedAt = date("2026-01-02T00:00:00.000Z");
    expect(
      await harness.governance.updateMilestoneDescription(
        milestone.id,
        project.id,
        "Old count",
        "Nine slices",
        changedAt,
        `${prefix}-description-changed`,
      ),
    ).toBe(true);
    expect(
      await harness.governance.updateMilestoneDescription(
        milestone.id,
        project.id,
        "Old count",
        "Stale",
        changedAt,
        `${prefix}-stale-description`,
      ),
    ).toBe(false);
    expect(
      (await harness.governance.getSnapshot(project.id)).milestones,
    ).toEqual([
      { ...milestone, description: "Nine slices", updatedAt: changedAt },
    ]);
    const events = await harness.governance.listEvents(project.id);
    expect(events.at(-1)).toMatchObject({
      eventType: "milestone.description_changed",
      metadata: { descriptionUpdated: "true" },
    });
  });

  test("updates proposed requirement text with one audit event per change", async () => {
    const project = await createProject(harness, `${prefix}-update-project`);
    const milestone: MilestoneRecord = {
      id: `${prefix}-update-milestone`,
      projectId: project.id,
      title: "Milestone",
      status: "planned",
      createdAt: date("2026-01-01T00:00:00.000Z"),
      updatedAt: date("2026-01-01T00:00:00.000Z"),
    };
    await harness.governance.saveMilestone(milestone);
    const original: RequirementRecord = {
      ...requirement(project.id, `${prefix}-update`, "REQ-UPD"),
      milestoneId: milestone.id,
    };
    await harness.governance.saveRequirement(original);
    const changedAt = date("2026-01-02T00:00:00.000Z");
    const service = governanceService(harness, changedAt, `${prefix}-event`);
    const stored = async () =>
      (await harness.governance.getSnapshot(project.id)).requirements;
    const updates = async () =>
      (await harness.governance.listEvents(project.id)).filter(
        (event) => event.eventType === "requirement.updated",
      );

    await service.updateRequirement({
      projectId: project.id,
      requirementId: original.id,
      title: "  New title  ",
    });
    expect(await stored()).toEqual([
      { ...original, title: "New title", updatedAt: changedAt },
    ]);

    await service.updateRequirement({
      projectId: project.id,
      requirementId: original.id,
      description: "New wording \u{1F600}",
    });
    await service.updateRequirement({
      projectId: project.id,
      requirementId: original.id,
      title: "Final title",
      description: "Final wording",
    });
    // Identity, key, milestone, status and creation metadata never move.
    expect(await stored()).toEqual([
      {
        ...original,
        title: "Final title",
        description: "Final wording",
        updatedAt: changedAt,
      },
    ]);

    // Resubmitting the stored text is not a change and is not audited.
    await service.updateRequirement({
      projectId: project.id,
      requirementId: original.id,
      title: "Final title",
      description: "Final wording",
    });
    expect(
      (await updates()).map(({ id, aggregateId, metadata, occurredAt }) => ({
        id,
        aggregateId,
        metadata,
        occurredAt,
      })),
    ).toEqual([
      {
        id: `${prefix}-event-1`,
        aggregateId: original.id,
        metadata: {
          key: "REQ-UPD",
          titleFrom: "REQ-UPD",
          titleTo: "New title",
        },
        occurredAt: changedAt,
      },
      {
        id: `${prefix}-event-2`,
        aggregateId: original.id,
        metadata: { key: "REQ-UPD", descriptionUpdated: "true" },
        occurredAt: changedAt,
      },
      {
        id: `${prefix}-event-3`,
        aggregateId: original.id,
        metadata: {
          key: "REQ-UPD",
          titleFrom: "New title",
          titleTo: "Final title",
          descriptionUpdated: "true",
        },
        occurredAt: changedAt,
      },
    ]);
    expect(JSON.stringify(await updates())).not.toContain("wording");
  });

  test("rejects requirement updates without a field, with blank text, or outside the project", async () => {
    const project = await createProject(harness, `${prefix}-reject-project`);
    const other = await createProject(harness, `${prefix}-reject-other`);
    const original = requirement(project.id, `${prefix}-reject`, "REQ-REJ");
    await harness.governance.saveRequirement(original);
    const foreign = requirement(other.id, `${prefix}-foreign`, "REQ-REJ");
    await harness.governance.saveRequirement(foreign);
    const service = governanceService(
      harness,
      date("2026-01-02T00:00:00.000Z"),
      `${prefix}-event`,
    );

    await expect(
      service.updateRequirement({
        projectId: project.id,
        requirementId: original.id,
      }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    for (const blank of [{ title: "  " }, { description: "" }])
      await expect(
        service.updateRequirement({
          projectId: project.id,
          requirementId: original.id,
          ...blank,
        }),
      ).rejects.toBeInstanceOf(DomainValidationError);
    await expect(
      service.updateRequirement({
        projectId: project.id,
        requirementId: `${prefix}-missing`,
        title: "Missing",
      }),
    ).rejects.toBeInstanceOf(GovernanceSubjectNotFoundError);
    // A requirement of another project is indistinguishable from an unknown one.
    await expect(
      service.updateRequirement({
        projectId: project.id,
        requirementId: foreign.id,
        title: "Cross-project",
      }),
    ).rejects.toBeInstanceOf(GovernanceSubjectNotFoundError);
    await expect(
      service.updateRequirement({
        projectId: `${prefix}-no-project`,
        requirementId: original.id,
        title: "No project",
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(
      await harness.governance.updateRequirementText(
        foreign.id,
        project.id,
        { title: foreign.title, description: foreign.description },
        { title: "Cross-project", description: foreign.description },
        date("2026-01-02T00:00:00.000Z"),
        { id: `${prefix}-cross-event`, metadata: {} },
      ),
    ).toBe(false);

    expect(
      (await harness.governance.getSnapshot(project.id)).requirements,
    ).toEqual([original]);
    expect(
      (await harness.governance.getSnapshot(other.id)).requirements,
    ).toEqual([foreign]);
    for (const id of [project.id, other.id])
      expect(
        (await harness.governance.listEvents(id)).map(
          (event) => event.eventType,
        ),
      ).toEqual(["requirement.created"]);
  });

  test.each([
    ["accepted", ["accepted"]],
    ["implemented", ["accepted", "implemented"]],
    ["verified", ["accepted", "implemented", "verified"]],
    ["rejected", ["rejected"]],
  ] as const)(
    "refuses to update a %s requirement",
    async (status, transitions) => {
      const project = await createProject(harness, `${prefix}-${status}`);
      const original = requirement(project.id, `${prefix}-${status}`, "REQ");
      await harness.governance.saveRequirement(original);
      const changedAt = date("2026-01-02T00:00:00.000Z");
      const service = governanceService(harness, changedAt, `${prefix}-event`);
      for (const next of transitions)
        await service.setStatus({
          projectId: project.id,
          kind: "requirement",
          id: original.id,
          status: next,
        });
      const settled = (await harness.governance.getSnapshot(project.id))
        .requirements;
      expect(settled[0]?.status).toBe(status);

      const error = await service
        .updateRequirement({
          projectId: project.id,
          requirementId: original.id,
          title: "Too late",
          description: "Too late",
        })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(RequirementNotEditableError);
      expect((error as Error).message).toContain(status);
      // The storage fence holds even when the application guard is skipped.
      expect(
        await harness.governance.updateRequirementText(
          original.id,
          project.id,
          { title: original.title, description: original.description },
          { title: "Too late", description: original.description },
          changedAt,
          { id: `${prefix}-forced-event`, metadata: {} },
        ),
      ).toBe(false);

      expect(
        (await harness.governance.getSnapshot(project.id)).requirements,
      ).toEqual(settled);
      expect(
        (await harness.governance.listEvents(project.id)).filter(
          (event) => event.eventType === "requirement.updated",
        ),
      ).toEqual([]);
    },
  );

  test("a stale requirement text expectation loses and writes no audit event", async () => {
    const project = await createProject(harness, `${prefix}-stale-project`);
    const original = requirement(project.id, `${prefix}-stale`, "REQ-STALE");
    await harness.governance.saveRequirement(original);
    const changedAt = date("2026-01-02T00:00:00.000Z");
    const expected = {
      title: original.title,
      description: original.description,
    };
    expect(
      await harness.governance.updateRequirementText(
        original.id,
        project.id,
        expected,
        { ...expected, description: "First writer" },
        changedAt,
        { id: `${prefix}-first-event`, metadata: { key: original.key } },
      ),
    ).toBe(true);
    expect(
      await harness.governance.updateRequirementText(
        original.id,
        project.id,
        expected,
        { ...expected, description: "Second writer" },
        changedAt,
        { id: `${prefix}-second-event`, metadata: { key: original.key } },
      ),
    ).toBe(false);
    expect(
      (await harness.governance.getSnapshot(project.id)).requirements,
    ).toEqual([
      { ...original, description: "First writer", updatedAt: changedAt },
    ]);
    expect(
      (await harness.governance.listEvents(project.id))
        .filter((event) => event.eventType === "requirement.updated")
        .map((event) => event.id),
    ).toEqual([`${prefix}-first-event`]);
  });

  test("assigns a missing requirement milestone once and audits it", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const other = await createProject(harness, `${prefix}-other-project`);
    const milestone: MilestoneRecord = {
      id: `${prefix}-milestone`,
      projectId: project.id,
      title: "Milestone",
      status: "planned",
      createdAt: date("2026-01-01T00:00:00.000Z"),
      updatedAt: date("2026-01-01T00:00:00.000Z"),
    };
    const foreignMilestone: MilestoneRecord = {
      ...milestone,
      id: `${prefix}-foreign-milestone`,
      projectId: other.id,
    };
    await harness.governance.saveMilestone(milestone);
    await harness.governance.saveMilestone(foreignMilestone);
    const orphan = requirement(project.id, `${prefix}-orphan`, "REQ-ORPHAN");
    await harness.governance.saveRequirement(orphan);
    const assignedAt = date("2026-01-02T00:00:00.000Z");
    const service = governanceService(harness, assignedAt, `${prefix}-event`);
    const stored = async () =>
      (await harness.governance.getSnapshot(project.id)).requirements;
    const audited = async () =>
      (await harness.governance.listEvents(project.id)).filter(
        (event) => event.eventType === "requirement.updated",
      );

    await service.assignRequirementMilestone({
      projectId: project.id,
      requirementId: orphan.id,
      milestoneId: milestone.id,
    });
    // Only the milestone and the update time move.
    expect(await stored()).toEqual([
      { ...orphan, milestoneId: milestone.id, updatedAt: assignedAt },
    ]);
    expect(
      (await audited()).map(({ id, aggregateId, metadata }) => ({
        id,
        aggregateId,
        metadata,
      })),
    ).toEqual([
      {
        id: `${prefix}-event-1`,
        aggregateId: orphan.id,
        metadata: { key: "REQ-ORPHAN", milestoneTo: milestone.id },
      },
    ]);

    // A milestone that is set stays immutable, even to the same value.
    const second: MilestoneRecord = { ...milestone, id: `${prefix}-second` };
    await harness.governance.saveMilestone(second);
    for (const target of [second.id, milestone.id])
      await expect(
        service.assignRequirementMilestone({
          projectId: project.id,
          requirementId: orphan.id,
          milestoneId: target,
        }),
      ).rejects.toBeInstanceOf(DomainValidationError);
    expect(
      await harness.governance.assignRequirementMilestone(
        orphan.id,
        project.id,
        second.id,
        assignedAt,
        { id: `${prefix}-forced-event`, metadata: {} },
      ),
    ).toBe(false);
    expect((await stored())[0]?.milestoneId).toBe(milestone.id);
    expect(await audited()).toHaveLength(1);
  });

  test("refuses to assign a milestone to an unknown, foreign or settled requirement", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const other = await createProject(harness, `${prefix}-other-project`);
    const milestone: MilestoneRecord = {
      id: `${prefix}-milestone`,
      projectId: project.id,
      title: "Milestone",
      status: "planned",
      createdAt: date("2026-01-01T00:00:00.000Z"),
      updatedAt: date("2026-01-01T00:00:00.000Z"),
    };
    const foreignMilestone: MilestoneRecord = {
      ...milestone,
      id: `${prefix}-foreign-milestone`,
      projectId: other.id,
    };
    await harness.governance.saveMilestone(milestone);
    await harness.governance.saveMilestone(foreignMilestone);
    const orphan = requirement(project.id, `${prefix}-orphan`, "REQ-ORPHAN");
    const foreign = requirement(other.id, `${prefix}-foreign`, "REQ-FOREIGN");
    const settled = requirement(project.id, `${prefix}-settled`, "REQ-SETTLED");
    const accepted = requirement(
      project.id,
      `${prefix}-accepted`,
      "REQ-ACCEPTED",
    );
    for (const value of [orphan, foreign, settled, accepted])
      await harness.governance.saveRequirement(value);
    const at = date("2026-01-02T00:00:00.000Z");
    const service = governanceService(harness, at, `${prefix}-event`);
    await service.setStatus({
      projectId: project.id,
      kind: "requirement",
      id: settled.id,
      status: "rejected",
    });
    await service.setStatus({
      projectId: project.id,
      kind: "requirement",
      id: accepted.id,
      status: "accepted",
    });
    const assign = (requirementId: string, milestoneId: string) =>
      service.assignRequirementMilestone({
        projectId: project.id,
        requirementId,
        milestoneId,
      });

    await expect(
      assign(`${prefix}-missing`, milestone.id),
    ).rejects.toBeInstanceOf(GovernanceSubjectNotFoundError);
    await expect(assign(foreign.id, milestone.id)).rejects.toBeInstanceOf(
      GovernanceSubjectNotFoundError,
    );
    await expect(assign(orphan.id, `${prefix}-missing`)).rejects.toBeInstanceOf(
      GovernanceSubjectNotFoundError,
    );
    await expect(assign(orphan.id, foreignMilestone.id)).rejects.toBeInstanceOf(
      GovernanceCrossProjectReferenceError,
    );
    await expect(assign(settled.id, milestone.id)).rejects.toBeInstanceOf(
      RequirementNotEditableError,
    );
    await expect(assign(accepted.id, milestone.id)).rejects.toBeInstanceOf(
      RequirementNotEditableError,
    );
    // The storage fence holds even when the application guards are skipped.
    expect(
      await harness.governance.assignRequirementMilestone(
        settled.id,
        project.id,
        milestone.id,
        at,
        { id: `${prefix}-forced-settled`, metadata: {} },
      ),
    ).toBe(false);
    // A status change that wins the race leaves the storage fence to refuse.
    expect(
      await harness.governance.assignRequirementMilestone(
        accepted.id,
        project.id,
        milestone.id,
        at,
        { id: `${prefix}-forced-accepted`, metadata: {} },
      ),
    ).toBe(false);
    expect(
      await harness.governance.assignRequirementMilestone(
        foreign.id,
        project.id,
        milestone.id,
        at,
        { id: `${prefix}-forced-foreign`, metadata: {} },
      ),
    ).toBe(false);
    await expect(
      service.assignRequirementMilestone({
        projectId: `${prefix}-no-project`,
        requirementId: orphan.id,
        milestoneId: milestone.id,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    expect(
      (await harness.governance.getSnapshot(project.id)).requirements.map(
        (value) => value.milestoneId,
      ),
    ).toEqual([undefined, undefined, undefined]);
    expect(
      (await harness.governance.listEvents(project.id)).filter(
        (event) => event.eventType === "requirement.updated",
      ),
    ).toEqual([]);
  });

  test("an audit failure rolls the milestone assignment back", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const milestone: MilestoneRecord = {
      id: `${prefix}-milestone`,
      projectId: project.id,
      title: "Milestone",
      status: "planned",
      createdAt: date("2026-01-01T00:00:00.000Z"),
      updatedAt: date("2026-01-01T00:00:00.000Z"),
    };
    await harness.governance.saveMilestone(milestone);
    const orphan = requirement(project.id, `${prefix}-orphan`, "REQ-ORPHAN");
    await harness.governance.saveRequirement(orphan);
    const eventId = `${prefix}-failing-event`;
    await harness.failEventAppend(eventId);
    try {
      await expect(
        harness.governance.assignRequirementMilestone(
          orphan.id,
          project.id,
          milestone.id,
          date("2026-01-02T00:00:00.000Z"),
          { id: eventId, metadata: { key: orphan.key } },
        ),
      ).rejects.toThrow();
    } finally {
      await harness.restoreEventAppend();
    }
    // Neither half of the change survived: the update and its audit are one unit.
    expect(
      (await harness.governance.getSnapshot(project.id)).requirements,
    ).toEqual([orphan]);
    expect(
      (await harness.governance.listEvents(project.id)).filter(
        (event) => event.eventType === "requirement.updated",
      ),
    ).toEqual([]);
  });

  test("two concurrent assignments let exactly one win and audit once", async () => {
    const project = await createProject(harness, `${prefix}-project`);
    const milestones = ["first", "second"].map((name): MilestoneRecord => ({
      id: `${prefix}-${name}`,
      projectId: project.id,
      title: name,
      status: "planned",
      createdAt: date("2026-01-01T00:00:00.000Z"),
      updatedAt: date("2026-01-01T00:00:00.000Z"),
    }));
    for (const value of milestones)
      await harness.governance.saveMilestone(value);
    const orphan = requirement(project.id, `${prefix}-orphan`, "REQ-ORPHAN");
    await harness.governance.saveRequirement(orphan);
    const at = date("2026-01-02T00:00:00.000Z");

    const results = await Promise.all(
      milestones.map((value, index) =>
        harness.governance.assignRequirementMilestone(
          orphan.id,
          project.id,
          value.id,
          at,
          { id: `${prefix}-race-${index}`, metadata: {} },
        ),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = milestones[results.indexOf(true)]!;
    expect(
      (await harness.governance.getSnapshot(project.id)).requirements[0]
        ?.milestoneId,
    ).toBe(winner.id);
    expect(
      (await harness.governance.listEvents(project.id)).filter(
        (event) => event.eventType === "requirement.updated",
      ),
    ).toHaveLength(1);
  });

  test.each(["cancelled", "archived"] as const)(
    "refuses to assign a %s milestone",
    async (status) => {
      const project = await createProject(harness, `${prefix}-project`);
      const milestone: MilestoneRecord = {
        id: `${prefix}-milestone`,
        projectId: project.id,
        title: "Abandoned",
        status: "planned",
        createdAt: date("2026-01-01T00:00:00.000Z"),
        updatedAt: date("2026-01-01T00:00:00.000Z"),
      };
      await harness.governance.saveMilestone(milestone);
      const orphan = requirement(project.id, `${prefix}-orphan`, "REQ-ORPHAN");
      await harness.governance.saveRequirement(orphan);
      const at = date("2026-01-02T00:00:00.000Z");
      const service = governanceService(harness, at, `${prefix}-event`);
      for (const next of status === "archived"
        ? (["active", "completed", "archived"] as const)
        : (["cancelled"] as const))
        await service.setStatus({
          projectId: project.id,
          kind: "milestone",
          id: milestone.id,
          status: next,
        });

      await expect(
        service.assignRequirementMilestone({
          projectId: project.id,
          requirementId: orphan.id,
          milestoneId: milestone.id,
        }),
      ).rejects.toBeInstanceOf(DomainValidationError);
      expect(
        (await harness.governance.getSnapshot(project.id)).requirements[0]
          ?.milestoneId,
      ).toBeUndefined();
    },
  );

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

function governanceService(
  harness: GovernanceRepositoryContractHarness,
  now: Date,
  idPrefix: string,
): ManageGovernance {
  let next = 0;
  return new ManageGovernance(
    harness.projects,
    harness.governance,
    { generate: () => `${idPrefix}-${++next}` },
    { now: () => now },
  );
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

import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTextFileAtomic } from "@ai-office/runtime-host/atomic-file.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import {
  DuplicateRequirementKeyError,
  GovernanceCrossProjectReferenceError,
  GovernanceSubjectNotFoundError,
  ReviewAlreadyFinalizedError,
} from "@ai-office/application/governance-errors.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { renderGovernanceMarkdown } from "@ai-office/application/queries/render-governance-markdown.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";

const roots: string[] = [];
const migrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);
const now = new Date("2026-08-05T00:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return now;
  }
}

class Ids implements IdGenerator {
  private next = 0;
  generate(): string {
    return `id-${++this.next}`;
  }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-governance-hardening-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, migrationDirectory);
  const projects = new SqliteProjectRepository(database);
  await projects.save(Project.create({ id: "project-1", name: "One", now }));
  await projects.save(Project.create({ id: "project-2", name: "Two", now }));
  const repository = new SqliteGovernanceRepository(database);
  return {
    root,
    database,
    repository,
    service: new ManageGovernance(
      projects,
      repository,
      new Ids(),
      new FixedClock(),
    ),
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("governance ownership and keys", () => {
  test("rejects missing and cross-project requirement milestones", async () => {
    const { database, service } = await setup();
    const otherMilestone = await service.createMilestone({
      projectId: "project-2",
      title: "Other",
    });
    await expect(
      service.createRequirement({
        projectId: "project-1",
        milestoneId: "missing",
        key: "REQ-1",
        title: "Missing",
        description: "Missing milestone",
      }),
    ).rejects.toBeInstanceOf(GovernanceSubjectNotFoundError);
    await expect(
      service.createRequirement({
        projectId: "project-1",
        milestoneId: otherMilestone,
        key: "REQ-2",
        title: "Cross",
        description: "Cross project",
      }),
    ).rejects.toBeInstanceOf(GovernanceCrossProjectReferenceError);
    expect(() =>
      database
        .prepare(
          `INSERT INTO requirement(
            id,project_id,milestone_id,requirement_key,title,description,
            status,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "direct-cross",
          "project-1",
          otherMilestone,
          "REQ-DIRECT",
          "Cross",
          "Cross",
          "proposed",
          now.toISOString(),
          now.toISOString(),
        ),
    ).toThrow("requirement milestone must belong to the same project");
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) count FROM requirement")
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("enforces case-sensitive requirement keys per project", async () => {
    const { database, service } = await setup();
    const input = {
      projectId: "project-1",
      key: "REQ-1",
      title: "One",
      description: "Description",
    };
    await service.createRequirement(input);
    await expect(service.createRequirement(input)).rejects.toBeInstanceOf(
      DuplicateRequirementKeyError,
    );
    await expect(
      service.createRequirement({ ...input, key: "req-1" }),
    ).resolves.toBeTypeOf("string");
    database.close();
  });
});

describe("review subjects and atomic decisions", () => {
  test("validates subject existence, type and project", async () => {
    const { database, service } = await setup();
    const requirement = await service.createRequirement({
      projectId: "project-1",
      key: "REQ-1",
      title: "One",
      description: "Description",
    });
    const otherRequirement = await service.createRequirement({
      projectId: "project-2",
      key: "REQ-2",
      title: "Two",
      description: "Description",
    });
    const reviewer = { type: "user" as const, id: "reviewer-1" };
    await expect(
      service.createReview({
        projectId: "project-1",
        subjectType: "requirement",
        subjectId: "missing",
        reviewer,
      }),
    ).rejects.toBeInstanceOf(GovernanceSubjectNotFoundError);
    await expect(
      service.createReview({
        projectId: "project-1",
        subjectType: "adr",
        subjectId: requirement,
        reviewer,
      }),
    ).rejects.toBeInstanceOf(GovernanceSubjectNotFoundError);
    await expect(
      service.createReview({
        projectId: "project-1",
        subjectType: "requirement",
        subjectId: otherRequirement,
        reviewer,
      }),
    ).rejects.toBeInstanceOf(GovernanceCrossProjectReferenceError);
    await expect(
      service.createReview({
        projectId: "project-1",
        subjectType: "requirement",
        subjectId: requirement,
        reviewer,
      }),
    ).resolves.toBeTypeOf("string");
    database.close();
  });

  test("allows one concurrent decision and keeps approval and status consistent", async () => {
    const { database, repository, service } = await setup();
    const requirement = await service.createRequirement({
      projectId: "project-1",
      key: "REQ-1",
      title: "One",
      description: "Description",
    });
    const review = await service.createReview({
      projectId: "project-1",
      subjectType: "requirement",
      subjectId: requirement,
      reviewer: {
        type: "agent",
        id: "review-agent",
        displayName: "Review Agent",
      },
    });
    const decisions = await Promise.allSettled([
      service.approve({
        projectId: "project-1",
        reviewId: review,
        actor: { type: "user", id: "owner" },
        decision: "approved",
      }),
      service.approve({
        projectId: "project-1",
        reviewId: review,
        actor: { type: "user", id: "owner-2" },
        decision: "rejected",
      }),
    ]);
    expect(
      decisions.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      decisions.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      decisions.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: expect.any(ReviewAlreadyFinalizedError) });
    const snapshot = await repository.getSnapshot("project-1");
    expect(snapshot.approvals).toHaveLength(1);
    expect(snapshot.reviews[0]?.status).toBe(snapshot.approvals[0]?.decision);
    expect(snapshot.reviews[0]?.reviewer).toEqual({
      type: "agent",
      id: "review-agent",
      displayName: "Review Agent",
    });
    expect(() =>
      database
        .prepare("UPDATE review SET status='pending' WHERE id=?")
        .run(review),
    ).toThrow("decided review cannot return to pending");
    expect(
      (await repository.listEvents("project-1")).map(
        (event) => event.eventType,
      ),
    ).toEqual(["requirement.created", "review.created", "review.decided"]);
    database.close();
  });
});

describe("governance lifecycles, audit, and projection", () => {
  test("persists allowed lifecycle transitions and one append-only event each", async () => {
    const { database, repository, service } = await setup();
    const milestone = await service.createMilestone({
      projectId: "project-1",
      title: "M1",
    });
    await service.setStatus({
      projectId: "project-1",
      kind: "milestone",
      id: milestone,
      status: "active",
    });
    await service.setStatus({
      projectId: "project-1",
      kind: "milestone",
      id: milestone,
      status: "completed",
    });
    const requirement = await service.createRequirement({
      projectId: "project-1",
      milestoneId: milestone,
      key: "REQ-1",
      title: "Requirement",
      description: "Description",
    });
    for (const status of ["accepted", "implemented", "verified"] as const)
      await service.setStatus({
        projectId: "project-1",
        kind: "requirement",
        id: requirement,
        status,
      });
    const adr = await service.createAdr({
      projectId: "project-1",
      title: "ADR",
      context: "Context",
      decision: "Decision",
      consequences: "Consequences",
    });
    await service.setStatus({
      projectId: "project-1",
      kind: "adr",
      id: adr,
      status: "accepted",
    });
    await service.setStatus({
      projectId: "project-1",
      kind: "adr",
      id: adr,
      status: "superseded",
    });
    await expect(
      service.setStatus({
        projectId: "project-1",
        kind: "adr",
        id: adr,
        status: "proposed",
      }),
    ).rejects.toThrow("Cannot transition adr");
    expect(
      (await repository.listEvents("project-1")).map(
        (event) => event.eventType,
      ),
    ).toEqual([
      "milestone.created",
      "milestone.status_changed",
      "milestone.status_changed",
      "requirement.created",
      "requirement.status_changed",
      "requirement.status_changed",
      "requirement.status_changed",
      "adr.created",
      "adr.status_changed",
      "adr.status_changed",
    ]);
    expect(() => database.exec("DELETE FROM governance_event")).toThrow(
      "governance_event is append-only",
    );
    database.close();
  });

  test("renders hostile Markdown deterministically and writes atomically", async () => {
    const { root, database, repository, service } = await setup();
    await service.createMilestone({
      projectId: "project-1",
      title: "Title\n# injected `code` | pipe",
      description: "line one\n## injected",
    });
    await service.createAdr({
      projectId: "project-1",
      title: "ADR `one`",
      context: "# heading\n```danger```",
      decision: "A | B",
      consequences: "long ".repeat(2_000),
    });
    const snapshot = await repository.getSnapshot("project-1");
    const first = renderGovernanceMarkdown("One", snapshot);
    const second = renderGovernanceMarkdown("One", snapshot);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(first).not.toContain("\n# injected");
    expect(first).toContain("> # heading");
    const path = join(root, ".ai-office", "generated", "governance.md");
    writeTextFileAtomic(path, first);
    writeTextFileAtomic(path, second);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    database.close();
  });
});

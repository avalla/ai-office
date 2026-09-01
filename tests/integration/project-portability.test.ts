import { afterEach, describe, expect, test } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { CreateTask } from "@ai-office/application/commands/create-task.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import type { CapabilityPolicyRepository } from "@ai-office/application/ports/capability-policy-repository.port.ts";
import {
  ManageProjectPortability,
  ProjectRestorePartialError,
} from "@ai-office/application/project-portability/manage-project-portability.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import {
  createPortableProjectArchive,
  parsePortableProjectArchive,
  serializePortableProjectArchive,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { SqliteProjectStateRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-state.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { LocalProjectBindingAdapter } from "../../apps/cli/src/local-project-binding-adapter.ts";
import { LocalProjectScanner } from "../../apps/cli/src/local-project-scanner.ts";

const roots: string[] = [];
const migrations = join(process.cwd(), "migrations", "project");

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function openRuntime(root: string) {
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, migrations);
  const projects = new SqliteProjectRepository(database);
  const profiles = new SqliteProjectProfileRepository(database);
  const identities = new SqliteRepositoryIdentityRepository(database);
  const states = new SqliteProjectStateRepository(database);
  const governance = new SqliteGovernanceRepository(database);
  const agentRuntime = new SqliteAgentRuntimeRepository(database);
  const transactions = new SqliteTransactionRunner(database);
  const ids = new CryptoIdGenerator();
  const clock = new SystemClock();
  const service = new ManageProjectPortability({
    projects,
    profiles,
    identities,
    states,
    bindings: new LocalProjectBindingAdapter(),
    scanner: new LocalProjectScanner(),
    transactions,
    ids,
    clock,
  });
  return {
    database,
    projects,
    profiles,
    identities,
    states,
    governance,
    agentRuntime,
    transactions,
    ids,
    clock,
    service,
  };
}

async function importProject(
  runtime: ReturnType<typeof openRuntime>,
  source: string,
) {
  return new ImportProject(
    runtime.projects,
    runtime.profiles,
    new LocalProjectScanner(),
    runtime.identities,
    runtime.ids,
    runtime.clock,
    runtime.transactions,
  ).execute({ rootPath: source });
}

async function createTask(
  runtime: ReturnType<typeof openRuntime>,
  projectId: string,
  title: string,
): Promise<string> {
  return new CreateTask(
    runtime.projects,
    new SqliteTaskRepository(runtime.database),
    runtime.ids,
    runtime.clock,
  ).execute({ projectId, title });
}

async function createAgent(
  runtime: ReturnType<typeof openRuntime>,
  projectId: string,
  suffix: string,
) {
  const now = runtime.clock.now();
  const roleId = `role-${suffix}`;
  const agentId = `agent-${suffix}`;
  await runtime.agentRuntime.saveRole(
    Role.create({
      id: roleId,
      projectId,
      key: `role-${suffix}`,
      name: `Role ${suffix}`,
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy: "default",
      limits: {
        maxIterations: 1,
        maxCostMicros: 0n,
        timeoutSeconds: 60,
      },
      sourcePath: `/machine-local/${suffix}.json`,
      now,
    }),
  );
  await runtime.agentRuntime.saveAgent({
    id: agentId,
    projectId,
    roleId,
    name: `Agent ${suffix}`,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  return { roleId, agentId };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("project portability", () => {
  test("backs up and restores one logical project at a different machine path", async () => {
    const machineA = temporaryRoot("ai-office-portable-a-");
    const machineB = temporaryRoot("ai-office-portable-b-");
    const sourceA = temporaryRoot("ai-office-source-a-");
    const sourceB = temporaryRoot("ai-office-source-b-");
    writeFileSync(join(sourceA, "package.json"), '{"name":"portable"}\n');
    writeFileSync(join(sourceB, "package.json"), '{"name":"portable"}\n');

    const a = openRuntime(machineA);
    const imported = await new ImportProject(
      a.projects,
      a.profiles,
      new LocalProjectScanner(),
      a.identities,
      a.ids,
      a.clock,
      a.transactions,
    ).execute({ rootPath: sourceA });
    await new CreateTask(
      a.projects,
      new SqliteTaskRepository(a.database),
      a.ids,
      a.clock,
    ).execute({
      projectId: imported.projectId,
      title: "Portable task",
      priority: 7,
    });

    const first = await a.service.backup(imported.projectId);
    const serialized = serializePortableProjectArchive(first.archive);
    expect(serialized).not.toContain(sourceA);
    expect(serialized).not.toContain("project.sqlite");
    expect(first.archive.state.tasks).toEqual([
      expect.objectContaining({ title: "Portable task", priority: 7 }),
    ]);
    const repeated = await a.service.backup(imported.projectId);
    expect(repeated.revisionId).toBe(first.revisionId);
    expect(serializePortableProjectArchive(repeated.archive)).toBe(serialized);
    a.database.close();

    const b = openRuntime(machineB);
    const restored = await b.service.restore({
      archive: parsePortableProjectArchive(serialized),
      rootPath: sourceB,
    });
    expect(restored.outcome).toBe("restored");
    expect(restored.projectId).not.toBe(imported.projectId);
    expect(restored.projectIdentity).toBe(first.projectIdentity);
    expect(
      JSON.parse(
        readFileSync(join(sourceB, ".ai-office", "project.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 2,
      managedBy: "ai-office",
      repositoryId: first.projectIdentity,
    });
    expect(await b.states.loadPortableState(restored.projectId)).toEqual(
      first.archive.state,
    );
    const duplicate = await b.service.restore({
      archive: first.archive,
      rootPath: sourceB,
    });
    expect(duplicate.outcome).toBe("unchanged");
    b.database.close();
  });

  test.each([
    "Imported from another system as part of a customer migration",
    "Imported from",
    "imported from",
    "Imported from /some/path",
  ])(
    "preserves semantic project description %j exactly",
    async (description) => {
      const sourceRuntime = temporaryRoot("ai-office-description-source-");
      const targetRuntime = temporaryRoot("ai-office-description-target-");
      const source = temporaryRoot("ai-office-description-checkout-a-");
      const target = temporaryRoot("ai-office-description-checkout-b-");
      writeFileSync(join(source, "package.json"), '{"name":"description"}\n');
      writeFileSync(join(target, "package.json"), '{"name":"description"}\n');

      const origin = openRuntime(sourceRuntime);
      const imported = await importProject(origin, source);
      origin.database
        .prepare("UPDATE project SET description = ? WHERE id = ?")
        .run(description, imported.projectId);
      const backup = await origin.service.backup(imported.projectId);
      expect(backup.archive.state.project.description).toBe(description);
      origin.database.close();

      const destination = openRuntime(targetRuntime);
      const restored = await destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      });
      expect(
        (await destination.projects.findById(restored.projectId))?.snapshot()
          .description,
      ).toBe(description);
      expect(
        await destination.states.loadPortableState(restored.projectId),
      ).toEqual(backup.archive.state);
      destination.database.close();
    },
  );

  test("creates parented revisions and rejects rollback over changed local state", async () => {
    const runtimeRoot = temporaryRoot("ai-office-portable-revision-");
    const source = temporaryRoot("ai-office-portable-source-");
    writeFileSync(join(source, "package.json"), '{"name":"portable"}\n');
    const runtime = openRuntime(runtimeRoot);
    const imported = await new ImportProject(
      runtime.projects,
      runtime.profiles,
      new LocalProjectScanner(),
      runtime.identities,
      runtime.ids,
      runtime.clock,
      runtime.transactions,
    ).execute({ rootPath: source });
    const first = await runtime.service.backup(imported.projectId);
    const independentHead = createPortableProjectArchive({
      state: first.archive.state,
      manifest: {
        ...first.archive.manifest,
        revision: {
          ...first.archive.manifest.revision,
          id: "rev_independent_same_state",
        },
      },
    });
    await expect(
      runtime.service.restore({ archive: independentHead, rootPath: source }),
    ).rejects.toThrow(`local head ${first.revisionId}`);
    await new CreateTask(
      runtime.projects,
      new SqliteTaskRepository(runtime.database),
      runtime.ids,
      runtime.clock,
    ).execute({ projectId: imported.projectId, title: "New local work" });
    const second = await runtime.service.backup(imported.projectId);
    expect(second.parentRevisionId).toBe(first.revisionId);
    await expect(
      runtime.service.restore({ archive: first.archive, rootPath: source }),
    ).rejects.toThrow("Restore conflict");
    runtime.database.close();
  });

  test("enforces globally unique revision IDs and project-local acyclic lineage", async () => {
    const runtimeRoot = temporaryRoot("ai-office-lineage-runtime-");
    const sourceA = temporaryRoot("ai-office-lineage-a-");
    const sourceB = temporaryRoot("ai-office-lineage-b-");
    writeFileSync(join(sourceA, "package.json"), '{"name":"lineage-a"}\n');
    writeFileSync(join(sourceB, "package.json"), '{"name":"lineage-b"}\n');
    const runtime = openRuntime(runtimeRoot);
    const projectA = await importProject(runtime, sourceA);
    const projectB = await importProject(runtime, sourceB);
    const revisionA = await runtime.service.backup(projectA.projectId);
    const revisionB = await runtime.service.backup(projectB.projectId);

    await expect(
      runtime.states.saveRevision({
        id: revisionA.revisionId,
        projectId: projectB.projectId,
        stateChecksum: revisionB.stateChecksum,
        origin: "local_snapshot",
        createdAt: new Date(revisionA.archive.manifest.createdAt),
      }),
    ).rejects.toThrow(
      `Project state revision ${revisionA.revisionId} conflicts`,
    );
    await expect(
      runtime.states.saveRevision({
        id: "rev_cross_project_parent",
        projectId: projectB.projectId,
        parentRevisionId: revisionA.revisionId,
        stateChecksum: revisionB.stateChecksum,
        origin: "local_snapshot",
        createdAt: runtime.clock.now(),
      }),
    ).rejects.toThrow("parent from another project");
    await expect(
      runtime.states.saveRevision(
        {
          id: "rev_cross_project_base",
          projectId: projectB.projectId,
          stateChecksum: revisionB.stateChecksum,
          origin: "local_snapshot",
          createdAt: runtime.clock.now(),
        },
        revisionA.revisionId,
      ),
    ).rejects.toThrow("base from another project");

    await runtime.states.saveRevision({
      id: "rev_cycle_a",
      projectId: projectA.projectId,
      parentRevisionId: "rev_cycle_b",
      stateChecksum: revisionA.stateChecksum,
      origin: "local_snapshot",
      createdAt: runtime.clock.now(),
    });
    await expect(
      runtime.states.saveRevision({
        id: "rev_cycle_b",
        projectId: projectA.projectId,
        parentRevisionId: "rev_cycle_a",
        stateChecksum: revisionA.stateChecksum,
        origin: "local_snapshot",
        createdAt: runtime.clock.now(),
      }),
    ).rejects.toThrow("cyclic lineage");
    runtime.database.close();
  });

  test("restores a shallow lineage anchor and keeps checkout attachment lineage-neutral", async () => {
    const originRuntime = temporaryRoot("ai-office-lineage-origin-");
    const destinationRuntime = temporaryRoot("ai-office-lineage-destination-");
    const source = temporaryRoot("ai-office-lineage-source-");
    const target = temporaryRoot("ai-office-lineage-target-");
    for (const root of [source, target]) {
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".git", "config"),
        '[remote "origin"]\n  url = https://example.test/team/lineage.git\n',
      );
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    const origin = openRuntime(originRuntime);
    const imported = await importProject(origin, source);
    const observed = await origin.service.backup(imported.projectId);
    const beforeAttachment = await origin.states.findHead(imported.projectId);
    const attached = await origin.service.restore({
      archive: observed.archive,
      rootPath: target,
    });
    expect(attached.outcome).toBe("attached");
    expect(await origin.states.findHead(imported.projectId)).toEqual(
      beforeAttachment,
    );
    const forgedTimestamp = createPortableProjectArchive({
      state: observed.archive.state,
      manifest: {
        ...observed.archive.manifest,
        createdAt: "2026-09-01T23:59:59.000Z",
      },
    });
    await expect(
      origin.service.restore({ archive: forgedTimestamp, rootPath: source }),
    ).rejects.toThrow("metadata does not match the local immutable revision");
    origin.database.close();

    const shallow = createPortableProjectArchive({
      state: observed.archive.state,
      manifest: {
        ...observed.archive.manifest,
        revision: {
          ...observed.archive.manifest.revision,
          id: "rev_shallow_head",
          parentRevisionId: "rev_parent_not_stored_here",
        },
      },
    });
    const freshTarget = temporaryRoot("ai-office-lineage-fresh-target-");
    mkdirSync(join(freshTarget, ".git"));
    writeFileSync(
      join(freshTarget, ".git", "config"),
      '[remote "origin"]\n  url = https://example.test/team/lineage.git\n',
    );
    writeFileSync(join(freshTarget, ".git", "HEAD"), "ref: refs/heads/main\n");
    const destination = openRuntime(destinationRuntime);
    const restored = await destination.service.restore({
      archive: shallow,
      rootPath: freshTarget,
    });
    expect(await destination.states.findHead(restored.projectId)).toMatchObject(
      {
        revision: {
          id: "rev_shallow_head",
          parentRevisionId: "rev_parent_not_stored_here",
          origin: "portable_import",
        },
        baseRevisionId: "rev_shallow_head",
      },
    );
    await expect(
      destination.service.restore({ archive: shallow, rootPath: freshTarget }),
    ).resolves.toMatchObject({ outcome: "unchanged" });
    destination.database.close();
  });

  test("round-trips pending, approved, and rejected governance reviews exactly", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-governance-a-");
    const targetRuntime = temporaryRoot("ai-office-portable-governance-b-");
    const source = temporaryRoot("ai-office-portable-governance-source-");
    const target = temporaryRoot("ai-office-portable-governance-target-");
    writeFileSync(join(source, "package.json"), '{"name":"governance"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"governance"}\n');

    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const taskId = await createTask(origin, imported.projectId, "Pending task");
    const governance = new ManageGovernance(
      origin.projects,
      origin.governance,
      origin.ids,
      origin.clock,
    );
    const milestoneId = await governance.createMilestone({
      projectId: imported.projectId,
      title: "Portable milestone",
    });
    const requirementId = await governance.createRequirement({
      projectId: imported.projectId,
      milestoneId,
      key: "PORT-1",
      title: "Portable governance",
      description: "Preserve review and approval semantics.",
    });
    await governance.createReview({
      projectId: imported.projectId,
      subjectType: "task",
      subjectId: taskId,
      reviewer: { type: "user", id: "pending-reviewer" },
    });
    const approvedReview = await governance.createReview({
      projectId: imported.projectId,
      subjectType: "requirement",
      subjectId: requirementId,
      reviewer: { type: "agent", id: "approval-reviewer" },
    });
    await governance.approve({
      projectId: imported.projectId,
      reviewId: approvedReview,
      actor: { type: "user", id: "owner" },
      decision: "approved",
      rationale: "Accepted",
    });
    const rejectedReview = await governance.createReview({
      projectId: imported.projectId,
      subjectType: "milestone",
      subjectId: milestoneId,
      reviewer: { type: "agent", id: "rejection-reviewer" },
    });
    await governance.approve({
      projectId: imported.projectId,
      reviewId: rejectedReview,
      actor: { type: "user", id: "owner" },
      decision: "rejected",
      rationale: "Needs revision",
    });
    const legacyCompletion = "2026-09-01T12:34:56.000Z";
    origin.database
      .prepare(
        "UPDATE review SET completed_at = ? WHERE id = ? AND project_id = ?",
      )
      .run(legacyCompletion, approvedReview, imported.projectId);

    const backup = await origin.service.backup(imported.projectId);
    expect(backup.archive.state.governance.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "pending" }),
        expect.objectContaining({
          id: approvedReview,
          status: "approved",
          completedAt: legacyCompletion,
        }),
        expect.objectContaining({ id: rejectedReview, status: "rejected" }),
      ]),
    );
    expect(backup.archive.state.governance.approvals).toHaveLength(2);
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(backup.archive.state);
    destination.database.close();
  });

  test("excludes active-run governance until its subject becomes portable", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-active-review-a-");
    const targetRuntime = temporaryRoot("ai-office-portable-active-review-b-");
    const source = temporaryRoot("ai-office-portable-active-review-source-");
    const target = temporaryRoot("ai-office-portable-active-review-target-");
    writeFileSync(join(source, "package.json"), '{"name":"active-review"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"active-review"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const taskId = await createTask(origin, imported.projectId, "Reviewed run");
    const { agentId } = await createAgent(origin, imported.projectId, "review");
    const run = AgentRun.create({
      id: "run-reviewed",
      projectId: imported.projectId,
      taskId,
      agentId,
      actionIntent: {
        resourceId: "resource-local",
        operation: "filesystem.read",
        arguments: { path: "README.md" },
      },
      now: origin.clock.now(),
    });
    await origin.agentRuntime.saveRun(run);
    const governance = new ManageGovernance(
      origin.projects,
      origin.governance,
      origin.ids,
      origin.clock,
    );
    const reviewId = await governance.createReview({
      projectId: imported.projectId,
      subjectType: "agent_run",
      subjectId: run.snapshot().id,
      reviewer: { type: "user", id: "reviewer" },
    });
    await governance.approve({
      projectId: imported.projectId,
      reviewId,
      actor: { type: "user", id: "owner" },
      decision: "approved",
    });

    const activeSubset = await origin.states.loadPortableState(
      imported.projectId,
    );
    expect(activeSubset.agents.terminalRuns).toEqual([]);
    expect(activeSubset.governance.reviews).toEqual([]);
    expect(activeSubset.governance.approvals).toEqual([]);
    await expect(origin.service.backup(imported.projectId)).rejects.toThrow(
      "Active agent run run-reviewed: queued",
    );
    expect(await origin.states.findHead(imported.projectId)).toBeNull();

    run.transition("cancelled", origin.clock.now(), {
      worktreePath: "/machine-a/private/worktree",
      error: { code: "cancelled-locally" },
    });
    await origin.agentRuntime.saveRun(run);
    const backup = await origin.service.backup(imported.projectId);
    expect(backup.archive.state.governance.reviews).toEqual([
      expect.objectContaining({ id: reviewId, subjectId: "run-reviewed" }),
    ]);
    expect(backup.archive.state.governance.approvals).toHaveLength(1);
    expect(backup.archive.state.agents.terminalRuns).toEqual([
      expect.objectContaining({ id: "run-reviewed", status: "cancelled" }),
    ]);
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(serialized).not.toContain("machine-a/private/worktree");
    expect(serialized).not.toContain("resource-local");
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(backup.archive.state);
    const restoredRun = await destination.agentRuntime.findRun("run-reviewed");
    const restoredSummary = restoredRun!.snapshot();
    expect(restoredSummary.status).toBe("cancelled");
    for (const field of [
      "pipelineRunId",
      "actionIntent",
      "worktreePath",
      "result",
      "error",
    ] as const)
      expect(field in restoredSummary).toBe(false);
    expect(() =>
      restoredRun?.transition("running", destination.clock.now()),
    ).toThrow("Cannot transition agent run from cancelled to running");
    const actionGateway = new RequestControlledAction(
      {} as unknown as EvaluateActionPolicy,
      {} as unknown as CapabilityPolicyRepository,
      {} as unknown as RecordAuditEvent,
      destination.ids,
      destination.clock,
      destination.transactions,
      destination.agentRuntime,
    );
    await expect(
      actionGateway.executeFromAgentRun("run-reviewed"),
    ).rejects.toThrow("Agent run is not executing an action intent");
    expect(
      await destination.agentRuntime.acquireTaskLock(
        restoredSummary.taskId,
        restoredSummary.id,
        destination.clock.now(),
        new Date(destination.clock.now().getTime() + 60_000),
      ),
    ).toBe(false);
    destination.database.close();
  });

  test("restores every terminal run status as non-executable summary state", async () => {
    const sourceRuntime = temporaryRoot("ai-office-terminal-source-");
    const targetRuntime = temporaryRoot("ai-office-terminal-target-");
    const source = temporaryRoot("ai-office-terminal-checkout-a-");
    const target = temporaryRoot("ai-office-terminal-checkout-b-");
    writeFileSync(join(source, "package.json"), '{"name":"terminal"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"terminal"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const taskId = await createTask(
      origin,
      imported.projectId,
      "Terminal runs",
    );
    const { agentId } = await createAgent(
      origin,
      imported.projectId,
      "terminal",
    );
    const statuses = ["completed", "failed", "cancelled"] as const;
    for (const status of statuses) {
      const run = AgentRun.create({
        id: `run-${status}`,
        projectId: imported.projectId,
        taskId,
        agentId,
        actionIntent: {
          resourceId: "machine-local-resource",
          operation: "filesystem.read",
          arguments: { path: "README.md" },
        },
        now: origin.clock.now(),
      });
      if (status === "completed") {
        run.transition("preparing", origin.clock.now());
        run.transition("running", origin.clock.now());
        run.transition("completed", origin.clock.now());
      } else if (status === "failed") {
        run.transition("preparing", origin.clock.now());
        run.transition("failed", origin.clock.now());
      } else run.transition("cancelled", origin.clock.now());
      await origin.agentRuntime.saveRun(run);
    }
    const backup = await origin.service.backup(imported.projectId);
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    const actionGateway = new RequestControlledAction(
      {} as unknown as EvaluateActionPolicy,
      {} as unknown as CapabilityPolicyRepository,
      {} as unknown as RecordAuditEvent,
      destination.ids,
      destination.clock,
      destination.transactions,
      destination.agentRuntime,
    );
    const pipelines = new ManagePipelineRuns(
      new SqliteOfficeManifestRepository(destination.database),
      new SqlitePipelineRunRepository(destination.database),
      new SqliteTaskRepository(destination.database),
      destination.agentRuntime,
      new RecordAuditEvent(
        new SqliteAuditEventRepository(destination.database),
        destination.ids,
        destination.clock,
      ),
      destination.ids,
      destination.clock,
      destination.transactions,
    );
    for (const status of statuses) {
      const runId = `run-${status}`;
      const summary = (await destination.agentRuntime.findRun(runId))!;
      expect(summary.snapshot()).toMatchObject({ status });
      expect(() =>
        summary.transition("running", destination.clock.now()),
      ).toThrow(`Cannot transition agent run from ${status} to running`);
      await expect(actionGateway.executeFromAgentRun(runId)).rejects.toThrow(
        "Agent run is not executing an action intent",
      );
      await expect(
        pipelines.completeStageFromAgentRun({
          projectId: restored.projectId,
          agentRunId: runId,
        }),
      ).rejects.toThrow("not authorized");
      expect(
        await destination.agentRuntime.acquireTaskLock(
          taskId,
          runId,
          destination.clock.now(),
          new Date(destination.clock.now().getTime() + 60_000),
        ),
      ).toBe(false);
    }
    destination.database.close();
  });

  test("requires execution quiescence without advancing the snapshot head", async () => {
    const runtimeRoot = temporaryRoot("ai-office-portable-quiescence-");
    const source = temporaryRoot("ai-office-portable-quiescence-source-");
    writeFileSync(join(source, "package.json"), '{"name":"quiescence"}\n');
    const runtime = openRuntime(runtimeRoot);
    const imported = await importProject(runtime, source);
    await createTask(runtime, imported.projectId, "Pending portable work");
    const completedTaskId = await createTask(
      runtime,
      imported.projectId,
      "Completed portable work",
    );
    const tasks = new SqliteTaskRepository(runtime.database);
    const completedTask = await tasks.findById(completedTaskId);
    completedTask!.start(runtime.clock.now());
    completedTask!.complete(runtime.clock.now());
    await tasks.save(completedTask!);
    const quiescent = await runtime.service.backup(imported.projectId);
    expect(
      quiescent.archive.state.tasks.map((item) => item.status).sort(),
    ).toEqual(["completed", "pending"]);

    const runningTaskId = await createTask(
      runtime,
      imported.projectId,
      "Operational work",
    );
    const runningTask = await tasks.findById(runningTaskId);
    const now = runtime.clock.now();
    runningTask!.start(now);
    await tasks.save(runningTask!);
    const manifest = {
      schemaVersion: 1 as const,
      provenance: {
        host: "codex",
        skill: "ai-office" as const,
        skillVersion: "1",
      },
      project: {
        mission: "Test portable execution quiescence.",
        goals: ["Preserve coherent snapshots."],
        constraints: [],
        preferences: [],
        permissionPreferences: [],
      },
      office: {
        name: "Test office",
        roles: [
          {
            id: "worker",
            title: "Worker",
            purpose: "Execute work.",
            responsibilities: ["Deliver the task."],
          },
        ],
      },
      pipelines: [
        {
          id: "delivery",
          name: "Delivery",
          description: "One enforced stage.",
          defaultFor: ["feature" as const],
          enforcement: "enforced" as const,
          stages: [
            {
              id: "work",
              name: "Work",
              roleId: "worker",
              objective: "Complete the task.",
              checks: [],
              requiresApproval: false,
              capabilities: [],
            },
          ],
        },
      ],
    };
    runtime.database
      .prepare(
        `INSERT INTO office_manifest_revision(
           id, project_id, revision, schema_version, manifest_json,
           source_host, source_skill, source_skill_version, applied_at
         ) VALUES (?, ?, 1, 1, ?, 'codex', 'ai-office', '1', ?)`,
      )
      .run(
        "manifest-quiescence",
        imported.projectId,
        JSON.stringify(manifest),
        now.toISOString(),
      );
    const pipeline = PipelineRun.create({
      id: "pipeline-active",
      projectId: imported.projectId,
      taskId: runningTaskId,
      manifestRevisionId: "manifest-quiescence",
      manifestRevision: 1,
      definition: manifest.pipelines[0]!,
      startedBy: "operator",
      stageRunIds: ["pipeline-stage-active"],
      now,
    });
    await new SqlitePipelineRunRepository(runtime.database).insert(pipeline);
    const { agentId } = await createAgent(
      runtime,
      imported.projectId,
      "quiescence",
    );
    const run = AgentRun.create({
      id: "run-active",
      projectId: imported.projectId,
      taskId: runningTaskId,
      agentId,
      now,
    });
    await runtime.agentRuntime.saveRun(run);
    await runtime.agentRuntime.acquireTaskLock(
      runningTaskId,
      run.snapshot().id,
      now,
      new Date(now.getTime() + 60_000),
    );

    let failure: unknown;
    try {
      await runtime.service.backup(imported.projectId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const failureMessage = failure instanceof Error ? failure.message : "";
    expect(failureMessage).not.toContain(`Task ${runningTaskId}: running`);
    expect(failureMessage).toContain(
      `Active pipeline pipeline-active (task ${runningTaskId})`,
    );
    expect(failureMessage).toContain(
      `Active agent run run-active: queued (task ${runningTaskId})`,
    );
    expect(failureMessage).toContain(
      `Active task lock for task ${runningTaskId} (run run-active`,
    );
    expect(
      (await runtime.states.findHead(imported.projectId))?.revision.id,
    ).toBe(quiescent.revisionId);
    expect(
      runtime.database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM project_state_revision WHERE project_id = ?",
        )
        .get(imported.projectId)?.count,
    ).toBe(1);
    runtime.database.close();
  });

  test("preserves task lifecycle state when no live execution authority exists", async () => {
    const sourceRuntime = temporaryRoot("ai-office-task-state-source-");
    const targetRuntime = temporaryRoot("ai-office-task-state-target-");
    const source = temporaryRoot("ai-office-task-state-checkout-a-");
    const target = temporaryRoot("ai-office-task-state-checkout-b-");
    writeFileSync(join(source, "package.json"), '{"name":"task-state"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"task-state"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const expected = [
      "assigned",
      "running",
      "blocked",
      "waiting_review",
    ] as const;
    for (const status of expected) {
      const taskId = await createTask(
        origin,
        imported.projectId,
        `Semantic ${status}`,
      );
      origin.database
        .prepare("UPDATE task SET status = ? WHERE id = ?")
        .run(status, taskId);
    }

    expect(
      await origin.states.findPortabilityBlockers(
        imported.projectId,
        origin.clock.now(),
      ),
    ).toEqual([]);
    const backup = await origin.service.backup(imported.projectId);
    expect(
      backup.archive.state.tasks.map((task) => task.status).sort(),
    ).toEqual([...expected].sort());
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const restored = await destination.service.restore({
      archive: backup.archive,
      rootPath: target,
    });
    expect(
      await destination.states.loadPortableState(restored.projectId),
    ).toEqual(backup.archive.state);
    destination.database.close();
  });

  test("rejects a repository/archive identity mismatch before state mutation", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-source-runtime-");
    const source = temporaryRoot("ai-office-portable-origin-");
    const targetRuntime = temporaryRoot("ai-office-portable-target-runtime-");
    const target = temporaryRoot("ai-office-portable-target-");
    writeFileSync(join(source, "package.json"), '{"name":"origin"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"target"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await new ImportProject(
      origin.projects,
      origin.profiles,
      new LocalProjectScanner(),
      origin.identities,
      origin.ids,
      origin.clock,
      origin.transactions,
    ).execute({ rootPath: source });
    const backup = await origin.service.backup(imported.projectId);
    origin.database.close();

    const bindings = new LocalProjectBindingAdapter();
    await bindings.applyWrite(
      await bindings.planWrite(target, {
        schemaVersion: 2,
        managedBy: "ai-office",
        repositoryId: "repo_unrelated",
      }),
    );
    const destination = openRuntime(targetRuntime);
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).rejects.toThrow("does not match archive project");
    expect(
      destination.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
        .get()?.count,
    ).toBe(0);
    destination.database.close();
  });

  test("rejects restore into a checkout with different Git provenance", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-git-source-");
    const source = temporaryRoot("ai-office-portable-git-origin-");
    const targetRuntime = temporaryRoot("ai-office-portable-git-target-");
    const target = temporaryRoot("ai-office-portable-git-checkout-");
    for (const [root, remote] of [
      [source, "https://portable:must-not-export@example.test/team/source.git"],
      [target, "https://example.test/team/unrelated.git"],
    ] as const) {
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".git", "config"),
        `[remote "origin"]\n  url = ${remote}\n`,
      );
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    const origin = openRuntime(sourceRuntime);
    const imported = await new ImportProject(
      origin.projects,
      origin.profiles,
      new LocalProjectScanner(),
      origin.identities,
      origin.ids,
      origin.clock,
      origin.transactions,
    ).execute({ rootPath: source });
    const backup = await origin.service.backup(imported.projectId);
    expect(serializePortableProjectArchive(backup.archive)).not.toContain(
      "must-not-export",
    );
    expect(backup.archive.manifest.source).toMatchObject({
      type: "git",
      remote: "https://example.test/team/source.git",
      branch: "main",
    });
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).rejects.toThrow("Git remote does not match");
    expect(
      destination.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
        .get()?.count,
    ).toBe(0);
    const bindings = new LocalProjectBindingAdapter();
    await bindings.applyWrite(
      await bindings.planWrite(target, {
        schemaVersion: 2,
        managedBy: "ai-office",
        repositoryId: backup.projectIdentity,
      }),
    );
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).resolves.toMatchObject({
      outcome: "restored",
      projectIdentity: backup.projectIdentity,
    });
    destination.database.close();
  });

  test("omits a local filesystem Git remote from the archive", async () => {
    const runtimeRoot = temporaryRoot("ai-office-portable-local-remote-");
    const source = temporaryRoot("ai-office-portable-local-repository-");
    mkdirSync(join(source, ".git"));
    const localRemote = "/Users/alice/dev/private/upstream.git";
    writeFileSync(
      join(source, ".git", "config"),
      `[remote "origin"]\n  url = ${localRemote}\n`,
    );
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
    const runtime = openRuntime(runtimeRoot);
    const imported = await importProject(runtime, source);
    const backup = await runtime.service.backup(imported.projectId);
    const serialized = serializePortableProjectArchive(backup.archive);
    expect(serialized).not.toContain(localRemote);
    expect(backup.archive.manifest.source).toBeUndefined();
    runtime.database.close();
  });

  test("selects source provenance deterministically across multiple checkouts", async () => {
    const runtimeRoot = temporaryRoot("ai-office-portable-sources-");
    const source = temporaryRoot("ai-office-portable-source-primary-");
    writeFileSync(join(source, "package.json"), '{"name":"sources"}\n');
    const runtime = openRuntime(runtimeRoot);
    const imported = await importProject(runtime, source);
    const now = runtime.clock.now();
    await runtime.profiles.saveSource({
      id: "source-network-two",
      projectId: imported.projectId,
      sourceType: "local",
      localPath: "/stale/checkout/two",
      remoteUrl: "https://alice:secret@example.test/team/project.git",
      defaultBranch: "main",
      createdAt: new Date(now.getTime() - 2_000),
    });
    await runtime.profiles.saveSource({
      id: "source-network-one",
      projectId: imported.projectId,
      sourceType: "local",
      localPath: "/stale/checkout/one",
      remoteUrl: "https://example.test/team/project.git",
      defaultBranch: "main",
      createdAt: new Date(now.getTime() - 3_000),
    });

    const agreed = await runtime.service.backup(imported.projectId);
    expect(agreed.archive.manifest.source).toEqual({
      type: "git",
      remote: "https://example.test/team/project.git",
      branch: "main",
    });
    expect(serializePortableProjectArchive(agreed.archive)).not.toContain(
      "secret",
    );

    await runtime.profiles.saveSource({
      id: "source-conflict",
      projectId: imported.projectId,
      sourceType: "local",
      localPath: "/stale/checkout/conflict",
      remoteUrl: "https://example.test/another/project.git",
      defaultBranch: "main",
      createdAt: new Date(now.getTime() - 4_000),
    });
    const ambiguous = await runtime.service.backup(imported.projectId);
    expect(ambiguous.revisionId).toBe(agreed.revisionId);
    expect(ambiguous.archive.manifest.source).toBeUndefined();
    runtime.database.close();
  });

  test("rolls back authoritative state when a restored entity conflicts", async () => {
    const sourceRuntime = temporaryRoot("ai-office-portable-atomic-source-");
    const source = temporaryRoot("ai-office-portable-atomic-origin-");
    const targetRuntime = temporaryRoot("ai-office-portable-atomic-target-");
    const target = temporaryRoot("ai-office-portable-atomic-checkout-");
    writeFileSync(join(source, "package.json"), '{"name":"origin"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"target"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await new ImportProject(
      origin.projects,
      origin.profiles,
      new LocalProjectScanner(),
      origin.identities,
      origin.ids,
      origin.clock,
      origin.transactions,
    ).execute({ rootPath: source });
    await new CreateTask(
      origin.projects,
      new SqliteTaskRepository(origin.database),
      origin.ids,
      origin.clock,
    ).execute({ projectId: imported.projectId, title: "Colliding task" });
    const backup = await origin.service.backup(imported.projectId);
    const taskId = backup.archive.state.tasks[0]!.id;
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const now = "2026-09-01T00:00:00.000Z";
    destination.database
      .prepare(
        `INSERT INTO project(id, name, created_at, updated_at)
         VALUES ('unrelated', 'Unrelated', ?, ?)`,
      )
      .run(now, now);
    destination.database
      .prepare(
        `INSERT INTO task(
           id, project_id, title, status, priority, created_at, updated_at
         ) VALUES (?, 'unrelated', 'Existing', 'pending', 0, ?, ?)`,
      )
      .run(taskId, now, now);
    await expect(
      destination.service.restore({
        archive: backup.archive,
        rootPath: target,
      }),
    ).rejects.toThrow();
    expect(
      destination.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
        .get()?.count,
    ).toBe(1);
    expect(
      await destination.identities.findProjectId(backup.projectIdentity),
    ).toBeNull();
    expect(
      await new LocalProjectBindingAdapter().inspect(target),
    ).toMatchObject({ status: "missing" });
    destination.database.close();
  });

  test("recovers idempotently when binding publication fails after restore commit", async () => {
    const sourceRuntime = temporaryRoot("ai-office-partial-source-");
    const targetRuntime = temporaryRoot("ai-office-partial-target-");
    const source = temporaryRoot("ai-office-partial-checkout-a-");
    const target = temporaryRoot("ai-office-partial-checkout-b-");
    writeFileSync(join(source, "package.json"), '{"name":"partial"}\n');
    writeFileSync(join(target, "package.json"), '{"name":"partial"}\n');
    const origin = openRuntime(sourceRuntime);
    const imported = await importProject(origin, source);
    const backup = await origin.service.backup(imported.projectId);
    origin.database.close();

    const destination = openRuntime(targetRuntime);
    const local = new LocalProjectBindingAdapter();
    let fail = true;
    const bindings: ProjectBindingAdapter = {
      resolveProjectRoot: (path) => local.resolveProjectRoot(path),
      inspect: (path, options) => local.inspect(path, options),
      planWrite: (path, binding) => local.planWrite(path, binding),
      applyWrite: async (plan) => {
        if (fail) {
          fail = false;
          throw new Error("injected binding publication failure");
        }
        await local.applyWrite(plan);
      },
      planRemove: (path) => local.planRemove(path),
      applyRemove: (plan) => local.applyRemove(plan),
    };
    const service = new ManageProjectPortability({
      projects: destination.projects,
      profiles: destination.profiles,
      identities: destination.identities,
      states: destination.states,
      bindings,
      scanner: new LocalProjectScanner(),
      transactions: destination.transactions,
      ids: destination.ids,
      clock: destination.clock,
    });

    let partial: unknown;
    try {
      await service.restore({ archive: backup.archive, rootPath: target });
    } catch (error) {
      partial = error;
    }
    expect(partial).toBeInstanceOf(ProjectRestorePartialError);
    const mappedProject = await destination.identities.findProjectId(
      backup.projectIdentity,
    );
    expect(mappedProject).not.toBeNull();
    expect(
      (await destination.states.findHead(mappedProject!))?.revision.id,
    ).toBe(backup.revisionId);
    expect(await local.inspect(target)).toMatchObject({ status: "missing" });

    await expect(
      service.restore({ archive: backup.archive, rootPath: target }),
    ).resolves.toMatchObject({
      outcome: "unchanged",
      projectId: mappedProject,
      revisionId: backup.revisionId,
    });
    expect(await local.inspect(target)).toMatchObject({ status: "valid" });
    destination.database.close();
  });
});

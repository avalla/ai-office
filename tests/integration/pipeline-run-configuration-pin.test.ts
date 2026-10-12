import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const now = new Date("2026-10-11T00:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return new Date(now);
  }
}

class SequenceIds implements IdGenerator {
  private next = 0;
  generate(): string {
    this.next += 1;
    return `generated-${this.next}`;
  }
}

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Pin test",
    goals: ["Ship"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Pin office",
    roles: [
      {
        id: "developer",
        title: "Developer",
        purpose: "Build",
        responsibilities: ["Build"],
      },
    ],
  },
  pipelines: [
    {
      id: "delivery",
      name: "Delivery",
      description: "Pin test delivery",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "build",
          name: "Build",
          roleId: "developer",
          objective: "Build",
          checks: [],
          requiresApproval: false,
          capabilities: [],
        },
      ],
    },
  ],
};

const roots: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-pipeline-pin-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  databases.push(database);
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const clock = new FixedClock();
  const ids = new SequenceIds();
  const audit = new RecordAuditEvent(storage.auditEvents, ids, clock);
  const catalog = new InMemoryInstalledDomainPackCatalog(1, ["pin-fixture"]);
  const configuration = new ReadProjectConfiguration({
    projects: storage.projects,
    bindings: storage.packBindings,
    definitions: storage.definitions,
    transactions: storage.transactions,
    catalog,
  });
  const binding = new ManageProjectPackBinding({
    projects: storage.projects,
    definitions: storage.definitions,
    bindings: storage.packBindings,
    catalog,
    auditEvents: storage.auditEvents,
    transactions: storage.transactions,
    clock,
    ids,
  });
  const manager = new ManagePipelineRuns(
    storage.officeManifests,
    storage.pipelines,
    storage.tasks,
    storage.runtime,
    audit,
    ids,
    clock,
    storage.transactions,
    storage.jobOutbox,
    storage.taskDependencies,
    configuration,
  );
  return { database, storage, catalog, configuration, binding, manager };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/**
 * Counts how many separate transactions open on the wrapped runner and lets
 * a test fire a side effect the instant one of them commits -- a
 * deterministic stand-in for "a concurrent writer commits in the gap
 * between two transactions", with no sleep or wall-clock timing involved.
 */
class ObservedTransactionRunner implements TransactionRunner {
  openCount = 0;
  constructor(
    private readonly inner: TransactionRunner,
    private readonly onCommit: (openIndex: number) => Promise<void>,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.openCount += 1;
    const openIndex = this.openCount;
    const result = await this.inner.run(work);
    await this.onCommit(openIndex);
    return result;
  }
}

async function seedProject(
  h: Harness,
  projectId: string,
  taskId: string,
): Promise<void> {
  await h.storage.projects.save(
    Project.create({ id: projectId, name: projectId, now }),
  );
  await h.storage.tasks.save(
    Task.create({ id: taskId, projectId, title: "Feature", now }),
  );
  await h.storage.officeManifests.save({
    id: `${projectId}-manifest`,
    projectId,
    revision: 1,
    manifest,
    appliedAt: now,
  });
}

describe("pipeline run configuration pin (M16.5 Runtime activation, first slice)", () => {
  test("pins the pack configuration digest and tuples when the project has a nonempty pack selection", async () => {
    const h = await harness();
    const projectId = "pin-project";
    const taskId = "pin-task";
    await seedProject(h, projectId, taskId);

    const bytes = readFileSync(
      new URL(
        "../../packages/domain-pack-legal/manifest.json",
        import.meta.url,
      ),
    );
    const pack = h.catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "pin-fixture", reference: "legal" },
    });
    const preview = await h.binding.preview(projectId, [pack]);
    expect(preview.issues).toEqual([]);
    await h.binding.apply({
      projectId,
      desired: [pack],
      expectedRevision: preview.current.configurationRevision,
      actorId: "operator",
    });

    const expected = await h.configuration.read(projectId);
    expect(expected.selectedPacks).toEqual([pack]);

    const run = await h.manager.start({
      projectId,
      taskId,
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    expect(run.snapshot().configurationPin).toEqual(expected.pin);

    const restored = await h.storage.pipelines.findById(
      run.snapshot().id,
      projectId,
    );
    expect(restored?.snapshot().configurationPin).toEqual(expected.pin);

    // Pinning identity never changes pipeline/stage/role selection: the
    // run still comes from the legacy manifest, unchanged.
    expect(run.snapshot()).toMatchObject({
      manifestRevisionId: `${projectId}-manifest`,
      manifestRevision: 1,
      stages: [{ stageId: "build", roleId: "developer", status: "active" }],
    });
  });

  test("pinning is provider-independent: a restored binding whose required operation has no provider still starts and pins (GP-16 run gate stays deferred)", async () => {
    const h = await harness();
    const projectId = "no-provider-project";
    const taskId = "no-provider-task";
    await seedProject(h, projectId, taskId);
    const encoder = new TextEncoder();
    const draft = {
      schemaVersion: 1,
      id: "org.example.needs-provider",
      version: "1.0.0",
      manifestDigest: `sha256:${"0".repeat(64)}`,
      coreContract: { minInclusive: 1, maxExclusive: 3 },
      metadata: { name: "needs-provider", description: "Pin fixture" },
      dependencies: [],
      contributions: {
        ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
        roles: [{ id: "operator", capabilities: ["merge"] }],
        capabilities: [
          {
            id: "merge",
            operations: [{ operation: "x.merge", mode: "mutation" }],
          },
        ],
      },
    };
    const bytes = encoder.encode(
      JSON.stringify({
        ...draft,
        manifestDigest: computeManifestDigest(
          parseDomainPackManifest(encoder.encode(JSON.stringify(draft))),
        ),
      }),
    );
    const pack = h.catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "pin-fixture", reference: "needs-provider" },
    });
    // State that never passed a provider preflight, as after a restore.
    await h.storage.packBindings.replace(projectId, 0, [pack], now);
    await expect(h.configuration.read(projectId)).rejects.toMatchObject({
      code: "missing_required_capability_provider",
    });

    const run = await h.manager.start({
      projectId,
      taskId,
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    expect(run.snapshot().configurationPin).toMatchObject({
      selectedPacks: [pack],
      bindingRevision: 1,
    });
  });

  test("pinned pack tuples are append-only, yet deleting the run still cascades them (P2, PR #168)", async () => {
    const h = await harness();
    const projectId = "cascade-project";
    const taskId = "cascade-task";
    await seedProject(h, projectId, taskId);
    const bytes = readFileSync(
      new URL(
        "../../packages/domain-pack-legal/manifest.json",
        import.meta.url,
      ),
    );
    const pack = h.catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "pin-fixture", reference: "legal" },
    });
    await h.storage.packBindings.replace(projectId, 0, [pack], now);
    await h.manager.start({
      projectId,
      taskId,
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    const tuples = () =>
      h.database
        .query("SELECT count(*) AS n FROM pipeline_run_configuration_pack")
        .get() as { n: number };
    expect(tuples().n).toBeGreaterThan(0);

    // Direct tuple deletion stays refused while the run exists.
    expect(() =>
      h.database.exec("DELETE FROM pipeline_run_configuration_pack"),
    ).toThrow(/append-only/);

    // Deleting the run cascades to its tuples.
    h.database.exec("PRAGMA foreign_keys = ON");
    // The stage job the start enqueued references the stage run.
    h.database.exec("DELETE FROM job_outbox");
    h.database.exec(
      `DELETE FROM pipeline_run WHERE project_id = '${projectId}'`,
    );
    expect(tuples().n).toBe(0);
  });

  test("pins nothing when the project has no pack selection, exactly like before this change", async () => {
    const h = await harness();
    const projectId = "no-pin-project";
    const taskId = "no-pin-task";
    await seedProject(h, projectId, taskId);

    const expected = await h.configuration.read(projectId);
    expect(expected.selectedPacks).toEqual([]);

    const run = await h.manager.start({
      projectId,
      taskId,
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    expect(run.snapshot().configurationPin).toBeUndefined();

    const restored = await h.storage.pipelines.findById(
      run.snapshot().id,
      projectId,
    );
    expect(restored?.snapshot().configurationPin).toBeUndefined();
  });

  test("pins nothing when no configuration reader is wired, exactly like before this change", async () => {
    const h = await harness();
    const projectId = "unwired-project";
    const taskId = "unwired-task";
    await seedProject(h, projectId, taskId);
    const ids = new SequenceIds();
    const clock = new FixedClock();
    const audit = new RecordAuditEvent(h.storage.auditEvents, ids, clock);
    const unwired = new ManagePipelineRuns(
      h.storage.officeManifests,
      h.storage.pipelines,
      h.storage.tasks,
      h.storage.runtime,
      audit,
      ids,
      clock,
      h.storage.transactions,
    );
    const run = await unwired.start({
      projectId,
      taskId,
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    expect(run.snapshot().configurationPin).toBeUndefined();
  });

  test("resolves the configuration pin inside the same transaction as the run insert, so a concurrent rebind cannot leave a stale pin (P1, PR #168)", async () => {
    const h = await harness();
    const projectId = "pin-race-project";
    const taskId = "pin-race-task";
    await seedProject(h, projectId, taskId);

    const bytes = readFileSync(
      new URL(
        "../../packages/domain-pack-legal/manifest.json",
        import.meta.url,
      ),
    );
    const pack = h.catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "pin-fixture", reference: "legal" },
    });
    const preview = await h.binding.preview(projectId, [pack]);
    await h.binding.apply({
      projectId,
      desired: [pack],
      expectedRevision: preview.current.configurationRevision,
      actorId: "operator",
    });
    const beforeConcurrentRebind = await h.configuration.read(projectId);
    expect(beforeConcurrentRebind.selectedPacks).toEqual([pack]);

    // A wrapped TransactionRunner shared by the configuration reader and
    // the pipeline-run manager: it counts how many separate transactions
    // open for one `start()` call, and fires a concurrent rebind -- unbind
    // the pack entirely -- the instant the FIRST one commits. With the
    // pre-fix code, that first transaction is `ReadProjectConfiguration`'s
    // own (separate) transaction, so the rebind lands in the real gap
    // before the run-insert transaction opens, and the insert would still
    // persist the pin resolved from the now-superseded read. With the fix,
    // the read and the insert share one transaction, so this hook only
    // fires after the run (with a pin consistent with its own transaction)
    // has already been committed.
    let rebindApplied = false;
    const observed = new ObservedTransactionRunner(
      h.storage.transactions,
      async (openIndex) => {
        if (openIndex !== 1 || rebindApplied) return;
        rebindApplied = true;
        const current = await h.configuration.read(projectId);
        await h.binding.apply({
          projectId,
          desired: [],
          expectedRevision: current.pin.bindingRevision,
          actorId: "concurrent-writer",
        });
      },
    );
    const racingConfiguration = new ReadProjectConfiguration({
      projects: h.storage.projects,
      bindings: h.storage.packBindings,
      definitions: h.storage.definitions,
      transactions: observed,
      catalog: h.catalog,
    });
    const ids = new SequenceIds();
    const clock = new FixedClock();
    const audit = new RecordAuditEvent(h.storage.auditEvents, ids, clock);
    const racingManager = new ManagePipelineRuns(
      h.storage.officeManifests,
      h.storage.pipelines,
      h.storage.tasks,
      h.storage.runtime,
      audit,
      ids,
      clock,
      observed,
      h.storage.jobOutbox,
      h.storage.taskDependencies,
      racingConfiguration,
    );

    const run = await racingManager.start({
      projectId,
      taskId,
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });

    // Exactly one transaction must cover both the configuration read and
    // the run insert -- this is the structural fix itself.
    expect(observed.openCount).toBe(1);
    expect(rebindApplied).toBe(true);

    // The persisted pin must be the one authoritative throughout that one
    // transaction (the pre-rebind selection), never a value torn between a
    // stale pre-transaction read and a later, superseded insert.
    expect(run.snapshot().configurationPin).toEqual(beforeConcurrentRebind.pin);
    const afterConcurrentRebind = await h.configuration.read(projectId);
    expect(afterConcurrentRebind.selectedPacks).toEqual([]);
    expect(afterConcurrentRebind.pin).not.toEqual(beforeConcurrentRebind.pin);

    const restored = await h.storage.pipelines.findById(
      run.snapshot().id,
      projectId,
    );
    expect(restored?.snapshot().configurationPin).toEqual(
      beforeConcurrentRebind.pin,
    );
  });
});

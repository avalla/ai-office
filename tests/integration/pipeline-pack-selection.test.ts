import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import type {
  OfficeManifest,
  OfficePipeline,
} from "@ai-office/domain/office/office-manifest.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { OfficePipelineNotFoundError } from "@ai-office/application/errors.ts";
import {
  PipelineDefinitionAmbiguousError,
  PipelineRoleUnavailableError,
} from "@ai-office/application/pipeline-errors.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { PipelineDefinitionNotEnforcedError } from "@ai-office/application/pipeline-errors.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const now = new Date("2026-10-15T00:00:00.000Z");

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

const legalRoles = [
  "intake-clerk",
  "researcher",
  "drafter",
  "reviewer",
  "approver",
];

function manifestWith(pipelines: readonly OfficePipeline[]): OfficeManifest {
  return {
    schemaVersion: 1,
    provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
    project: {
      mission: "Selection test",
      goals: ["Ship"],
      constraints: [],
      preferences: [],
      permissionPreferences: [],
    },
    office: {
      name: "Selection office",
      roles: [
        {
          id: "developer",
          title: "Developer",
          purpose: "Build",
          responsibilities: ["Build"],
        },
      ],
    },
    pipelines,
  };
}

const delivery: OfficePipeline = {
  id: "delivery",
  name: "Delivery",
  description: "Manifest delivery",
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
};

const manifestMatter: OfficePipeline = {
  ...delivery,
  id: "matter-workflow",
  name: "Manifest matter",
  defaultFor: ["maintenance"],
};

const roots: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-pack-selection-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  databases.push(database);
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const clock = new FixedClock();
  const ids = new SequenceIds();
  const audit = new RecordAuditEvent(storage.auditEvents, ids, clock);
  const catalog = new InMemoryInstalledDomainPackCatalog(1, ["selection"]);
  const configuration = new ReadProjectConfiguration({
    projects: storage.projects,
    bindings: storage.packBindings,
    definitions: storage.definitions,
    transactions: storage.transactions,
    catalog,
  });
  let opened = 0;
  const transactions: TransactionRunner = {
    run: (work) => {
      opened += 1;
      return storage.transactions.run(work);
    },
  };
  const manager = new ManagePipelineRuns(
    storage.officeManifests,
    storage.pipelines,
    storage.tasks,
    storage.runtime,
    audit,
    ids,
    clock,
    transactions,
    storage.jobOutbox,
    storage.taskDependencies,
    configuration,
  );
  return {
    database,
    storage,
    catalog,
    configuration,
    manager,
    transactionsOpened: () => opened,
  };
}

type Harness = ReturnType<typeof harness>;

async function seed(
  h: Harness,
  input: {
    pipelines: readonly OfficePipeline[];
    roles: readonly string[];
    selectLegal: boolean;
  },
): Promise<{ projectId: string; taskId: string }> {
  const projectId = "selection-project";
  const taskId = "selection-task";
  await h.storage.projects.save(
    Project.create({ id: projectId, name: projectId, now }),
  );
  await h.storage.tasks.save(
    Task.create({ id: taskId, projectId, title: "Matter", now }),
  );
  await h.storage.officeManifests.save({
    id: `${projectId}-manifest`,
    projectId,
    revision: 1,
    manifest: manifestWith(input.pipelines),
    appliedAt: now,
  });
  for (const key of input.roles)
    await h.storage.runtime.saveRole(
      Role.create({
        id: `role-${key}`,
        projectId,
        key,
        name: key,
        version: 1,
        capabilities: [],
        tools: [],
        modelPolicy: "default",
        limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
        sourcePath: `${key}.yaml`,
        now,
      }),
    );
  if (input.selectLegal) {
    const bytes = readFileSync(
      new URL(
        "../../packages/domain-pack-legal/manifest.json",
        import.meta.url,
      ),
    );
    const pack = h.catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "selection", reference: "legal" },
    });
    await h.storage.packBindings.replace(projectId, 0, [pack], now);
  }
  return { projectId, taskId };
}

function auditPayloads(h: Harness): string {
  return JSON.stringify(h.database.query("SELECT * FROM audit_event").all());
}

describe("pack workflow selection (M16.5 Runtime activation)", () => {
  test("a project with a selected pack starts a run from the resolved pack workflow, governed by its policy", async () => {
    const h = harness();
    const { projectId, taskId } = await seed(h, {
      pipelines: [delivery],
      roles: legalRoles,
      selectLegal: true,
    });
    const expected = await h.configuration.read(projectId);

    const run = await h.manager.start({
      projectId,
      taskId,
      pipelineId: "matter-workflow",
      principal: localOperatorPrincipal,
    });

    const snapshot = run.snapshot();
    expect(snapshot.configurationPin).toEqual(expected.pin);
    expect(snapshot.manifestRevisionId).toBe(`${projectId}-manifest`);
    expect(snapshot.definition).toMatchObject({
      id: "matter-workflow",
      name: "Matter review",
      defaultFor: ["matter"],
      enforcement: "enforced",
    });
    expect(snapshot.definition.stages.map((stage) => stage.id)).toEqual([
      "intake",
      "research",
      "draft",
      "citation-review",
      "human-approval",
    ]);
    expect(snapshot.stages.map((stage) => stage.roleId)).toEqual([
      "intake-clerk",
      "researcher",
      "drafter",
      "reviewer",
      "approver",
    ]);
    const byId = new Map(
      snapshot.definition.stages.map((stage) => [stage.id, stage]),
    );
    expect(byId.get("intake")).toMatchObject({
      requiresApproval: false,
      requiresIndependentApproval: false,
      requiresDifferentAgentFrom: [],
    });
    expect(byId.get("citation-review")).toMatchObject({
      requiresApproval: true,
      requiresDifferentAgentFrom: ["draft"],
    });
    expect(byId.get("human-approval")).toMatchObject({
      requiresApproval: true,
      requiresIndependentApproval: true,
      // The resolved clause lists separation targets in canonical order.
      requiresDifferentAgentFrom: ["citation-review", "draft"],
    });
    expect(auditPayloads(h)).toContain("definitionSource");

    const restored = await h.storage.pipelines.findById(snapshot.id, projectId);
    expect(restored?.snapshot().definition).toEqual(snapshot.definition);
  });

  test("fails closed, with nothing written, when a stage role does not exist in the Runtime", async () => {
    const h = harness();
    const { projectId, taskId } = await seed(h, {
      pipelines: [delivery],
      roles: ["intake-clerk", "researcher", "drafter"],
      selectLegal: true,
    });

    const attempt = h.manager.start({
      projectId,
      taskId,
      pipelineId: "matter-workflow",
      principal: localOperatorPrincipal,
    });
    await expect(attempt).rejects.toBeInstanceOf(PipelineRoleUnavailableError);
    await expect(attempt).rejects.toThrow(/reviewer, approver/);

    expect(await h.storage.pipelines.findActiveByTask(taskId, projectId)).toBe(
      null,
    );
    expect((await h.storage.tasks.findById(taskId))?.snapshot().status).toBe(
      "pending",
    );
    expect(auditPayloads(h)).not.toContain("pipeline.started");
  });

  test("an ID that is both a manifest pipeline and a pack workflow needs an explicit source", async () => {
    const h = harness();
    const { projectId, taskId } = await seed(h, {
      pipelines: [delivery, manifestMatter],
      roles: [...legalRoles, "developer"],
      selectLegal: true,
    });
    const start = (source?: "manifest" | "pack") =>
      h.manager.start({
        projectId,
        taskId,
        pipelineId: "matter-workflow",
        ...(source === undefined ? {} : { source }),
        principal: localOperatorPrincipal,
      });

    await expect(start()).rejects.toBeInstanceOf(
      PipelineDefinitionAmbiguousError,
    );
    expect(await h.storage.pipelines.findActiveByTask(taskId, projectId)).toBe(
      null,
    );

    const fromManifest = await start("manifest");
    expect(fromManifest.snapshot().definition.name).toBe("Manifest matter");
    // The pin is recorded for any run of a project with a selected pack.
    expect(fromManifest.snapshot().configurationPin).toBeDefined();
  });

  test("source pack picks the pack workflow over a same-ID manifest pipeline", async () => {
    const h = harness();
    const { projectId, taskId } = await seed(h, {
      pipelines: [delivery, manifestMatter],
      roles: [...legalRoles, "developer"],
      selectLegal: true,
    });
    const run = await h.manager.start({
      projectId,
      taskId,
      pipelineId: "matter-workflow",
      source: "pack",
      principal: localOperatorPrincipal,
    });
    expect(run.snapshot().definition.name).toBe("Matter review");
  });

  test("source pack never falls back to a manifest-only pipeline", async () => {
    const h = harness();
    const { projectId, taskId } = await seed(h, {
      pipelines: [delivery],
      roles: legalRoles,
      selectLegal: true,
    });
    await expect(
      h.manager.start({
        projectId,
        taskId,
        pipelineId: "delivery",
        source: "pack",
        principal: localOperatorPrincipal,
      }),
    ).rejects.toBeInstanceOf(OfficePipelineNotFoundError);
  });

  test("a project with no selected pack is unchanged: a pack workflow ID is not a pipeline", async () => {
    const h = harness();
    const { projectId, taskId } = await seed(h, {
      pipelines: [delivery],
      roles: legalRoles,
      selectLegal: false,
    });
    await expect(
      h.manager.start({
        projectId,
        taskId,
        pipelineId: "matter-workflow",
        principal: localOperatorPrincipal,
      }),
    ).rejects.toBeInstanceOf(OfficePipelineNotFoundError);
    const run = await h.manager.start({
      projectId,
      taskId,
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    expect(run.snapshot().configurationPin).toBeUndefined();
    expect(auditPayloads(h)).not.toContain("definitionSource");
  });

  test("an unknown or guidance manifest pipeline of a project with no pack is refused before any transaction opens", async () => {
    const h = harness();
    const { projectId, taskId } = await seed(h, {
      pipelines: [delivery, { ...manifestMatter, enforcement: "guidance" }],
      roles: legalRoles,
      selectLegal: false,
    });
    const start = (pipelineId: string) =>
      h.manager.start({
        projectId,
        taskId,
        pipelineId,
        principal: localOperatorPrincipal,
      });
    await expect(start("typo")).rejects.toBeInstanceOf(
      OfficePipelineNotFoundError,
    );
    await expect(start("matter-workflow")).rejects.toBeInstanceOf(
      PipelineDefinitionNotEnforcedError,
    );
    expect(h.transactionsOpened()).toBe(0);
  });

  test("a pack workflow with no enforced policy is refused as guidance before any role is demanded", async () => {
    const h = harness();
    const { projectId, taskId } = await seed(h, {
      pipelines: [delivery],
      roles: [],
      selectLegal: false,
    });
    const encoder = new TextEncoder();
    const draft = {
      schemaVersion: 1,
      id: "org.example.guidance",
      version: "1.0.0",
      manifestDigest: `sha256:${"0".repeat(64)}`,
      coreContract: { minInclusive: 1, maxExclusive: 3 },
      metadata: { name: "guidance", description: "No policy" },
      dependencies: [],
      contributions: {
        ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
        roles: [{ id: "clerk" }],
        taskTypes: [{ id: "case" }],
        workflows: [
          {
            id: "case-flow",
            taskType: "case",
            stages: [{ id: "open", role: "clerk" }],
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
      provenance: { installerId: "selection", reference: "guidance" },
    });
    await h.storage.packBindings.replace(projectId, 0, [pack], now);

    await expect(
      h.manager.start({
        projectId,
        taskId,
        pipelineId: "case-flow",
        principal: localOperatorPrincipal,
      }),
    ).rejects.toBeInstanceOf(PipelineDefinitionNotEnforcedError);
    expect(await h.storage.pipelines.findActiveByTask(taskId, projectId)).toBe(
      null,
    );
  });
});

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import {
  ProjectPackUpgradeError,
  ReconcileProjectPackUpgrade,
} from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import {
  ProjectDefinitionConflictError,
  maximumDefinitionTextLength,
} from "@ai-office/application/domain-pack/project-definition.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type { ProjectDefinitionRepository } from "@ai-office/application/ports/project-definition-repository.port.ts";
import type { ProjectPackBindingRepository } from "@ai-office/application/ports/project-pack-binding-repository.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresAuditEventRepository } from "@ai-office/storage-postgres/repositories/postgres-audit-event.repository.ts";
import { PostgresProjectDefinitionRepository } from "@ai-office/storage-postgres/repositories/postgres-project-definition.repository.ts";
import { PostgresProjectPackBindingRepository } from "@ai-office/storage-postgres/repositories/postgres-project-pack-binding.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";

// GP-23 outcome: U+0000 is allowed in pack manifest text by design. Manifest
// text lives in the installed catalog and in derived output; it is not written
// to project storage. The one path that would copy it into a stored project
// payload, `convert_to_replace`, is checked against the project definition
// text rule before anything is written, on every backend.

const now = new Date("2026-10-06T00:00:00.000Z");
const NUL = "\u0000";
/** Raw U+0000 or its JSON escape. */
const carriesNul = (text: string): boolean =>
  text.includes(NUL) || text.includes("\\u0000");
const template = parseDomainPackManifest(
  readFileSync(new URL("../fixtures/domain-pack/custom.json", import.meta.url)),
);

function packBytes(
  version: string,
  contributions: Record<string, unknown>,
  metadata = template.metadata,
): Uint8Array {
  const manifest = {
    ...template,
    version,
    metadata,
    contributions: { ...template.contributions, ...contributions },
  } as unknown as typeof template;
  return new TextEncoder().encode(
    JSON.stringify({
      ...manifest,
      manifestDigest: computeManifestDigest(manifest),
    }),
  );
}

// 1.0.0: counsel has no title, so a project extension may set one.
const plainBytes = packBytes("1.0.0", {
  roles: [{ id: "counsel", description: "Plain" }],
});
// 2.0.0: every text field carries U+0000, and counsel gains a title, which
// makes the extension an `extend_conflict`.
const nulBytes = packBytes(
  "2.0.0",
  {
    roles: [{ id: "counsel", title: `T${NUL}`, description: `a${NUL}b` }],
    taskTypes: [{ id: "matter", title: `m${NUL}` }],
    agents: [{ id: "bot", role: "counsel", description: `agent${NUL}` }],
    workflows: [
      {
        id: "flow",
        title: `w${NUL}`,
        description: `flow${NUL}`,
        taskType: "matter",
        stages: [{ id: "draft", role: "counsel" }],
      },
    ],
  },
  { name: `N${NUL}`, description: `D${NUL}` },
);
// 3.0.0: no U+0000, but a description longer than project text may be.
const longBytes = packBytes("3.0.0", {
  roles: [
    {
      id: "counsel",
      title: "Counsel",
      description: "x".repeat(maximumDefinitionTextLength + 1),
    },
  ],
});
// 4.0.0: the same conflict with text a project payload can hold.
const cleanBytes = packBytes("4.0.0", {
  roles: [{ id: "counsel", title: "Counsel", description: "Clean" }],
});

interface Backend {
  readonly projectId: string;
  readonly projects: ProjectRepository;
  readonly definitions: ProjectDefinitionRepository;
  readonly bindings: ProjectPackBindingRepository;
  readonly auditEvents: AuditEventRepository;
  readonly transactions: TransactionRunner;
  /** Every stored definition payload of the project, as stored text. */
  storedPayloads(): Promise<string[]>;
  /** Every audit payload of the project, as stored text. */
  auditPayloads(): Promise<{ eventType: string; payload: string }[]>;
}

async function harness(backend: Backend) {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const [plain, nul, long, clean] = [
    plainBytes,
    nulBytes,
    longBytes,
    cleanBytes,
  ].map((bytes, index) =>
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: {
        installerId: "local-distribution",
        reference: `gp23-${index}`,
      },
    }),
  ) as [PackIdentity, PackIdentity, PackIdentity, PackIdentity];
  const { projectId } = backend;
  await backend.projects.save(
    Project.create({ id: projectId, name: "GP-23", now }),
  );
  const ports = {
    projects: backend.projects,
    definitions: backend.definitions,
    bindings: backend.bindings,
    auditEvents: backend.auditEvents,
    transactions: backend.transactions,
    catalog,
    clock: { now: () => now },
    ids: { generate: randomUUID },
  };
  const definitions = new ManageProjectDefinitions(ports);
  const upgrade = new ReconcileProjectPackUpgrade(ports);
  const configuration = () =>
    new ReadProjectConfiguration(ports).read(projectId);
  const mutate = async (mutation: unknown) =>
    definitions.apply({
      projectId,
      expectedRevision: (await backend.definitions.get(projectId)).revision,
      actorId: "author",
      mutation,
    });
  await new ManageProjectPackBinding(ports).apply({
    projectId,
    desired: [plain],
    expectedRevision: 0,
    actorId: "operator",
  });
  const counsel = { ...plain, kind: "roles", localId: "counsel" };
  await mutate({
    action: "put_override",
    source: counsel,
    operation: "extend",
    payload: { title: "Ours" },
  });
  const authority = async () => ({
    binding: await backend.bindings.get(projectId),
    definitions: await backend.definitions.get(projectId),
    stored: await backend.storedPayloads(),
    upgrades: (await backend.auditPayloads()).filter(
      ({ eventType }) => eventType === "project.pack_upgrade_applied",
    ).length,
  });
  const resolve = (action: string) => [{ source: counsel, action }];
  return {
    plain,
    nul,
    long,
    clean,
    upgrade,
    configuration,
    mutate,
    authority,
    resolve,
  };
}

async function upgradeError(
  work: () => Promise<unknown>,
): Promise<ProjectPackUpgradeError> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectPackUpgradeError);
    return error as ProjectPackUpgradeError;
  }
  throw new Error("expected the upgrade to be refused");
}

const blockedIssue = {
  code: "prospective_configuration_invalid",
  detail: "unresolved_override",
  message:
    "The reconciled project configuration would not resolve: Stored override violates the override contract: malformed_origin_reference",
};

function definePolicyContract(open: () => Promise<Backend>): void {
  test("a selected pack whose text contains U+0000 resolves with the text intact and stores none of it", async () => {
    const backend = await open();
    const h = await harness(backend);
    // The extension conflicts with the new title; drop it to reach 2.0.0.
    const plan = await h.upgrade.preview({
      projectId: backend.projectId,
      desired: [h.nul],
      resolutions: h.resolve("remove_override"),
    });
    expect(plan.issues).toEqual([]);
    // The report names definitions; it carries no definition text.
    expect(JSON.stringify(plan)).not.toContain("\\u0000");
    await h.upgrade.apply({
      projectId: backend.projectId,
      desired: [h.nul],
      resolutions: h.resolve("remove_override"),
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });

    const resolved = await h.configuration();
    expect(resolved.selectedPacks).toEqual([h.nul]);
    expect(resolved.configurationDigest).toBe(
      plan.prospectiveConfigurationDigest,
    );
    const payloads = Object.fromEntries(
      (["roles", "taskTypes", "agents", "workflows"] as const).map((kind) => [
        kind,
        resolved.effectiveDefinitions[kind].map(({ payload }) => payload),
      ]),
    );
    expect(payloads).toEqual({
      roles: [{ id: "counsel", title: `T${NUL}`, description: `a${NUL}b` }],
      taskTypes: [{ id: "matter", title: `m${NUL}` }],
      agents: [{ id: "bot", role: "counsel", description: `agent${NUL}` }],
      workflows: [
        {
          id: "flow",
          title: `w${NUL}`,
          description: `flow${NUL}`,
          taskType: "matter",
          stages: [{ id: "draft", role: "counsel" }],
        },
      ],
    });
    expect(resolved.roles).toMatchObject([
      { title: `T${NUL}`, description: `a${NUL}b`, customization: "none" },
    ]);
    expect(resolved.agents).toMatchObject([{ description: `agent${NUL}` }]);
    expect(resolved.workflows).toMatchObject([
      { title: `w${NUL}`, description: `flow${NUL}` },
    ]);
    // What a client receives: one JSON text with the escape, no raw U+0000.
    const wire = JSON.stringify({ ok: true, configuration: resolved });
    expect(wire).not.toContain(NUL);
    expect(
      (JSON.parse(wire) as { configuration: unknown }).configuration,
    ).toEqual(resolved);

    // An ordinary override stores the project's own fields only; the pack's
    // text is merged at resolution and never written.
    await h.mutate({
      action: "put_override",
      source: { ...h.nul, kind: "agents", localId: "bot" },
      operation: "extend",
      payload: { title: "Our bot" },
    });
    expect((await h.configuration()).agents).toMatchObject([
      { title: "Our bot", description: `agent${NUL}`, customization: "extend" },
    ]);
    const stored = await backend.storedPayloads();
    expect(stored.map((text) => JSON.parse(text) as unknown)).toEqual([
      { title: "Our bot" },
    ]);
    const audits = await backend.auditPayloads();
    expect(audits.map(({ eventType }) => eventType).sort()).toEqual([
      "project.definition_changed",
      "project.definition_changed",
      "project.pack_binding_applied",
      "project.pack_upgrade_applied",
    ]);
    for (const text of [...stored, ...audits.map(({ payload }) => payload)])
      expect(carriesNul(text)).toBe(false);
  });

  test.each([
    ["U+0000", "nul"],
    ["text over the project bound", "long"],
  ] as const)(
    "convert_to_replace of template text with %s is refused before anything is written",
    async (_name, target) => {
      const backend = await open();
      const h = await harness(backend);
      const desired = [h[target]];
      const before = await h.authority();
      expect(before.stored.map((text) => JSON.parse(text) as unknown)).toEqual([
        { title: "Ours" },
      ]);

      const input = {
        projectId: backend.projectId,
        desired,
        resolutions: h.resolve("convert_to_replace"),
      };
      const plan = await h.upgrade.preview(input);
      expect(plan.overrides).toMatchObject([
        { outcome: "converted_to_replace", conflict: "extend_conflict" },
      ]);
      // The copied text fails the project definition text rule, reported with
      // the code GP-06 uses for a stored override that breaks its contract.
      expect(plan.issues).toEqual([blockedIssue]);
      expect(plan.prospectiveConfigurationDigest).toBeUndefined();
      expect(JSON.stringify(plan)).not.toContain("\\u0000");

      const refused = await upgradeError(() =>
        h.upgrade.apply({
          ...input,
          approvedPlanDigest: plan.planDigest,
          actorId: "operator",
        }),
      );
      expect(refused.code).toBe("upgrade_blocked");
      expect(refused.issues).toEqual([blockedIssue]);
      expect(await h.authority()).toEqual(before);
    },
  );

  test("convert_to_replace still works when the copied template text fits project text", async () => {
    const backend = await open();
    const h = await harness(backend);
    const input = {
      projectId: backend.projectId,
      desired: [h.clean],
      resolutions: h.resolve("convert_to_replace"),
    };
    const plan = await h.upgrade.preview(input);
    expect(plan.issues).toEqual([]);
    await h.upgrade.apply({
      ...input,
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    // The project's title wins and the template supplies the description.
    expect(
      (await backend.storedPayloads()).map(
        (text) => JSON.parse(text) as unknown,
      ),
    ).toEqual([{ id: "counsel", title: "Ours", description: "Clean" }]);
  });

  test("project definition text keeps rejecting U+0000 next to a pack that carries it", async () => {
    const backend = await open();
    const h = await harness(backend);
    const before = await h.authority();
    for (const mutation of [
      {
        action: "put_owned",
        kind: "roles",
        id: "own",
        enabled: true,
        payload: { id: "own", title: `a${NUL}` },
      },
      {
        action: "put_override",
        source: { ...h.plain, kind: "roles", localId: "counsel" },
        operation: "extend",
        payload: { title: `a${NUL}` },
      },
    ]) {
      const error: unknown = await h.mutate(mutation).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ProjectDefinitionConflictError);
      expect((error as ProjectDefinitionConflictError).code).toBe(
        "malformed_origin_reference",
      );
    }
    expect(await h.authority()).toEqual(before);
  });
}

describe("GP-23 pack manifest U+0000 policy on SQLite", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  definePolicyContract(async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-gp23-"));
    roots.push(root);
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, join(process.cwd(), "migrations", "project"));
    const storage = createSqliteProjectStorage(database);
    return {
      projectId: "gp23",
      projects: storage.projects,
      definitions: storage.definitions,
      bindings: storage.packBindings,
      auditEvents: storage.auditEvents,
      transactions: storage.transactions,
      storedPayloads: async () =>
        database
          .query<{ payload_json: string }, []>(
            `SELECT payload_json FROM project_owned_definition
             UNION ALL
             SELECT payload_json FROM project_definition_override
              WHERE payload_json IS NOT NULL`,
          )
          .all()
          .map((row) => row.payload_json),
      auditPayloads: async () =>
        database
          .query<{ event_type: string; payload_json: string }, []>(
            "SELECT event_type, payload_json FROM audit_event",
          )
          .all()
          .map((row) => ({
            eventType: row.event_type,
            payload: row.payload_json,
          })),
    };
  });
});

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;

describe.skipIf(connectionString === undefined)(
  "GP-23 pack manifest U+0000 policy on PostgreSQL",
  () => {
    const tenantId = "gp23-tenant";
    let database: PostgresClient;

    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(
        database,
        join(process.cwd(), "supabase", "migrations"),
      );
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING",
        [tenantId, "GP-23 Tenant", now],
      );
    });

    afterAll(async () => {
      await database.close();
    });

    definePolicyContract(async () => {
      const projectId = randomUUID();
      return {
        projectId,
        projects: new PostgresProjectRepository(database, tenantId),
        definitions: new PostgresProjectDefinitionRepository(
          database,
          tenantId,
        ),
        bindings: new PostgresProjectPackBindingRepository(database, tenantId),
        auditEvents: new PostgresAuditEventRepository(database, tenantId),
        transactions: new PostgresTransactionRunner(database),
        storedPayloads: async () =>
          (
            await database.query<{ payload: string }>(
              // A payload is a jsonb object; its text is the stored JSON.
              `SELECT payload_json::text AS payload
                 FROM core.project_owned_definition WHERE project_id = $1
               UNION ALL
               SELECT payload_json::text AS payload
                 FROM core.project_definition_override
                WHERE project_id = $1 AND payload_json IS NOT NULL`,
              [projectId],
            )
          ).map((row) => row.payload),
        auditPayloads: async () =>
          (
            await database.query<{ event_type: string; payload: string }>(
              "SELECT event_type, payload_json::text AS payload FROM core.audit_event WHERE project_id = $1",
              [projectId],
            )
          ).map((row) => ({ eventType: row.event_type, payload: row.payload })),
      };
    });

    test("jsonb, where project definition payloads live, has no U+0000", async () => {
      // The limitation GP-07's text rule answers. Manifest text is never an
      // argument of such a statement.
      const error: unknown = await database
        .query(`SELECT '{"title":"a\\u0000b"}'::jsonb AS value`)
        .then(
          () => null,
          (reason: unknown) => reason,
        );
      expect(error).toMatchObject({
        code: "22P05",
        message: "unsupported Unicode escape sequence",
      });
    });
  },
);

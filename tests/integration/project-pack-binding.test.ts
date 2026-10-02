import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import {
  DomainPackCatalogError,
  type InstalledDomainPackCatalog,
  type PackIdentity,
} from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackId,
  parseDomainPackManifest,
  parseDomainPackVersion,
  parseManifestDigest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp05-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  const installed = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const bytes = readFileSync(
    new URL("../fixtures/domain-pack/custom.json", import.meta.url),
  );
  const pack = installed.register({
    bytes,
    artifactDigest: computeArtifactDigest(bytes),
    provenance: {
      installerId: "local-distribution",
      reference: "bundled/custom",
    },
  });
  let sequence = 0;
  const service = (
    catalog: InstalledDomainPackCatalog = installed,
    auditEvents: AuditEventRepository = storage.auditEvents,
  ) =>
    new ManageProjectPackBinding({
      projects: storage.projects,
      bindings: storage.packBindings,
      catalog,
      auditEvents,
      transactions: storage.transactions,
      clock: { now: () => new Date("2026-10-02T00:00:00.000Z") },
      ids: { generate: () => `audit-${++sequence}` },
    });
  return { database, storage, installed, pack, service };
}

async function createProject(
  storage: ReturnType<typeof createSqliteProjectStorage>,
  id: string,
) {
  await storage.projects.save(
    Project.create({ id, name: id, now: new Date("2026-10-02T00:00:00.000Z") }),
  );
}

describe("GP-05 explicit project pack binding", () => {
  test("preview is read-only; apply persists exact selection and audit atomically", async () => {
    const { database, storage, pack, service } = harness();
    try {
      await createProject(storage, "project-a");
      await createProject(storage, "project-b");
      const before = await service().preview("project-a", [pack]);
      expect(before).toMatchObject({
        current: { configurationRevision: 0, packs: [] },
        proposed: [pack],
        added: [pack],
        removed: [],
        changed: [],
        issues: [],
      });
      expect(await storage.packBindings.get("project-a")).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });
      expect(
        (await service().preview("project-a", [pack, pack])).issues,
      ).toMatchObject([{ code: "version_conflict" }]);
      expect(await storage.packBindings.get("project-a")).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });
      const applied = await service().apply({
        projectId: "project-a",
        desired: [pack],
        expectedRevision: 0,
        actorId: "local-operator",
      });
      expect(applied).toMatchObject({
        configurationRevision: 1,
        packs: [pack],
      });
      const unavailable = new InMemoryInstalledDomainPackCatalog(1, []);
      expect((await service(unavailable).read("project-a")).packs).toEqual([
        pack,
      ]);
      expect(
        (await service(unavailable).preview("project-a", [pack])).issues[0]
          ?.code,
      ).toBe("missing_pack");
      expect(await storage.packBindings.get("project-b")).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });
      expect(
        await service(unavailable).apply({
          projectId: "project-a",
          desired: [pack],
          expectedRevision: 1,
          actorId: "local-operator",
        }),
      ).toEqual(applied);
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM audit_event WHERE event_type='project.pack_binding_applied'",
          )
          .get()?.count,
      ).toBe(1);
      const audit = database
        .query<{ payload_json: string }, []>(
          "SELECT payload_json FROM audit_event WHERE event_type='project.pack_binding_applied'",
        )
        .get();
      expect(JSON.parse(audit!.payload_json)).toMatchObject({
        previousRevision: 0,
        newRevision: 1,
        packs: [pack],
        result: "applied",
      });
      await expect(
        service().apply({
          projectId: "project-a",
          desired: [],
          expectedRevision: 0,
          actorId: "local-operator",
        }),
      ).rejects.toThrow("stale");
      expect(
        (
          await service().apply({
            projectId: "project-a",
            desired: [],
            expectedRevision: 1,
            actorId: "local-operator",
          })
        ).packs,
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("missing, untrusted and incompatible artifacts fail without changing state", async () => {
    const { database, storage, installed, pack, service } = harness();
    try {
      await createProject(storage, "project-a");
      const missing: PackIdentity = {
        ...pack,
        version: parseDomainPackVersion("9.0.0"),
      };
      expect(
        (await service().preview("project-a", [missing])).issues[0]?.code,
      ).toBe("missing_pack");
      await expect(
        service().apply({
          projectId: "project-a",
          desired: [missing],
          expectedRevision: 0,
          actorId: "local-operator",
        }),
      ).rejects.toBeInstanceOf(DomainPackCatalogError);
      const untrusted: InstalledDomainPackCatalog = {
        coreContractVersion: 1,
        read: (id, version) => installed.read(id, version),
        list: () => installed.list(),
        trusts: () => false,
      };
      expect(
        (await service(untrusted).preview("project-a", [pack])).issues[0]?.code,
      ).toBe("untrusted_provenance");
      await expect(
        service(untrusted).apply({
          projectId: "project-a",
          desired: [pack],
          expectedRevision: 0,
          actorId: "local-operator",
        }),
      ).rejects.toMatchObject({ code: "untrusted_provenance" });
      const incompatible: InstalledDomainPackCatalog = {
        ...untrusted,
        coreContractVersion: 3,
        trusts: () => true,
      };
      expect(
        (await service(incompatible).preview("project-a", [pack])).issues[0]
          ?.code,
      ).toBe("incompatible_core_contract");
      await expect(
        service(incompatible).apply({
          projectId: "project-a",
          desired: [pack],
          expectedRevision: 0,
          actorId: "local-operator",
        }),
      ).rejects.toMatchObject({ code: "incompatible_core_contract" });
      const required: PackIdentity = {
        id: parseDomainPackId("org.example.required"),
        version: parseDomainPackVersion("1.0.0"),
        manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
      };
      const bytes = readFileSync(
        new URL("../fixtures/domain-pack/custom.json", import.meta.url),
      );
      const manifest = {
        ...parseDomainPackManifest(bytes),
        dependencies: [required],
        manifestDigest: `sha256:${"0".repeat(64)}`,
      };
      const encoder = new TextEncoder();
      const dependentBytes = encoder.encode(
        JSON.stringify({
          ...manifest,
          manifestDigest: computeManifestDigest(
            parseDomainPackManifest(encoder.encode(JSON.stringify(manifest))),
          ),
        }),
      );
      const missingDependency = new InMemoryInstalledDomainPackCatalog(1, [
        "local-distribution",
      ]);
      const dependent = missingDependency.register({
        bytes: dependentBytes,
        artifactDigest: computeArtifactDigest(dependentBytes),
        provenance: {
          installerId: "local-distribution",
          reference: "bundled/dependent",
        },
      });
      expect(
        (await service(missingDependency).preview("project-a", [dependent]))
          .issues[0]?.code,
      ).toBe("missing_dependency");
      await expect(
        service(missingDependency).apply({
          projectId: "project-a",
          desired: [dependent],
          expectedRevision: 0,
          actorId: "local-operator",
        }),
      ).rejects.toMatchObject({ code: "missing_dependency" });
      expect(await storage.packBindings.get("project-a")).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM audit_event WHERE event_type='project.pack_binding_applied'",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  test("audit failure rolls back the binding and its revision", async () => {
    const { database, storage, installed, pack, service } = harness();
    try {
      await createProject(storage, "project-a");
      await expect(
        service(installed, {
          append: async () => {
            throw new Error("audit unavailable");
          },
        }).apply({
          projectId: "project-a",
          desired: [pack],
          expectedRevision: 0,
          actorId: "local-operator",
        }),
      ).rejects.toThrow("audit unavailable");
      expect(await storage.packBindings.get("project-a")).toMatchObject({
        configurationRevision: 0,
        packs: [],
      });
    } finally {
      database.close();
    }
  });
});

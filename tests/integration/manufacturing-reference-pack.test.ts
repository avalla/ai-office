import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { ReconcileProjectPackUpgrade } from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
  parseManifestDigest,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const bytes = readFileSync(
  new URL(
    "../../packages/domain-pack-manufacturing/manifest.json",
    import.meta.url,
  ),
);
const manifest = verifyDomainPackManifest(bytes, 1);
const now = new Date("2026-10-07T00:00:00.000Z");
const roots: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function nextVersion(): Uint8Array {
  const draft = {
    ...manifest,
    version: "0.2.0",
    contributions: {
      ...manifest.contributions,
      roles: manifest.contributions.roles.map((role) =>
        role.id === "inspector"
          ? { ...role, title: "Senior quality inspector" }
          : role,
      ),
    },
  };
  return new TextEncoder().encode(
    JSON.stringify({
      ...draft,
      manifestDigest: computeManifestDigest(
        parseDomainPackManifest(
          new TextEncoder().encode(JSON.stringify(draft)),
        ),
      ),
    }),
  );
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp18-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  databases.push(database);
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  await storage.projects.save(
    Project.create({ id: "factory", name: "Factory", now }),
  );
  const catalog = new InMemoryInstalledDomainPackCatalog(1, ["gp18-fixture"]);
  const versions = [bytes, nextVersion()].map((artifact, index) =>
    catalog.register({
      bytes: artifact,
      artifactDigest: computeArtifactDigest(artifact),
      provenance: {
        installerId: "gp18-fixture",
        reference: `version-${index}`,
      },
    }),
  );
  let sequence = 0;
  const ports = {
    projects: storage.projects,
    definitions: storage.definitions,
    bindings: storage.packBindings,
    catalog,
    auditEvents: storage.auditEvents,
    transactions: storage.transactions,
    clock: { now: () => now },
    ids: { generate: () => `audit-${++sequence}` },
  };
  return {
    database,
    versions,
    binding: new ManageProjectPackBinding(ports),
    definitions: new ManageProjectDefinitions(ports),
    configuration: new ReadProjectConfiguration(ports),
    upgrade: new ReconcileProjectPackUpgrade(ports),
  };
}

describe("GP-18 manufacturing reference pack", () => {
  test("declares production order, provenance and approval without software defaults", () => {
    expect(manifest.id).toBe("org.ai-office.manufacturing");
    expect(manifest.contributions.taskTypes.map((item) => item.id)).toEqual([
      "production-order",
    ]);
    expect(
      manifest.contributions.workflows[0]?.stages.map((stage) => stage.id),
    ).toEqual([
      "plan",
      "execute",
      "inspect",
      "deviation",
      "supervisor-approval",
    ]);
    expect(
      manifest.contributions.evidenceTypes.find(
        (item) => item.id === "execution-evidence",
      ),
    ).toMatchObject({
      subject: "production-order",
      payloadSchema: { required: ["observedAt", "sourceRecord"] },
    });
    expect(manifest.contributions.policies[0]).toMatchObject({
      workflow: "production-flow",
      enforcement: "enforced",
      stages: [
        { stage: "execute", operations: ["manufacturing.order.record"] },
        { stage: "inspect", requiresApproval: true },
        {
          stage: "supervisor-approval",
          requiresApproval: true,
          requiresIndependentApproval: true,
        },
      ],
    });
    expect(manifest.contributions.capabilities[0]).toMatchObject({
      operations: [
        { operation: "manufacturing.order.record", mode: "mutation" },
      ],
      requirement: "optional",
    });
    expect(manifest.contributions.prompts).toEqual([]);
  });

  test("binds, resolves and preserves a project inspector across an upgrade", async () => {
    const h = await harness();
    const [v1, v2] = h.versions;
    const selection = await h.binding.preview("factory", [v1!]);
    expect(selection.issues).toEqual([]);
    await h.binding.apply({
      projectId: "factory",
      desired: [v1!],
      expectedRevision: selection.current.configurationRevision,
      actorId: "operator",
    });
    const before = await h.configuration.read("factory");
    expect(before.selectedPacks).toEqual([v1]);
    expect(before.roles.map((role) => role.roleId).sort()).toEqual(
      [
        "deviation-coordinator",
        "inspector",
        "operator",
        "planner",
        "supervisor",
      ].map((id) => `pack:org.ai-office.manufacturing/roles/${id}`),
    );
    expect(before.agents.map((agent) => agent.agentId).sort()).toEqual(
      [
        "deviation-agent",
        "inspector-agent",
        "operator-agent",
        "planner-agent",
        "supervisor-agent",
      ].map((id) => `pack:org.ai-office.manufacturing/agents/${id}`),
    );
    expect(before.workflows[0]?.stages.map((stage) => stage.id)).toEqual([
      "plan",
      "execute",
      "inspect",
      "deviation",
      "supervisor-approval",
    ]);
    expect(before.origins[before.workflows[0]!.effectiveId]).toMatchObject({
      origin: "pack_owned",
      kind: "workflows",
      localId: "production-flow",
      pack: v1,
    });
    expect(before.policies[0]?.stages[0]).toMatchObject({
      stage: "execute",
      operations: ["manufacturing.order.record"],
    });
    expect(
      before.evidenceTypes.find((item) =>
        item.definitionId.endsWith("/execution-evidence"),
      ),
    ).toMatchObject({
      subject: "production-order",
    });
    expect(before.validators[0]?.registration).toBe("unchecked");
    expect(before.capabilities[0]?.operations[0]?.binding).toBe(
      "unbound_optional",
    );
    expect(
      h.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM capability_grants",
        )
        .get()?.count,
    ).toBe(0);

    const mutation = {
      action: "put_override",
      source: { ...v1!, kind: "roles", localId: "inspector" },
      operation: "replace",
      payload: { id: "inspector", title: "Project quality inspector" },
    };
    expect((await h.definitions.preview("factory", mutation)).issues).toEqual(
      [],
    );
    await h.definitions.apply({
      projectId: "factory",
      mutation,
      expectedRevision: 0,
      actorId: "project-owner",
    });
    const plan = await h.upgrade.preview({
      projectId: "factory",
      desired: [v2!],
    });
    expect(plan.issues).toEqual([]);
    await expect(
      h.upgrade.apply({
        projectId: "factory",
        desired: [v2!],
        approvedPlanDigest: `sha256:${"0".repeat(64)}`,
        actorId: "operator",
      }),
    ).rejects.toMatchObject({ code: "plan_not_approved" });
    expect((await h.binding.read("factory")).packs).toEqual([v1]);
    await h.upgrade.apply({
      projectId: "factory",
      desired: [v2!],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    const after = await h.configuration.read("factory");
    expect(after.selectedPacks).toEqual([v2]);
    expect(
      after.roles.find((role) => role.roleId.endsWith("/inspector")),
    ).toMatchObject({
      title: "Project quality inspector",
      customization: "replace",
    });
    expect(after.capabilities).toEqual(before.capabilities);
    expect(after.policies.map((policy) => policy.policyId)).toEqual(
      before.policies.map((policy) => policy.policyId),
    );
  });

  test("rejects an exact tuple with a wrong manifest digest without changing the binding", async () => {
    const h = await harness();
    const wrong = {
      ...h.versions[0]!,
      manifestDigest: parseManifestDigest(`sha256:${"0".repeat(64)}`),
    };
    const preview = await h.binding.preview("factory", [wrong]);
    expect(preview.issues[0]?.code).toBe("manifest_digest_mismatch");
    await expect(
      h.binding.apply({
        projectId: "factory",
        desired: [wrong],
        expectedRevision: preview.current.configurationRevision,
        actorId: "operator",
      }),
    ).rejects.toMatchObject({ code: "manifest_digest_mismatch" });
    expect((await h.binding.read("factory")).packs).toEqual([]);
  });
});

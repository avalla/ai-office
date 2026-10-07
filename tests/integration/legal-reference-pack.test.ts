import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import {
  ProjectPackUpgradeError,
  ReconcileProjectPackUpgrade,
} from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import {
  DomainPackManifestError,
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
  new URL("../../packages/domain-pack-legal/manifest.json", import.meta.url),
);
const manifest = verifyDomainPackManifest(bytes, 1);
const roots: string[] = [];
const databases: Database[] = [];
const now = new Date("2026-10-07T00:00:00.000Z");

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
        role.id === "researcher"
          ? { ...role, title: "Senior legal researcher" }
          : role.id === "reviewer"
            ? { ...role, title: "Upstream review counsel" }
            : role,
      ),
    },
  };
  const value = {
    ...draft,
    manifestDigest: computeManifestDigest(
      parseDomainPackManifest(new TextEncoder().encode(JSON.stringify(draft))),
    ),
  };
  return new TextEncoder().encode(JSON.stringify(value));
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp17-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  databases.push(database);
  migrate(database, join(process.cwd(), "migrations", "project"));
  const storage = createSqliteProjectStorage(database);
  await storage.projects.save(
    Project.create({ id: "legal", name: "Legal", now }),
  );
  const catalog = new InMemoryInstalledDomainPackCatalog(1, ["gp17-fixture"]);
  const versions = [bytes, nextVersion()].map((artifact, index) =>
    catalog.register({
      bytes: artifact,
      artifactDigest: computeArtifactDigest(artifact),
      provenance: {
        installerId: "gp17-fixture",
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
    versions,
    binding: new ManageProjectPackBinding(ports),
    definitions: new ManageProjectDefinitions(ports),
    configuration: new ReadProjectConfiguration(ports),
    upgrade: new ReconcileProjectPackUpgrade(ports),
  };
}

describe("GP-17 legal reference pack", () => {
  test("declares a five-stage matter review through public contracts", () => {
    expect(manifest.id).toBe("org.ai-office.legal");
    expect(
      manifest.contributions.workflows[0]?.stages.map((stage) => stage.id),
    ).toEqual([
      "intake",
      "research",
      "draft",
      "citation-review",
      "human-approval",
    ]);
    expect(manifest.contributions.policies[0]).toMatchObject({
      workflow: "matter-workflow",
      stages: [
        { stage: "citation-review", requiresApproval: true },
        {
          stage: "human-approval",
          requiresApproval: true,
          requiresIndependentApproval: true,
        },
      ],
    });
    expect(manifest.contributions.artifactTypes.map((item) => item.id)).toEqual(
      ["matter-draft", "citation-list"],
    );
    expect(manifest.contributions.evidenceTypes.map((item) => item.id)).toEqual(
      ["citation-review-evidence", "approval-evidence"],
    );
    expect(manifest.contributions.knowledge[0]?.id).toBe("matter-research");
    expect(manifest.contributions.capabilities[0]).toMatchObject({
      operations: [{ operation: "legal.matter.read", mode: "read" }],
      requirement: "optional",
    });
    expect(manifest.contributions.validators[0]).toMatchObject({
      produces: "citation-review-evidence",
      failurePolicy: "fail_closed",
    });
  });

  test("binds, resolves, customizes and upgrades without losing the project edit", async () => {
    const h = await harness();
    const [v1, v2] = h.versions;
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    const selection = await h.binding.preview("legal", [v1!]);
    expect(selection.issues).toEqual([]);
    await h.binding.apply({
      projectId: "legal",
      desired: [v1!],
      expectedRevision: selection.current.configurationRevision,
      actorId: "operator",
    });
    const before = await h.configuration.read("legal");
    expect(before.selectedPacks).toEqual([v1]);
    expect(before.roles.map((role) => role.roleId).sort()).toEqual(
      ["approver", "drafter", "intake-clerk", "researcher", "reviewer"].map(
        (id) => `pack:org.ai-office.legal/roles/${id}`,
      ),
    );
    expect(before.agents.map((agent) => agent.agentId).sort()).toEqual(
      [
        "approval-agent",
        "draft-agent",
        "intake-agent",
        "research-agent",
        "review-agent",
      ].map((id) => `pack:org.ai-office.legal/agents/${id}`),
    );
    expect(before.effectiveDefinitions.prompts).toEqual([]);
    expect(
      before.effectiveDefinitions.taskTypes.map((item) => item.localId),
    ).toEqual(["matter"]);
    expect(before.workflows[0]?.stages.map((stage) => stage.id)).toEqual([
      "intake",
      "research",
      "draft",
      "citation-review",
      "human-approval",
    ]);
    expect(before.policies[0]?.workflowId).toBe(
      "pack:org.ai-office.legal/workflows/matter-workflow",
    );
    expect(before.knowledge[0]?.knowledgeId).toBe(
      "pack:org.ai-office.legal/knowledge/matter-research",
    );
    expect(before.validators[0]?.registration).toBe("unchecked");
    expect(before.artifactTypes.map((item) => item.definitionId)).toHaveLength(
      2,
    );
    expect(before.evidenceTypes.map((item) => item.definitionId)).toHaveLength(
      2,
    );
    expect(before.capabilities[0]?.operations[0]?.binding).toBe(
      "unbound_optional",
    );

    const source = { ...v1!, kind: "roles", localId: "reviewer" };
    const mutation = {
      action: "put_override",
      source,
      operation: "replace",
      payload: { id: "reviewer", title: "Project review counsel" },
    };
    expect((await h.definitions.preview("legal", mutation)).issues).toEqual([]);
    await h.definitions.apply({
      projectId: "legal",
      mutation,
      expectedRevision: 0,
      actorId: "project-owner",
    });
    const plan = await h.upgrade.preview({
      projectId: "legal",
      desired: [v2!],
    });
    expect(plan.issues).toEqual([]);
    await expect(
      h.upgrade.apply({
        projectId: "legal",
        desired: [v2!],
        approvedPlanDigest: `sha256:${"0".repeat(64)}`,
        actorId: "operator",
      }),
    ).rejects.toMatchObject({
      code: "plan_not_approved",
    } satisfies Partial<ProjectPackUpgradeError>);
    expect((await h.binding.read("legal")).packs).toEqual([v1]);
    await h.upgrade.apply({
      projectId: "legal",
      desired: [v2!],
      approvedPlanDigest: plan.planDigest,
      actorId: "operator",
    });
    const after = await h.configuration.read("legal");
    expect(after.selectedPacks).toEqual([v2]);
    expect(
      after.roles.find((role) => role.roleId.endsWith("/reviewer")),
    ).toMatchObject({
      title: "Project review counsel",
      customization: "replace",
      capabilities: ["pack:org.ai-office.legal/capabilities/read-matter"],
    });
    expect(
      after.roles.find((role) => role.roleId.endsWith("/researcher"))?.title,
    ).toBe("Senior legal researcher");
    const agentContract = (agents: typeof after.agents) =>
      agents.map(({ agentId, roleId, knowledge, capabilities }) => ({
        agentId,
        roleId,
        knowledge,
        capabilities,
      }));
    expect(agentContract(after.agents)).toEqual(agentContract(before.agents));
    const policyContract = (policies: typeof after.policies) =>
      policies.map(({ policyId, workflowId, enforcement, stages }) => ({
        policyId,
        workflowId,
        enforcement,
        stages,
      }));
    expect(policyContract(after.policies)).toEqual(
      policyContract(before.policies),
    );
    const knowledgeContract = (knowledge: typeof after.knowledge) =>
      knowledge.map(({ knowledgeId, category, schema, retrieval }) => ({
        knowledgeId,
        category,
        schema,
        retrieval,
      }));
    expect(knowledgeContract(after.knowledge)).toEqual(
      knowledgeContract(before.knowledge),
    );
    expect(after.capabilities).toEqual(before.capabilities);
    expect(after.artifactTypes.map((item) => item.definitionId)).toEqual(
      before.artifactTypes.map((item) => item.definitionId),
    );
    expect(after.evidenceTypes.map((item) => item.definitionId)).toEqual(
      before.evidenceTypes.map((item) => item.definitionId),
    );
    expect(after.configurationDigest).not.toBe(before.configurationDigest);
  });

  test("refuses binding to a tuple with the wrong manifest digest", async () => {
    const h = await harness();
    const unavailable = {
      ...h.versions[0]!,
      manifestDigest: parseManifestDigest(`sha256:${"0".repeat(64)}`),
    };
    const preview = await h.binding.preview("legal", [unavailable]);
    expect(preview.issues[0]?.code).toBe("manifest_digest_mismatch");
    expect((await h.binding.read("legal")).packs).toEqual([]);
  });

  test("rejects a policy aimed at a missing stage", () => {
    const invalid = {
      ...manifest,
      contributions: {
        ...manifest.contributions,
        policies: [
          {
            ...manifest.contributions.policies[0],
            stages: [{ stage: "publish", requiresApproval: true }],
          },
        ],
      },
    };
    let error: unknown;
    try {
      parseDomainPackManifest(
        new TextEncoder().encode(JSON.stringify(invalid)),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainPackManifestError);
    expect(error).toMatchObject({
      code: "invalid_contribution",
      path: "contributions.policies[0].stages[0].stage",
    });
  });
});

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import {
  ManageProjectPackBinding,
  ProjectPackBindingProviderError,
  ProjectPackBindingRefusedError,
} from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import {
  ProjectPackUpgradeError,
  ReconcileProjectPackUpgrade,
} from "@ai-office/application/domain-pack/reconcile-project-pack-upgrade.ts";
import { ProjectConfigurationResolutionError } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type {
  InstalledDomainPackCatalog,
  PackIdentity,
} from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type { OperationProviderCatalog } from "@ai-office/application/ports/operation-provider-catalog.port.ts";
import type { ProjectDefinitionRepository } from "@ai-office/application/ports/project-definition-repository.port.ts";
import type { ProjectPackBindingRepository } from "@ai-office/application/ports/project-pack-binding-repository.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { createDefaultConnectorRegistry } from "@ai-office/filesystem-connector/default-connector-registry.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { createOperationProviderCatalog } from "@ai-office/runtime-host/operation-provider-catalog.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresAuditEventRepository } from "@ai-office/storage-postgres/repositories/postgres-audit-event.repository.ts";
import { PostgresProjectDefinitionRepository } from "@ai-office/storage-postgres/repositories/postgres-project-definition.repository.ts";
import { PostgresProjectPackBindingRepository } from "@ai-office/storage-postgres/repositories/postgres-project-pack-binding.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import { canonicalizeJcsJson } from "../../packages/domain-pack-contracts/src/jcs.ts";

// GP-16 on both backends: the same application services over SQLite and,
// when AI_OFFICE_TEST_POSTGRES_URL is set, over PostgreSQL. The provider
// catalog is the one the Runtime host builds from its default registry.

const now = new Date("2026-10-06T00:00:00.000Z");
const encoder = new TextEncoder();
const providers = createOperationProviderCatalog(
  createDefaultConnectorRegistry(),
);

function packBytes(
  id: string,
  version: string,
  contributions: Record<string, unknown[]>,
  dependencies: PackIdentity[] = [],
): Uint8Array {
  const draft = {
    schemaVersion: 1,
    id,
    version,
    manifestDigest: `sha256:${"0".repeat(64)}`,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: id, description: "Capability contract fixture" },
    dependencies,
    contributions: {
      ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
      ...contributions,
    },
  };
  return encoder.encode(
    JSON.stringify({
      ...draft,
      manifestDigest: computeManifestDigest(
        parseDomainPackManifest(encoder.encode(JSON.stringify(draft))),
      ),
    }),
  );
}

function identityOf(bytes: Uint8Array): PackIdentity {
  const { id, version, manifestDigest } = parseDomainPackManifest(bytes);
  return { id, version, manifestDigest };
}

const read = { operation: "fake.read", mode: "read" };
const write = { operation: "fake.write", mode: "mutation" };
const merge = { operation: "github.merge_pr", mode: "mutation" };
const role = { id: "operator", capabilities: ["publish"] };
const title = "Confidential capability title";

// ops@1: publish requires fake.read; a label beside it.
const opsBytes = packBytes("org.example.ops", "1.0.0", {
  roles: [role],
  capabilities: [{ id: "label" }, { id: "publish", title, operations: [read] }],
});
const ops = identityOf(opsBytes);
// ops@2: publish gains fake.write and becomes optional; a new capability.
const opsV2Bytes = packBytes("org.example.ops", "2.0.0", {
  roles: [role],
  capabilities: [
    { id: "label" },
    {
      id: "publish",
      title,
      operations: [read, write],
      requirement: "optional",
    },
    { id: "audit", operations: [read] },
  ],
});
const opsV2 = identityOf(opsV2Bytes);
// ops@3: the same role and capability, now requiring an unregistered operation.
const opsV3Bytes = packBytes("org.example.ops", "3.0.0", {
  roles: [role],
  capabilities: [{ id: "label" }, { id: "publish", operations: [read, merge] }],
});
const opsV3 = identityOf(opsV3Bytes);
// ops@4: only a new capability is added; nothing existing changes.
const opsV4Bytes = packBytes("org.example.ops", "4.0.0", {
  roles: [role],
  capabilities: [
    { id: "label" },
    { id: "publish", title, operations: [read] },
    { id: "audit", operations: [read], requirement: "optional" },
  ],
});
const opsV4 = identityOf(opsV4Bytes);
// ops@5: the label gains a contract.
const opsV5Bytes = packBytes("org.example.ops", "5.0.0", {
  roles: [role],
  capabilities: [
    { id: "label", operations: [read] },
    { id: "publish", title, operations: [read] },
  ],
});
const opsV5 = identityOf(opsV5Bytes);
const needsBytes = packBytes("org.example.needs", "1.0.0", {
  capabilities: [{ id: "merge", operations: [merge] }],
});
const needs = identityOf(needsBytes);
// Selects `needs` only as a dependency.
const dependentBytes = packBytes(
  "org.example.dependent",
  "1.0.0",
  { prompts: [{ id: "greeting" }] },
  [needs],
);
const dependent = identityOf(dependentBytes);
const mismatchBytes = packBytes("org.example.mode", "1.0.0", {
  capabilities: [
    { id: "peek", operations: [{ operation: "fake.write", mode: "read" }] },
  ],
});
const mismatch = identityOf(mismatchBytes);
const optionalBytes = packBytes("org.example.optional", "1.0.0", {
  capabilities: [
    { id: "extras", requirement: "optional", operations: [read, merge] },
  ],
});
const optional = identityOf(optionalBytes);

// shift@1 -> shift@2: `trim` loses an operation and keeps its requirement,
// `flip` changes the mode of an operation no provider lists, and `drop` loses
// its contract and becomes a label.
const mergeAsRead = { operation: "github.merge_pr", mode: "read" };
const shiftBytes = packBytes("org.example.shift", "1.0.0", {
  capabilities: [
    { id: "trim", operations: [read, write] },
    { id: "flip", requirement: "optional", operations: [mergeAsRead] },
    { id: "drop", operations: [read] },
  ],
});
const shift = identityOf(shiftBytes);
const shiftV2Bytes = packBytes("org.example.shift", "2.0.0", {
  capabilities: [
    { id: "trim", operations: [read] },
    { id: "flip", requirement: "optional", operations: [merge] },
    { id: "drop" },
  ],
});
const shiftV2 = identityOf(shiftV2Bytes);
// shift@3: the only difference from shift@1 is the operation `trim` loses.
const shiftV3Bytes = packBytes("org.example.shift", "3.0.0", {
  capabilities: [
    { id: "trim", operations: [read] },
    { id: "flip", requirement: "optional", operations: [mergeAsRead] },
    { id: "drop", operations: [read] },
  ],
});
const shiftV3 = identityOf(shiftV3Bytes);

function catalogOf(...artifacts: Uint8Array[]) {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  for (const bytes of artifacts)
    catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: { installerId: "local-distribution", reference: "fixture" },
    });
  return catalog;
}

const everything = () =>
  catalogOf(
    opsBytes,
    opsV2Bytes,
    opsV3Bytes,
    opsV4Bytes,
    opsV5Bytes,
    needsBytes,
    dependentBytes,
    mismatchBytes,
    optionalBytes,
    shiftBytes,
    shiftV2Bytes,
    shiftV3Bytes,
  );

interface Backend {
  readonly projectId: string;
  readonly projects: ProjectRepository;
  readonly bindings: ProjectPackBindingRepository;
  readonly definitions: ProjectDefinitionRepository;
  readonly auditEvents: AuditEventRepository;
  readonly transactions: TransactionRunner;
  /** Payload text of the audit events of one type, oldest first. */
  auditPayloads(eventType: string): Promise<string[]>;
}

const missingMessage = (pack: string, capability: string) =>
  `Pack ${pack} capability capabilities/${capability} requires operation github.merge_pr, which no registered provider offers`;

function defineContract(name: string, create: () => Promise<Backend>): void {
  async function host(
    catalog: InstalledDomainPackCatalog = everything(),
    selectedProviders: OperationProviderCatalog = providers,
  ) {
    const backend = await create();
    await backend.projects.save(
      Project.create({ id: backend.projectId, name: "GP-16", now }),
    );
    let sequence = 0;
    const ports = {
      projects: backend.projects,
      bindings: backend.bindings,
      definitions: backend.definitions,
      catalog,
      providers: selectedProviders,
      auditEvents: backend.auditEvents,
      transactions: backend.transactions,
      clock: { now: () => now },
      ids: { generate: () => `${backend.projectId}-event-${++sequence}` },
    };
    const binding = new ManageProjectPackBinding(ports);
    const upgrade = new ReconcileProjectPackUpgrade(ports);
    const reader = new ReadProjectConfiguration(ports);
    const id = backend.projectId;
    const authority = async () => ({
      binding: await backend.bindings.get(id),
      definitions: (await backend.definitions.get(id)).revision,
      bindingAudits: (
        await backend.auditPayloads("project.pack_binding_applied")
      ).length,
      upgradeAudits: (
        await backend.auditPayloads("project.pack_upgrade_applied")
      ).length,
    });
    return {
      backend,
      id,
      ports,
      binding,
      upgrade,
      reader,
      authority,
      apply: (desired: PackIdentity[], expectedRevision: number) =>
        binding.apply({
          projectId: id,
          desired,
          expectedRevision,
          actorId: "local-operator",
        }),
      resolution: () =>
        reader.read(id).then(
          (configuration) => configuration,
          (error: unknown) => {
            if (!(error instanceof ProjectConfigurationResolutionError))
              throw error;
            return { code: error.code, message: error.message };
          },
        ),
    };
  }

  describe(`GP-16 pack capability contracts on ${name}`, () => {
    test("a bound required operation applies and resolves with its provider; an unbound optional one is reported", async () => {
      const runtime = await host();
      expect(
        (await runtime.binding.preview(runtime.id, [ops, optional])).issues,
      ).toEqual([]);
      await runtime.apply([ops, optional], 0);
      const configuration = await runtime.resolution();
      expect(configuration).toMatchObject({
        capabilities: [
          {
            capabilityId: "pack:org.example.ops/capabilities/label",
            operations: [],
          },
          {
            capabilityId: "pack:org.example.ops/capabilities/publish",
            requirement: "required",
            operations: [
              {
                operation: "fake.read",
                mode: "read",
                binding: "bound",
                provider: { id: "fake", version: "1" },
              },
            ],
          },
          {
            capabilityId: "pack:org.example.optional/capabilities/extras",
            requirement: "optional",
            operations: [
              {
                operation: "fake.read",
                mode: "read",
                binding: "bound",
                provider: { id: "fake", version: "1" },
              },
              {
                operation: "github.merge_pr",
                mode: "mutation",
                binding: "unbound_optional",
              },
            ],
          },
        ],
      });
      expect(await runtime.authority()).toMatchObject({
        binding: { configurationRevision: 1 },
        bindingAudits: 1,
      });
    });

    test("project:pack:preview and project:pack:apply refuse a missing or mismatched required provider and write nothing", async () => {
      const runtime = await host();
      const before = await runtime.authority();
      for (const [selection, code, message] of [
        [
          [needs],
          "missing_required_capability_provider",
          missingMessage("org.example.needs@1.0.0", "merge"),
        ],
        // The requirement of a pack that is only a dependency counts too.
        [
          [dependent],
          "missing_required_capability_provider",
          missingMessage("org.example.needs@1.0.0", "merge"),
        ],
        [
          [mismatch],
          "capability_provider_mismatch",
          "Pack org.example.mode@1.0.0 capability capabilities/peek declares operation fake.write in a mode that differs from its registered provider",
        ],
      ] as const) {
        const preview = await runtime.binding.preview(runtime.id, [
          ...selection,
        ]);
        expect(preview.issues, code).toEqual([{ code, message }]);
        const rejected = await runtime
          .apply([...selection], 0)
          .catch((error: unknown) => error);
        expect(rejected, code).toBeInstanceOf(ProjectPackBindingProviderError);
        expect(rejected).toMatchObject({ code, message });
        // The same refusal beside an unrelated, satisfiable pack.
        await expect(
          runtime.apply([ops, ...selection], 0),
        ).rejects.toMatchObject({ code });
      }
      expect(await runtime.authority()).toEqual(before);
      expect(before).toMatchObject({
        binding: { configurationRevision: 0, packs: [] },
        bindingAudits: 0,
      });
    });

    test("resolution of stored state fails closed with the same codes", async () => {
      // State that did not pass a preflight, as after a restore.
      for (const [pack, code] of [
        [needs, "missing_required_capability_provider"],
        [dependent, "missing_required_capability_provider"],
        [mismatch, "capability_provider_mismatch"],
      ] as const) {
        const runtime = await host();
        await runtime.backend.bindings.replace(runtime.id, 0, [pack], now);
        const failure = await runtime.resolution();
        expect(failure, pack.id).toMatchObject({ code });
        expect(failure).not.toHaveProperty("capabilities");
        expect(failure).not.toHaveProperty("configurationDigest");
      }
    });

    test("applying the identical selection is a no-op that reads no artifact and no provider", async () => {
      const runtime = await host();
      await runtime.apply([ops], 0);
      const before = await runtime.authority();
      let reads = 0;
      const silent = new ManageProjectPackBinding({
        ...runtime.ports,
        catalog: {
          coreContractVersion: 1,
          list: () => runtime.ports.catalog.list(),
          trusts: (provenance) => runtime.ports.catalog.trusts(provenance),
          read: (id, version) => {
            reads += 1;
            return runtime.ports.catalog.read(id, version);
          },
        },
        providers: {
          list: () => {
            reads += 1;
            throw new Error("must not be read");
          },
        },
      });
      const result = await silent.apply({
        projectId: runtime.id,
        desired: [ops],
        expectedRevision: 1,
        actorId: "local-operator",
      });
      expect(result).toMatchObject({ configurationRevision: 1, packs: [ops] });
      expect(reads).toBe(0);
      expect(await runtime.authority()).toEqual(before);
    });

    test("project:pack:apply refuses a contract change to an existing capability and names project:pack:upgrade", async () => {
      const runtime = await host();
      await runtime.apply([ops], 0);
      const before = await runtime.authority();
      const publishChange = {
        capabilityId: "pack:org.example.ops/capabilities/publish",
        addedOperations: [write],
        removedOperations: [],
        requirement: { before: "required", after: "optional" },
      };
      const preview = await runtime.binding.preview(runtime.id, [opsV2]);
      expect(preview.capabilityContractChanges).toEqual({
        availability: "available",
        changes: [
          {
            capabilityId: "pack:org.example.ops/capabilities/audit",
            addedOperations: [read],
            removedOperations: [],
            requirement: { before: null, after: "required" },
          },
          publishChange,
        ],
      });
      const refusal = {
        code: "capability_contract_change_requires_upgrade",
        message:
          "The selection changes the operation contract of capability pack:org.example.ops/capabilities/publish; review and approve it with project:pack:upgrade",
      };
      expect(preview.issues).toEqual([refusal]);
      const rejected = await runtime
        .apply([opsV2], 1)
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(ProjectPackBindingRefusedError);
      expect(rejected).toMatchObject(refusal);
      // A label that gains a contract is a change to an existing capability.
      await expect(runtime.apply([opsV5], 1)).rejects.toMatchObject({
        code: "capability_contract_change_requires_upgrade",
        message: expect.stringContaining(
          "pack:org.example.ops/capabilities/label",
        ),
      });
      expect(await runtime.authority()).toEqual(before);

      // A new capability beside unchanged ones is not a change to an existing
      // one: the plain selection change carries it.
      const added = await runtime.binding.preview(runtime.id, [opsV4]);
      expect(added.issues).toEqual([]);
      expect(added.capabilityContractChanges).toEqual({
        availability: "available",
        changes: [
          {
            capabilityId: "pack:org.example.ops/capabilities/audit",
            addedOperations: [read],
            removedOperations: [],
            requirement: { before: null, after: "optional" },
          },
        ],
      });
      await runtime.apply([opsV4], 1);
      expect(await runtime.authority()).toMatchObject({
        binding: { configurationRevision: 2, packs: [opsV4] },
        bindingAudits: 2,
      });
    });

    test("project:pack:upgrade carries the contract change under planDigest and audits identities only", async () => {
      const runtime = await host();
      await runtime.apply([ops], 0);
      const plan = await runtime.upgrade.preview({
        projectId: runtime.id,
        desired: [opsV2],
      });
      expect(plan.issues).toEqual([]);
      expect(plan.capabilityContractChanges).toEqual({
        availability: "available",
        changes: [
          {
            capabilityId: "pack:org.example.ops/capabilities/audit",
            addedOperations: [read],
            removedOperations: [],
            requirement: { before: null, after: "required" },
          },
          {
            capabilityId: "pack:org.example.ops/capabilities/publish",
            addedOperations: [write],
            removedOperations: [],
            requirement: { before: "required", after: "optional" },
          },
        ],
      });
      // The digest is over the whole report, this field included.
      const digestOf = (value: object) =>
        `sha256:${createHash("sha256")
          .update("ai-office-pack-upgrade-plan-v1\n", "utf8")
          .update(canonicalizeJcsJson(value as never), "utf8")
          .digest("hex")}`;
      const { planDigest, ...report } = plan;
      expect(digestOf(report)).toBe(planDigest);
      const { capabilityContractChanges: _omitted, ...without } = report;
      expect(digestOf(without)).not.toBe(planDigest);

      await expect(
        runtime.upgrade.apply({
          projectId: runtime.id,
          desired: [opsV2],
          approvedPlanDigest: digestOf(without),
          actorId: "local-operator",
        }),
      ).rejects.toMatchObject({ code: "plan_not_approved" });
      const result = await runtime.upgrade.apply({
        projectId: runtime.id,
        desired: [opsV2],
        approvedPlanDigest: planDigest,
        actorId: "local-operator",
      });
      expect(result).toMatchObject({ result: "applied", packs: [opsV2] });
      const audits = await runtime.backend.auditPayloads(
        "project.pack_upgrade_applied",
      );
      expect(audits).toHaveLength(1);
      expect(JSON.parse(audits[0]!)).toMatchObject({
        planDigest,
        capabilityContractChanges: plan.capabilityContractChanges,
      });
      // Identities only: no definition body, no provider and no version.
      expect(audits[0]).not.toContain(title);
      expect(audits[0]).not.toMatch(/"provider"|"binding"|"bound"/u);
      expect(await runtime.resolution()).toMatchObject({
        capabilities: [
          { capabilityId: "pack:org.example.ops/capabilities/audit" },
          { capabilityId: "pack:org.example.ops/capabilities/label" },
          {
            capabilityId: "pack:org.example.ops/capabilities/publish",
            requirement: "optional",
            operations: [
              { operation: "fake.read", binding: "bound" },
              { operation: "fake.write", binding: "bound" },
            ],
          },
        ],
      });
    });

    test("a removed operation, a changed mode and a lost contract are reported with the requirement on both sides", async () => {
      const runtime = await host();
      await runtime.apply([shift], 0);
      const before = await runtime.authority();
      const changes = [
        {
          capabilityId: "pack:org.example.shift/capabilities/drop",
          addedOperations: [],
          removedOperations: [read],
          // A label has no requirement.
          requirement: { before: "required", after: null },
        },
        {
          capabilityId: "pack:org.example.shift/capabilities/flip",
          // One operation in another mode: one removed and one added entry.
          addedOperations: [merge],
          removedOperations: [mergeAsRead],
          requirement: { before: "optional", after: "optional" },
        },
        {
          capabilityId: "pack:org.example.shift/capabilities/trim",
          addedOperations: [],
          removedOperations: [write],
          // Only an operation changed; the requirement is reported anyway.
          requirement: { before: "required", after: "required" },
        },
      ];
      const preview = await runtime.binding.preview(runtime.id, [shiftV2]);
      expect(preview.capabilityContractChanges).toEqual({
        availability: "available",
        changes,
      });
      expect(preview.issues).toEqual([
        {
          code: "capability_contract_change_requires_upgrade",
          message:
            "The selection changes the operation contract of capability pack:org.example.shift/capabilities/drop; review and approve it with project:pack:upgrade",
        },
      ]);
      await expect(runtime.apply([shiftV2], 1)).rejects.toBeInstanceOf(
        ProjectPackBindingRefusedError,
      );

      // A removal alone is a contract change too: apply refuses it.
      const removal = await runtime.binding.preview(runtime.id, [shiftV3]);
      expect(removal.capabilityContractChanges).toEqual({
        availability: "available",
        changes: [changes[2]],
      });
      const rejected = await runtime
        .apply([shiftV3], 1)
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(ProjectPackBindingRefusedError);
      expect(rejected).toMatchObject({
        code: "capability_contract_change_requires_upgrade",
        message:
          "The selection changes the operation contract of capability pack:org.example.shift/capabilities/trim; review and approve it with project:pack:upgrade",
      });
      expect(await runtime.authority()).toEqual(before);

      // The reviewed upgrade carries the same report into the plan and the
      // audit event, the unchanged requirement of `trim` included.
      const plan = await runtime.upgrade.preview({
        projectId: runtime.id,
        desired: [shiftV2],
      });
      expect(plan.issues).toEqual([]);
      expect(plan.capabilityContractChanges).toEqual({
        availability: "available",
        changes,
      });
      await runtime.upgrade.apply({
        projectId: runtime.id,
        desired: [shiftV2],
        approvedPlanDigest: plan.planDigest,
        actorId: "local-operator",
      });
      const audits = await runtime.backend.auditPayloads(
        "project.pack_upgrade_applied",
      );
      expect(audits).toHaveLength(1);
      expect(JSON.parse(audits[0]!)).toMatchObject({
        planDigest: plan.planDigest,
        capabilityContractChanges: { availability: "available", changes },
      });
    });

    test("project:pack:preview of the unchanged selection still reports a missing provider; applying it stays a no-op", async () => {
      // A binding that passed no preflight on this host, as after a restore
      // or after the host lost a connector.
      const runtime = await host();
      await runtime.backend.bindings.replace(runtime.id, 0, [needs], now);
      const before = await runtime.authority();
      const preview = await runtime.binding.preview(runtime.id, [needs]);
      expect(preview).toMatchObject({ added: [], removed: [], changed: [] });
      expect(preview.issues).toEqual([
        {
          code: "missing_required_capability_provider",
          message: missingMessage("org.example.needs@1.0.0", "merge"),
        },
      ]);
      // Apply of the active selection is the GP-05 no-op and checks nothing:
      // it changes no authority, so it neither repairs nor refuses. The
      // failure stays visible in preview and at resolution.
      expect(await runtime.apply([needs], 1)).toMatchObject({
        configurationRevision: 1,
        packs: [needs],
      });
      expect(await runtime.authority()).toEqual(before);
      expect(await runtime.resolution()).toMatchObject({
        code: "missing_required_capability_provider",
      });
    });

    test("project:pack:upgrade refuses a target whose required provider is missing and writes nothing", async () => {
      const runtime = await host();
      await runtime.apply([ops], 0);
      const before = await runtime.authority();
      const plan = await runtime.upgrade.preview({
        projectId: runtime.id,
        desired: [opsV3],
      });
      expect(plan.issues).toEqual([
        {
          code: "prospective_configuration_invalid",
          detail: "missing_required_capability_provider",
          message: `The reconciled project configuration would not resolve: ${missingMessage("org.example.ops@3.0.0", "publish")}`,
        },
      ]);
      expect(plan.prospectiveConfigurationDigest).toBeUndefined();
      // The report still shows what the target would have changed.
      expect(plan.capabilityContractChanges).toEqual({
        availability: "available",
        changes: [
          {
            capabilityId: "pack:org.example.ops/capabilities/publish",
            addedOperations: [merge],
            removedOperations: [],
            // Unchanged, and reported all the same: the reader must see
            // that the new operation is a required one.
            requirement: { before: "required", after: "required" },
          },
        ],
      });
      const rejected = await runtime.upgrade
        .apply({
          projectId: runtime.id,
          desired: [opsV3],
          approvedPlanDigest: plan.planDigest,
          actorId: "local-operator",
        })
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(ProjectPackUpgradeError);
      expect(rejected).toMatchObject({
        code: "upgrade_blocked",
        issues: [{ detail: "missing_required_capability_provider" }],
      });
      // The plain selection change is refused for the provider first.
      await expect(runtime.apply([opsV3], 1)).rejects.toBeInstanceOf(
        ProjectPackBindingProviderError,
      );
      expect(await runtime.authority()).toEqual(before);
    });

    test("a provider catalog that cannot be read refuses the binding instead of binding it", async () => {
      const runtime = await host(everything(), {
        list: () => {
          throw new Error("registry unavailable: token=hunter2");
        },
      });
      const preview = await runtime.binding.preview(runtime.id, [ops]);
      expect(preview.issues).toEqual([
        {
          code: "configuration_invariant",
          message: "Operation provider catalog could not be read",
        },
      ]);
      const rejected = await runtime
        .apply([ops], 0)
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(ProjectPackBindingProviderError);
      expect(rejected).toMatchObject({ code: "configuration_invariant" });
      expect(await runtime.authority()).toMatchObject({
        binding: { configurationRevision: 0, packs: [] },
        bindingAudits: 0,
      });
    });
  });
}

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function sqliteDatabase() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp16-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  closers.push(() => database.close());
  migrate(database, join(process.cwd(), "migrations", "project"));
  return database;
}

function sqliteBackend(database = sqliteDatabase()): Backend {
  const storage = createSqliteProjectStorage(database);
  return {
    projectId: "a",
    projects: storage.projects,
    bindings: storage.packBindings,
    definitions: storage.definitions,
    auditEvents: storage.auditEvents,
    transactions: storage.transactions,
    auditPayloads: async (eventType) =>
      database
        .query<{ payload_json: string }, [string]>(
          "SELECT payload_json FROM audit_event WHERE event_type = ? ORDER BY rowid",
        )
        .all(eventType)
        .map((row) => row.payload_json),
  };
}

defineContract("SQLite", async () => sqliteBackend());

describe("GP-16 on SQLite: no controlled-action state is written", () => {
  test("show, preview, apply, refusal and upgrade leave resource, grant, action, approval and simulation tables empty", async () => {
    const database = sqliteDatabase();
    const backend = sqliteBackend(database);
    await backend.projects.save(
      Project.create({ id: backend.projectId, name: "GP-16", now }),
    );
    let sequence = 0;
    const ports = {
      projects: backend.projects,
      bindings: backend.bindings,
      definitions: backend.definitions,
      catalog: everything(),
      providers,
      auditEvents: backend.auditEvents,
      transactions: backend.transactions,
      clock: { now: () => now },
      ids: { generate: () => `event-${++sequence}` },
    };
    const binding = new ManageProjectPackBinding(ports);
    const upgrade = new ReconcileProjectPackUpgrade(ports);
    const reader = new ReadProjectConfiguration(ports);
    const actor = { projectId: "a", actorId: "local-operator" };
    await binding.preview("a", [ops]);
    await binding.apply({ ...actor, desired: [ops], expectedRevision: 0 });
    await reader.read("a");
    await expect(
      binding.apply({ ...actor, desired: [needs], expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(ProjectPackBindingProviderError);
    await expect(
      binding.apply({ ...actor, desired: [opsV2], expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(ProjectPackBindingRefusedError);
    const plan = await upgrade.preview({ projectId: "a", desired: [opsV2] });
    await upgrade.apply({
      ...actor,
      desired: [opsV2],
      approvedPlanDigest: plan.planDigest,
    });
    await reader.read("a");
    const tables = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => row.name)
      .filter((name) =>
        /^(?:resources|capability_grants|action_|approval)/u.test(name),
      );
    expect(tables).toEqual(
      expect.arrayContaining([
        "action_approvals",
        "action_executions",
        "action_requests",
        "action_simulations",
        "capability_grants",
        "resources",
      ]),
    );
    for (const table of tables)
      expect(
        database
          .query<{ count: number }, []>(
            `SELECT count(*) AS count FROM ${table}`,
          )
          .get()!.count,
        table,
      ).toBe(0);
    // Only the two domain-pack events were recorded.
    expect(
      database
        .query<{ event_type: string }, []>(
          "SELECT DISTINCT event_type FROM audit_event ORDER BY event_type",
        )
        .all()
        .map((row) => row.event_type),
    ).toEqual(["project.pack_binding_applied", "project.pack_upgrade_applied"]);
  });
});

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;

describe.skipIf(connectionString === undefined)(
  "GP-16 pack capability contracts (PostgreSQL backend)",
  () => {
    const tenantId = "gp16-tenant";
    let database: PostgresClient;

    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(
        database,
        join(process.cwd(), "supabase", "migrations"),
      );
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING",
        [tenantId, "GP-16 Tenant", now],
      );
    });

    afterAll(async () => {
      await database.close();
    });

    defineContract("PostgreSQL", async () => {
      const projectId = `gp16-${randomUUID()}`;
      return {
        projectId,
        projects: new PostgresProjectRepository(database, tenantId),
        bindings: new PostgresProjectPackBindingRepository(database, tenantId),
        definitions: new PostgresProjectDefinitionRepository(
          database,
          tenantId,
        ),
        auditEvents: new PostgresAuditEventRepository(database, tenantId),
        transactions: new PostgresTransactionRunner(database),
        auditPayloads: async (eventType) =>
          (
            await database.query<{ payload: string }>(
              "SELECT payload_json::text AS payload FROM core.audit_event WHERE project_id = $1 AND event_type = $2 ORDER BY occurred_at, id",
              [projectId, eventType],
            )
          ).map((row) => row.payload),
      };
    });
  },
);

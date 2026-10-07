import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  DomainPackManifestError,
  maximumCapabilityOperations,
  parseDomainPackManifest,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import type { PackIdentity } from "../../packages/application/src/ports/installed-domain-pack-catalog.port.ts";
import type { OperationProviderCatalog } from "../../packages/application/src/ports/operation-provider-catalog.port.ts";
import type { ProjectDefinitionState } from "../../packages/application/src/domain-pack/project-definition.ts";
import {
  ProjectConfigurationResolutionError,
  resolveProjectConfiguration,
} from "../../packages/application/src/domain-pack/resolve-project-configuration.ts";
import { ConnectorRegistry } from "../../packages/connector-sdk/src/connector-registry.ts";
import { fakeConnectorDefinition } from "../../packages/connector-sdk/src/fake-connector.ts";
import { createDefaultConnectorRegistry } from "../../packages/filesystem-connector/src/default-connector-registry.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";
import { createOperationProviderCatalog } from "../../packages/runtime-host/src/operation-provider-catalog.ts";

const repositoryRoot = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const encoder = new TextEncoder();

function draft(
  id: string,
  contributions: Record<string, unknown[]>,
  dependencies: PackIdentity[] = [],
  version = "1.0.0",
) {
  return {
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
}

const parse = (value: unknown) =>
  parseDomainPackManifest(encoder.encode(JSON.stringify(value)));

/** Exact bytes of one schema-1 manifest with its computed digest. */
function packBytes(...input: Parameters<typeof draft>): Uint8Array {
  const value = draft(...input);
  return encoder.encode(
    JSON.stringify({
      ...value,
      manifestDigest: computeManifestDigest(parse(value)),
    }),
  );
}

function identityOf(bytes: Uint8Array): PackIdentity {
  const { id, version, manifestDigest } = parseDomainPackManifest(bytes);
  return { id, version, manifestDigest };
}

const capability = (entry: Record<string, unknown>) =>
  draft("org.example.ops", { capabilities: [{ id: "publish", ...entry }] });

function rejection(entry: Record<string, unknown>) {
  try {
    parse(capability(entry));
  } catch (error) {
    if (error instanceof DomainPackManifestError)
      return { code: error.code, path: error.path };
    throw error;
  }
  return "accepted";
}

const read = { operation: "fake.read", mode: "read" };
const write = { operation: "fake.write", mode: "mutation" };
const at = (suffix: string) => ({
  code: "invalid_contribution",
  path: `contributions.capabilities[0]${suffix}`,
});

describe("GP-16 capability contract: schema-1 manifest", () => {
  test("a capability accepts operations and a requirement, and required is the one canonical default", () => {
    const explicit = parse(
      capability({ operations: [read, write], requirement: "required" }),
    );
    expect(explicit.contributions.capabilities).toEqual([
      { id: "publish", operations: [read, write], requirement: "required" },
    ]);
    const defaulted = parse(capability({ operations: [read, write] }));
    expect(defaulted.contributions.capabilities).toEqual(
      explicit.contributions.capabilities,
    );
    expect(computeManifestDigest(defaulted)).toBe(
      computeManifestDigest(explicit),
    );
    const optional = parse(
      capability({ operations: [read], requirement: "optional" }),
    );
    expect(optional.contributions.capabilities).toEqual([
      { id: "publish", operations: [read], requirement: "optional" },
    ]);
    expect(computeManifestDigest(optional)).not.toBe(
      computeManifestDigest(parse(capability({ operations: [read] }))),
    );
  });

  test("a manifest without the fields keeps its canonical form and golden digests unchanged", () => {
    for (const path of [
      "tests/fixtures/domain-pack/custom.json",
      "tests/fixtures/domain-pack/development.json",
      "tests/fixtures/domain-pack/legal.json",
      "tests/fixtures/domain-pack/manufacturing.json",
    ]) {
      // The declared digest was computed before GP-16; verification recomputes it.
      const manifest = verifyDomainPackManifest(
        readFileSync(join(repositoryRoot, path)),
      );
      for (const entry of manifest.contributions.capabilities)
        expect(Object.keys(entry).sort(), path).not.toContain("operations");
    }
    // An id-only capability stays a label: no member is added to it.
    const label = parse(capability({ title: "Publish" }));
    expect(label.contributions.capabilities).toEqual([
      { id: "publish", title: "Publish" },
    ]);
    expect(JSON.stringify(label.contributions.capabilities)).toBe(
      '[{"id":"publish","title":"Publish"}]',
    );
  });

  test("operations is a set in one order: the digest does not depend on the written order", () => {
    const forward = parse(capability({ operations: [read, write] }));
    const backward = parse(capability({ operations: [write, read] }));
    expect(backward.contributions.capabilities).toEqual(
      forward.contributions.capabilities,
    );
    expect(computeManifestDigest(backward)).toBe(
      computeManifestDigest(forward),
    );
  });

  test("malformed operations and requirements fail with invalid_contribution and the member path", () => {
    expect(rejection({ operations: "fake.read" })).toEqual(at(".operations"));
    expect(rejection({ operations: {} })).toEqual(at(".operations"));
    expect(rejection({ operations: [] })).toEqual(at(".operations"));
    expect(
      rejection({
        operations: Array.from(
          { length: maximumCapabilityOperations + 1 },
          (_, index) => ({ operation: `fake.op${index}`, mode: "read" }),
        ),
      }),
    ).toEqual(at(".operations"));
    expect(
      rejection({
        operations: Array.from(
          { length: maximumCapabilityOperations },
          (_, index) => ({ operation: `fake.op${index}`, mode: "read" }),
        ),
      }),
    ).toBe("accepted");
    // One operation is named once, whatever its mode.
    expect(rejection({ operations: [read, read] })).toEqual(at(".operations"));
    expect(
      rejection({
        operations: [read, { operation: "fake.read", mode: "mutation" }],
      }),
    ).toEqual(at(".operations"));
    for (const operation of [
      "",
      "read",
      "fake.",
      ".read",
      "fake..read",
      "fake.*",
      "*",
      "*.read",
      "fake.read ",
      " fake.read",
      "fake/read",
      "fake.rea d",
      "fäke.read",
      `fake.${"a".repeat(124)}`,
      7,
      null,
    ])
      expect(
        rejection({ operations: [{ operation, mode: "read" }] }),
        String(operation),
      ).toEqual(at(".operations[0].operation"));
    expect(
      rejection({
        operations: [{ operation: `fake.${"a".repeat(123)}`, mode: "read" }],
      }),
    ).toBe("accepted");
    for (const mode of ["write", "READ", "", null, 1])
      expect(
        rejection({ operations: [{ operation: "fake.read", mode }] }),
        String(mode),
      ).toEqual(at(".operations[0].mode"));
    expect(rejection({ operations: [{ operation: "fake.read" }] })).toEqual(
      at(".operations[0].mode"),
    );
    expect(rejection({ operations: [{ mode: "read" }] })).toEqual(
      at(".operations[0].operation"),
    );
    expect(rejection({ operations: ["fake.read"] })).toEqual(
      at(".operations[0]"),
    );
    for (const requirement of ["mandatory", "", null, true])
      expect(
        rejection({ operations: [read], requirement }),
        String(requirement),
      ).toEqual(at(".requirement"));
    // A requirement states nothing without an operation to require.
    expect(rejection({ requirement: "required" })).toEqual(at(".requirement"));
    expect(rejection({ requirement: "optional" })).toEqual(at(".requirement"));
  });

  test("an operation entry holds only operation and mode", () => {
    for (const member of [
      "riskLevel",
      "requiresApproval",
      "supportsExecution",
      "version",
      "provider",
      "constraints",
    ])
      expect(
        rejection({ operations: [{ ...read, [member]: "x" }] }),
        member,
      ).toEqual(at(`.operations[0].${member}`));
  });

  test("a capability cannot declare risk, approval, constraints, a resource, a grant, a principal, a credential or a provider version", () => {
    for (const member of [
      "riskLevel",
      "requiresApproval",
      "constraints",
      "resource",
      "grant",
      "principal",
      "credentialRef",
      "version",
      "connectorVersion",
      "providerVersion",
    ])
      expect(rejection({ operations: [read], [member]: "x" }), member).toEqual(
        at(`.${member}`),
      );
  });

  test("the fields are rejected on every other contribution kind", () => {
    for (const kind of contributionKinds) {
      if (kind === "capabilities") continue;
      const base =
        kind === "workflows"
          ? { id: "w", taskType: "t", stages: [] }
          : { id: "x" };
      for (const [member, value] of [
        ["operations", [read]],
        ["requirement", "required"],
      ] as const) {
        let failure: unknown;
        try {
          parse(
            draft("org.example.ops", {
              [kind]: [{ ...base, [member]: value }],
            }),
          );
        } catch (error) {
          failure = error;
        }
        expect(failure, `${kind}.${member}`).toBeInstanceOf(
          DomainPackManifestError,
        );
        expect(failure).toMatchObject({
          code: "invalid_contribution",
          path: `contributions.${kind}[0].${member}`,
        });
      }
    }
  });
});

describe("GP-16 operation provider catalog port", () => {
  test("lists each registered provider's ID, version and operations with mode, and nothing else", () => {
    const registry = createDefaultConnectorRegistry();
    const providers = createOperationProviderCatalog(registry).list();
    expect(providers.map((provider) => provider.id)).toEqual([
      "fake",
      "filesystem",
    ]);
    expect(providers[0]).toEqual({
      id: "fake",
      version: "1",
      operations: [
        { operation: "fake.admin", mode: "mutation" },
        { operation: "fake.delete", mode: "mutation" },
        { operation: "fake.read", mode: "read" },
        { operation: "fake.write", mode: "mutation" },
      ],
    });
    for (const provider of providers) {
      expect(Object.keys(provider).sort()).toEqual([
        "id",
        "operations",
        "version",
      ]);
      expect(provider.version).toBe(registry.get(provider.id)!.version);
      expect(provider.operations).toEqual(
        registry
          .get(provider.id)!
          .operations.map(({ operation, mode }) => ({ operation, mode })),
      );
      for (const operation of provider.operations)
        expect(Object.keys(operation).sort()).toEqual(["mode", "operation"]);
    }
    // Data only: no connector function crosses the port.
    expect(JSON.parse(JSON.stringify(providers))).toEqual(providers);
  });

  test("is a frozen copy built once: it cannot be edited and does not follow a later object", () => {
    const catalog = createOperationProviderCatalog(
      new ConnectorRegistry([fakeConnectorDefinition]),
    );
    const first = catalog.list();
    expect(catalog.list()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]!.operations)).toBe(true);
    expect(Object.isFrozen(first[0]!.operations[0])).toBe(true);
    expect(() => {
      (first as unknown as unknown[]).push({ id: "ghost" });
    }).toThrow(TypeError);
    expect(() => {
      (first[0]!.operations[0] as { mode: string }).mode = "read";
    }).toThrow(TypeError);
  });

  test("the registry enumerates descriptors in a stable order", () => {
    const registry = createDefaultConnectorRegistry();
    expect(registry.descriptors().map((descriptor) => descriptor.id)).toEqual([
      "fake",
      "filesystem",
    ]);
    expect(registry.descriptors()[0]).toBe(registry.get("fake"));
  });
});

// --- Resolution -----------------------------------------------------------

const fakeProviders: OperationProviderCatalog = {
  list: () => [
    {
      id: "fake",
      version: "1",
      operations: [
        { operation: "fake.admin", mode: "mutation" },
        { operation: "fake.read", mode: "read" },
        { operation: "fake.write", mode: "mutation" },
      ],
    },
  ],
};

function installed(...artifacts: Uint8Array[]) {
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

const emptyState: ProjectDefinitionState = {
  projectId: "project-a",
  revision: 0,
  owned: [],
  overrides: [],
};

function resolveWith(
  artifacts: Uint8Array[],
  selected: PackIdentity[],
  providers?: OperationProviderCatalog,
  definitions: ProjectDefinitionState = emptyState,
) {
  const catalog = installed(...artifacts);
  return resolveProjectConfiguration({
    projectId: "project-a",
    binding: {
      projectId: "project-a",
      configurationRevision: 1,
      packs: selected,
    },
    definitions,
    catalog,
    coreContractVersion: 1,
    ...(providers === undefined ? {} : { providers }),
  });
}

function failureOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectConfigurationResolutionError)
      return { code: error.code, message: error.message };
    throw error;
  }
  return "resolved";
}

const opsBytes = packBytes("org.example.ops", {
  roles: [{ id: "operator", capabilities: ["publish"] }],
  capabilities: [
    { id: "label" },
    { id: "publish", operations: [write, read] },
    {
      id: "extras",
      requirement: "optional",
      operations: [read, { operation: "github.create_pr", mode: "mutation" }],
    },
  ],
});
const ops = identityOf(opsBytes);

describe("GP-16 resolution: derived capabilities view", () => {
  test("reports every capability of the closure with its binding, or unbound_optional", () => {
    const configuration = resolveWith([opsBytes], [ops], fakeProviders);
    expect(configuration.capabilities).toEqual([
      {
        capabilityId: "pack:org.example.ops/capabilities/extras",
        requirement: "optional",
        operations: [
          {
            operation: "fake.read",
            mode: "read",
            binding: "bound",
            provider: { id: "fake", version: "1" },
          },
          {
            operation: "github.create_pr",
            mode: "mutation",
            binding: "unbound_optional",
          },
        ],
      },
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
          {
            operation: "fake.write",
            mode: "mutation",
            binding: "bound",
            provider: { id: "fake", version: "1" },
          },
        ],
      },
    ]);
  });

  test("the binding is not digest or pin material: another provider version yields the same digest", () => {
    const one = resolveWith([opsBytes], [ops], fakeProviders);
    const two = resolveWith([opsBytes], [ops], {
      list: () =>
        fakeProviders.list().map((provider) => ({ ...provider, version: "2" })),
    });
    expect(two.capabilities).not.toEqual(one.capabilities);
    expect(two.configurationDigest).toBe(one.configurationDigest);
    expect(two.pin).toEqual(one.pin);
    expect(JSON.stringify(one.pin)).not.toContain("fake");
  });

  test("the empty-input vector and a label-only configuration do not depend on providers", () => {
    const vector =
      "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19";
    for (const providers of [undefined, fakeProviders]) {
      const empty = resolveProjectConfiguration({
        projectId: "project-a",
        binding: {
          projectId: "project-a",
          configurationRevision: 0,
          packs: [],
        },
        definitions: emptyState,
        catalog: installed(),
        coreContractVersion: 1,
        ...(providers === undefined ? {} : { providers }),
      });
      expect(empty.configurationDigest).toBe(vector);
      expect(empty.capabilities).toEqual([]);
    }
    const labels = packBytes("org.example.labels", {
      roles: [{ id: "clerk", capabilities: ["file"] }],
      capabilities: [{ id: "file" }],
    });
    const without = resolveWith([labels], [identityOf(labels)]);
    const withProviders = resolveWith(
      [labels],
      [identityOf(labels)],
      fakeProviders,
    );
    expect(withProviders.configurationDigest).toBe(without.configurationDigest);
    expect(without.capabilities).toEqual([
      {
        capabilityId: "pack:org.example.labels/capabilities/file",
        operations: [],
      },
    ]);
  });

  test("a label-only pack never reads the provider catalog", () => {
    const labels = packBytes("org.example.labels", {
      capabilities: [{ id: "file" }],
    });
    let reads = 0;
    resolveWith([labels], [identityOf(labels)], {
      list: () => {
        reads += 1;
        throw new Error("must not be read");
      },
    });
    expect(reads).toBe(0);
  });
});

describe("GP-16 resolution: fail closed", () => {
  const missing = packBytes("org.example.needs", {
    capabilities: [
      {
        id: "merge",
        operations: [{ operation: "github.merge_pr", mode: "mutation" }],
      },
    ],
  });
  const missingMessage =
    "Pack org.example.needs@1.0.0 capability capabilities/merge requires operation github.merge_pr, which no registered provider offers";

  test("a required operation with no registered provider fails with missing_required_capability_provider", () => {
    expect(
      failureOf(() =>
        resolveWith([missing], [identityOf(missing)], fakeProviders),
      ),
    ).toEqual({
      code: "missing_required_capability_provider",
      message: missingMessage,
    });
  });

  test("no provider catalog means no provider: a required operation is never bound by omission", () => {
    expect(failureOf(() => resolveWith([opsBytes], [ops]))).toMatchObject({
      code: "missing_required_capability_provider",
    });
    expect(
      failureOf(() => resolveWith([opsBytes], [ops], { list: () => [] })),
    ).toMatchObject({ code: "missing_required_capability_provider" });
  });

  test("a mode mismatch fails with capability_provider_mismatch, for a required and for an optional operation", () => {
    for (const requirement of ["required", "optional"]) {
      const mismatch = packBytes("org.example.mode", {
        capabilities: [
          {
            id: "peek",
            requirement,
            operations: [{ operation: "fake.write", mode: "read" }],
          },
        ],
      });
      expect(
        failureOf(() =>
          resolveWith([mismatch], [identityOf(mismatch)], fakeProviders),
        ),
        requirement,
      ).toEqual({
        code: "capability_provider_mismatch",
        message:
          "Pack org.example.mode@1.0.0 capability capabilities/peek declares operation fake.write in a mode that differs from its registered provider",
      });
    }
  });

  test("the diagnostic names only the pack, the capability and the operation", () => {
    const failure = failureOf(() =>
      resolveWith([missing], [identityOf(missing)], {
        list: () => [
          {
            id: "secret-connector",
            version: "9.9.9-internal",
            operations: [{ operation: "secret-connector.x", mode: "read" }],
          },
        ],
      }),
    );
    expect(failure).toMatchObject({ message: missingMessage });
    expect(JSON.stringify(failure)).not.toMatch(/secret-connector|9\.9\.9/u);
  });

  test("covers transitive dependencies and capabilities no role references", () => {
    // The dependency is never selected and no role names its capability.
    const dependent = packBytes(
      "org.example.dependent",
      { prompts: [{ id: "greeting" }] },
      [identityOf(missing)],
    );
    expect(
      failureOf(() =>
        resolveWith(
          [missing, dependent],
          [identityOf(dependent)],
          fakeProviders,
        ),
      ),
    ).toEqual({
      code: "missing_required_capability_provider",
      message: missingMessage,
    });
  });

  test("a disabled role or agent does not hide a required operation", () => {
    const staffed = packBytes("org.example.staffed", {
      roles: [{ id: "merger", capabilities: ["merge"] }],
      agents: [{ id: "bot", role: "merger", capabilities: ["merge"] }],
      capabilities: [
        {
          id: "merge",
          operations: [{ operation: "github.merge_pr", mode: "mutation" }],
        },
      ],
    });
    const pack = identityOf(staffed);
    const disable = (kind: "roles" | "agents", localId: string) => ({
      origin: "project_override" as const,
      source: { ...pack, kind, localId },
      operation: "disable" as const,
      revision: 1,
      actorId: "operator",
      changedAt: "2026-10-06T00:00:00.000Z",
    });
    const definitions = {
      projectId: "project-a",
      revision: 2,
      owned: [],
      overrides: [disable("agents", "bot"), disable("roles", "merger")],
    } as ProjectDefinitionState;
    expect(
      failureOf(() =>
        resolveWith([staffed], [pack], fakeProviders, definitions),
      ),
    ).toMatchObject({ code: "missing_required_capability_provider" });
  });

  test("a provider catalog that throws yields a typed failure, never a bound view", () => {
    for (const list of [
      () => {
        throw new Error("registry exploded: token=hunter2");
      },
      () => {
        throw "not an error";
      },
      () => null as never,
      () => [{ id: "fake", version: "1" }] as never,
    ]) {
      const failure = failureOf(() => resolveWith([opsBytes], [ops], { list }));
      expect(failure).toEqual({
        code: "configuration_invariant",
        message: "Operation provider catalog could not be read",
      });
    }
  });

  test("an operation listed by two providers is refused rather than bound to either", () => {
    expect(
      failureOf(() =>
        resolveWith([opsBytes], [ops], {
          list: () => [
            ...fakeProviders.list(),
            {
              id: "shadow",
              version: "1",
              operations: [{ operation: "fake.write", mode: "mutation" }],
            },
          ],
        }),
      ),
    ).toEqual({
      code: "configuration_invariant",
      message: "Operation provider catalog lists an operation more than once",
    });
  });

  test("a hand-edited installed artifact cannot make an unregistered operation appear bound or relax a requirement", () => {
    const catalog = installed(missing);
    const original = catalog.read(
      identityOf(missing).id,
      identityOf(missing).version,
    )!;
    const edited = encoder.encode(
      new TextDecoder()
        .decode(original.bytes)
        .replace("github.merge_pr", "fake.write"),
    );
    expect(edited).not.toEqual(original.bytes);
    // The edit keeps the declared digest, as an on-disk edit would.
    const tampered = {
      coreContractVersion: 1,
      list: () => catalog.list(),
      trusts: () => true,
      read: () => ({ ...original, bytes: edited }),
    };
    const failure = failureOf(() =>
      resolveProjectConfiguration({
        projectId: "project-a",
        binding: {
          projectId: "project-a",
          configurationRevision: 1,
          packs: [identityOf(missing)],
        },
        definitions: emptyState,
        catalog: tampered,
        coreContractVersion: 1,
        providers: fakeProviders,
      }),
    );
    expect(failure).not.toBe("resolved");
    expect(failure).toMatchObject({ code: "pack_unavailable" });
  });

  test("stored project state cannot own, override or disable a capability to hide its requirement", () => {
    const pack = identityOf(missing);
    const owned = {
      projectId: "project-a",
      revision: 1,
      owned: [
        {
          origin: "project_owned",
          kind: "capabilities",
          id: "merge",
          revision: 1,
          enabled: true,
          payload: {
            id: "merge",
            operations: [{ operation: "fake.write", mode: "mutation" }],
          },
          actorId: "operator",
          changedAt: "2026-10-06T00:00:00.000Z",
        },
      ],
      overrides: [],
    } as unknown as ProjectDefinitionState;
    expect(
      failureOf(() => resolveWith([missing], [pack], fakeProviders, owned)),
    ).toMatchObject({ code: "unsupported_security_composition" });
    for (const operation of ["disable", "replace", "extend"]) {
      const overridden = {
        projectId: "project-a",
        revision: 1,
        owned: [],
        overrides: [
          {
            origin: "project_override",
            source: { ...pack, kind: "capabilities", localId: "merge" },
            operation,
            ...(operation === "disable"
              ? {}
              : { payload: { id: "merge", requirement: "optional" } }),
            revision: 1,
            actorId: "operator",
            changedAt: "2026-10-06T00:00:00.000Z",
          },
        ],
      } as unknown as ProjectDefinitionState;
      expect(
        failureOf(() =>
          resolveWith([missing], [pack], fakeProviders, overridden),
        ),
        operation,
      ).toMatchObject({ code: "unresolved_override" });
    }
  });
});

// --- Architecture ---------------------------------------------------------

function typescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...typescriptFiles(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("GP-16 boundaries", () => {
  const source = (path: string) =>
    readFileSync(join(repositoryRoot, path), "utf8");

  test("the resolver, the binding rules and the port import no connector package", () => {
    for (const path of [
      "packages/application/src/domain-pack/resolve-project-configuration.ts",
      "packages/application/src/domain-pack/capability-contracts.ts",
      "packages/application/src/ports/operation-provider-catalog.port.ts",
      "packages/domain-pack-contracts/src/manifest.ts",
    ])
      expect(source(path), path).not.toMatch(
        /connector-sdk|filesystem-connector|ConnectorRegistry|domain\/src\/capability|@ai-office\/domain\/capability/u,
      );
  });

  test("no scheduler, run, pipeline, policy or controlled-action module reads the provider binding", () => {
    const pattern =
      /OperationProviderCatalog|operation-provider-catalog|operationProviders|capability-contracts|missing_required_capability_provider|capability_provider_mismatch/u;
    const guarded = [
      "packages/application/src/runtime",
      "packages/application/src/pipeline",
      "packages/application/src/capability",
      "packages/application/src/commands",
      "packages/application/src/project-portability",
      "packages/domain/src",
      "packages/agent-runtime/src",
      "packages/orchestration/src",
      "packages/connector-sdk/src",
      "packages/filesystem-connector/src",
      "packages/storage-sqlite/src",
      "packages/storage-postgres/src",
    ].flatMap((directory) => typescriptFiles(join(repositoryRoot, directory)));
    expect(guarded.length).toBeGreaterThan(100);
    expect(
      guarded.filter((file) => pattern.test(readFileSync(file, "utf8"))),
    ).toEqual([]);
  });

  test("only the pack commands of the Runtime host receive the provider catalog", () => {
    const users = typescriptFiles(
      join(repositoryRoot, "packages/runtime-host/src"),
    )
      .filter((file) => /operationProviders/u.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(repositoryRoot.length + 1))
      .sort();
    expect(users).toEqual([
      "packages/runtime-host/src/commands/project-configuration.ts",
      "packages/runtime-host/src/commands/project-pack.ts",
      "packages/runtime-host/src/commands/shared.ts",
      "packages/runtime-host/src/runtime-command.ts",
    ]);
  });

  test("GP-16 adds no migration", () => {
    const names = (directory: string) =>
      readdirSync(join(repositoryRoot, directory)).filter((name) =>
        /capability[-_]contract|operation[-_]provider/iu.test(name),
      );
    expect(names("migrations/project")).toEqual([]);
    expect(names("supabase/migrations")).toEqual([]);
  });
});

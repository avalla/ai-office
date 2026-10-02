import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
  type ArtifactDigest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import {
  DomainPackCatalogError,
  type InstalledDomainPackCatalog,
  type PackIdentity,
} from "../../packages/application/src/ports/installed-domain-pack-catalog.port.ts";
import { resolveInstalledPacks } from "../../packages/application/src/domain-pack/resolve-installed-packs.ts";
import { resolveVerifiedPackClosure } from "../../packages/application/src/domain-pack/internal/verified-pack-closure.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";

const encoder = new TextEncoder();
const placeholder = `sha256:${"0".repeat(64)}`;
const provenance = {
  installerId: "local-distribution",
  reference: "bundled/test",
};
const sections = {
  roles: [],
  taskTypes: [],
  workflows: [],
  agents: [],
  artifactTypes: [],
  evidenceTypes: [],
  policies: [],
  knowledge: [],
  capabilities: [],
  prompts: [],
  validators: [],
};

function pack(
  id: string,
  version = "1.0.0",
  dependencies: readonly PackIdentity[] = [],
  coreContract = { minInclusive: 1, maxExclusive: 2 },
): Uint8Array {
  const value = {
    schemaVersion: 1,
    id,
    version,
    manifestDigest: placeholder,
    coreContract,
    metadata: { name: id, description: "Catalog fixture" },
    dependencies,
    contributions: sections,
  };
  value.manifestDigest = computeManifestDigest(
    parseDomainPackManifest(encoder.encode(JSON.stringify(value))),
  );
  return encoder.encode(JSON.stringify(value));
}

function identity(bytes: Uint8Array): PackIdentity {
  const { id, version, manifestDigest } = parseDomainPackManifest(bytes);
  return { id, version, manifestDigest };
}

function catalog(): InMemoryInstalledDomainPackCatalog {
  return new InMemoryInstalledDomainPackCatalog(1, [provenance.installerId]);
}

function register(
  target: InMemoryInstalledDomainPackCatalog,
  bytes: Uint8Array,
): PackIdentity {
  return target.register({
    bytes,
    artifactDigest: computeArtifactDigest(bytes),
    provenance,
  });
}

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainPackCatalogError);
    return (error as DomainPackCatalogError).code;
  }
  throw new Error("expected catalog error");
}

describe("host-local installed Domain Pack catalog", () => {
  test.each([
    ["development", "org.ai-office.development"],
    ["legal", "org.example.legal"],
    ["manufacturing", "org.example.manufacturing"],
    ["custom", "org.example.custom"],
  ])(
    "registers and resolves the %s GP-03 fixture without domain-specific logic",
    (file, id) => {
      const bytes = readFileSync(
        new URL(`../fixtures/domain-pack/${file}.json`, import.meta.url),
      );
      const target = catalog();
      const requested = register(target, bytes);
      const result = resolveInstalledPacks(target, [requested]);
      expect(result).toEqual([
        {
          identity: requested,
          schemaVersion: 1,
          coreContract: parseDomainPackManifest(bytes).coreContract,
          artifactDigest: computeArtifactDigest(bytes),
          provenance,
          dependencies: [],
        },
      ]);
      expect(result[0]?.identity.id).toBe(id);
    },
  );

  test("resolves exact multi-level dependencies and independent roots in canonical ID order", () => {
    const leaf = pack("org.example.leaf");
    const middle = pack("org.example.middle", "1.0.0", [identity(leaf)]);
    const top = pack("org.example.top", "1.0.0", [identity(middle)]);
    const other = pack("org.example.alpha");
    const target = catalog();
    for (const bytes of [top, leaf, other, middle]) register(target, bytes);
    const result = resolveInstalledPacks(target, [
      identity(top),
      identity(other),
    ]);
    expect(result.map((entry) => entry.identity.id)).toEqual([
      "org.example.alpha",
      "org.example.leaf",
      "org.example.middle",
      "org.example.top",
    ]);
    expect(result.at(-1)?.dependencies).toEqual([identity(middle)]);
  });

  test("resolution is identical across registration and request orders", () => {
    const one = pack("org.example.one");
    const two = pack("org.example.two", "1.0.0", [identity(one)]);
    const three = pack("org.example.three");
    const first = catalog();
    const second = catalog();
    for (const bytes of [one, two, three]) register(first, bytes);
    for (const bytes of [three, two, one]) register(second, bytes);
    expect(
      resolveInstalledPacks(first, [identity(two), identity(three)]),
    ).toEqual(resolveInstalledPacks(second, [identity(three), identity(two)]));
    expect(first.list()).toEqual(second.list());
  });

  test("three roots and shared multilevel dependencies resolve in canonical order", () => {
    const leaf = pack("org.example.leaf");
    const shared = pack("org.example.shared", "1.0.0", [identity(leaf)]);
    const extra = pack("org.example.extra");
    const alpha = pack("org.example.alpha", "1.0.0", [
      identity(shared),
      identity(extra),
    ]);
    const beta = pack("org.example.beta", "1.0.0", [identity(shared)]);
    const gamma = pack("org.example.gamma", "1.0.0", [
      identity(extra),
      identity(shared),
    ]);
    const first = catalog();
    const second = catalog();
    for (const bytes of [gamma, leaf, alpha, extra, beta, shared])
      register(first, bytes);
    for (const bytes of [shared, beta, extra, alpha, leaf, gamma])
      register(second, bytes);
    const left = resolveInstalledPacks(first, [
      identity(gamma),
      identity(alpha),
      identity(beta),
    ]);
    const right = resolveInstalledPacks(second, [
      identity(beta),
      identity(gamma),
      identity(alpha),
    ]);
    expect(left).toEqual(right);
    expect(left.map((entry) => entry.identity.id)).toEqual([
      "org.example.alpha",
      "org.example.beta",
      "org.example.extra",
      "org.example.gamma",
      "org.example.leaf",
      "org.example.shared",
    ]);
    expect(left[0]?.dependencies).toEqual([identity(extra), identity(shared)]);
    expect(left[3]?.dependencies).toEqual([identity(extra), identity(shared)]);

    const reordered = pack("org.example.gamma", "1.0.0", [
      identity(shared),
      identity(extra),
    ]);
    expect(identity(reordered)).toEqual(identity(gamma));
    const third = catalog();
    for (const bytes of [leaf, shared, extra, alpha, beta, reordered])
      register(third, bytes);
    const result = resolveInstalledPacks(third, [
      identity(beta),
      identity(alpha),
      identity(reordered),
    ]);
    expect(result.map((entry) => entry.identity)).toEqual(
      left.map((entry) => entry.identity),
    );
    expect(result[3]?.dependencies).toEqual(left[3]?.dependencies);
    expect(result[3]?.artifactDigest).not.toBe(left[3]?.artifactDigest);
  });

  test("identical registration is idempotent and caller byte mutation cannot change the catalog", () => {
    const bytes = pack("org.example.immutable");
    const target = catalog();
    const requested = register(target, bytes);
    expect(register(target, bytes)).toEqual(requested);
    expect(target.list().map((entry) => entry.identity)).toEqual([requested]);
    bytes[0] = 0;
    const read = target.read(requested.id, requested.version);
    expect(read?.artifactDigest).toBe(computeArtifactDigest(read!.bytes));
    read!.bytes[0] = 0;
    expect(resolveInstalledPacks(target, [requested])).toHaveLength(1);
  });

  test("catalog and resolved values do not expose mutable registration state", () => {
    const trusted = [provenance.installerId];
    const target = new InMemoryInstalledDomainPackCatalog(1, trusted);
    trusted.push("untrusted-added-later");
    expect(
      target.trusts({ installerId: "untrusted-added-later", reference: "x" }),
    ).toBe(false);
    expect(Reflect.set(target, "coreContractVersion", 3)).toBe(false);
    expect(target.coreContractVersion).toBe(1);

    const leaf = pack("org.example.copy-leaf");
    const root = pack("org.example.copy-root", "1.0.0", [identity(leaf)]);
    register(target, leaf);
    const submittedProvenance = { ...provenance };
    const requested = target.register({
      bytes: root,
      artifactDigest: computeArtifactDigest(root),
      provenance: submittedProvenance,
    });
    submittedProvenance.installerId = "untrusted-added-later";
    submittedProvenance.reference = "changed";
    const read = target.read(requested.id, requested.version)!;
    Reflect.set(read.identity, "id", "org.example.changed");
    Reflect.set(read.coreContract, "minInclusive", 99);
    Reflect.set(read.provenance, "installerId", "untrusted-added-later");
    read.bytes[0] = 0;
    const listed = target
      .list()
      .find((entry) => entry.identity.id === requested.id)!;
    Reflect.set(listed.identity, "version", "9.0.0");
    Reflect.set(listed.coreContract, "maxExclusive", 99);
    Reflect.set(listed.provenance, "reference", "changed");
    const resolved = resolveInstalledPacks(target, [requested]);
    const rootResult = resolved.find(
      (entry) => entry.identity.id === requested.id,
    )!;
    expect(rootResult.provenance).toEqual(provenance);
    expect(rootResult.coreContract).toEqual({
      minInclusive: 1,
      maxExclusive: 2,
    });
    expect(rootResult.dependencies).toEqual([identity(leaf)]);
    Reflect.set(rootResult.dependencies[0]!, "id", "org.example.changed");
    (rootResult.dependencies as PackIdentity[]).push(requested);
    expect(
      resolveInstalledPacks(target, [requested]).find(
        (entry) => entry.identity.id === requested.id,
      )?.dependencies,
    ).toEqual([identity(leaf)]);
  });

  test("accepts an interval containing the current core contract version", () => {
    const bytes = pack("org.example.compatible", "1.0.0", [], {
      minInclusive: 1,
      maxExclusive: 3,
    });
    const target = catalog();
    const requested = register(target, bytes);
    expect(resolveInstalledPacks(target, [requested])).toHaveLength(1);
    const incompatible = new InMemoryInstalledDomainPackCatalog(3, [
      provenance.installerId,
    ]);
    expect(code(() => register(incompatible, bytes))).toBe(
      "incompatible_core_contract",
    );
  });

  test("rejects missing roots and exact dependencies", () => {
    const target = catalog();
    const missing = identity(pack("org.example.missing"));
    expect(code(() => resolveInstalledPacks(target, [missing]))).toBe(
      "missing_pack",
    );
    const root = pack("org.example.root", "1.0.0", [missing]);
    register(target, root);
    expect(code(() => resolveInstalledPacks(target, [identity(root)]))).toBe(
      "missing_dependency",
    );
  });

  test("rejects requested and dependency manifest digest mismatches", () => {
    const dep = pack("org.example.dep");
    const target = catalog();
    register(target, dep);
    const wrong = {
      ...identity(dep),
      manifestDigest: placeholder as PackIdentity["manifestDigest"],
    };
    expect(code(() => resolveInstalledPacks(target, [wrong]))).toBe(
      "manifest_digest_mismatch",
    );
    const root = pack("org.example.root", "1.0.0", [wrong]);
    register(target, root);
    expect(code(() => resolveInstalledPacks(target, [identity(root)]))).toBe(
      "dependency_digest_mismatch",
    );
  });

  test("rejects wrong exact-byte artifact digest and declared manifest digest", () => {
    const bytes = pack("org.example.digests");
    const target = catalog();
    expect(
      code(() =>
        target.register({
          bytes,
          artifactDigest: placeholder as ArtifactDigest,
          provenance,
        }),
      ),
    ).toBe("artifact_digest_mismatch");
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    value.metadata = { name: "changed", description: "Catalog fixture" };
    const changed = encoder.encode(JSON.stringify(value));
    expect(code(() => register(target, changed))).toBe(
      "manifest_digest_mismatch",
    );
  });

  test("rejects conflicting ID/version registrations, including different artifact bytes", () => {
    const target = catalog();
    const first = pack("org.example.conflict");
    register(target, first);
    const second = pack("org.example.conflict", "1.0.0", [], {
      minInclusive: 1,
      maxExclusive: 3,
    });
    expect(code(() => register(target, second))).toBe("duplicate_conflict");
    const respace = encoder.encode(
      new TextDecoder()
        .decode(first)
        .replace('"schemaVersion":1', '"schemaVersion": 1'),
    );
    expect(identity(respace).manifestDigest).toBe(
      identity(first).manifestDigest,
    );
    expect(computeArtifactDigest(respace)).not.toBe(
      computeArtifactDigest(first),
    );
    expect(code(() => register(target, respace))).toBe("duplicate_conflict");
    expect(
      code(() =>
        target.register({
          bytes: first,
          artifactDigest: computeArtifactDigest(first),
          provenance: { ...provenance, reference: "another-install" },
        }),
      ),
    ).toBe("duplicate_conflict");
  });

  test("rejects two versions of one pack ID in one closure", () => {
    const target = catalog();
    const old = pack("org.example.shared", "1.0.0");
    const newer = pack("org.example.shared", "2.0.0");
    const left = pack("org.example.left", "1.0.0", [identity(old)]);
    const right = pack("org.example.right", "1.0.0", [identity(newer)]);
    for (const bytes of [old, newer, left, right]) register(target, bytes);
    expect(
      code(() =>
        resolveInstalledPacks(target, [identity(right), identity(left)]),
      ),
    ).toBe("version_conflict");
  });

  test("deduplicates identical roots and rejects conflicting root identities in either order", () => {
    const target = catalog();
    const old = pack("org.example.root", "1.0.0");
    const newer = pack("org.example.root", "2.0.0");
    register(target, old);
    register(target, newer);
    const oldIdentity = identity(old);
    expect(resolveInstalledPacks(target, [oldIdentity, oldIdentity])).toEqual(
      resolveInstalledPacks(target, [oldIdentity]),
    );
    const wrongDigest = {
      ...oldIdentity,
      manifestDigest: placeholder as PackIdentity["manifestDigest"],
    };
    for (const roots of [
      [oldIdentity, identity(newer)],
      [identity(newer), oldIdentity],
      [oldIdentity, wrongDigest],
      [wrongDigest, oldIdentity],
    ])
      expect(code(() => resolveInstalledPacks(target, roots))).toBe(
        "version_conflict",
      );
  });

  test("defensive graph guard rejects a synthetic cycle of already verified entries", () => {
    // A valid content-addressed cycle would require a SHA-256 fixed point.
    // Exercise the graph guard with synthetic already-verified entries.
    const aBytes = pack("org.example.cycle-a");
    const bBytes = pack("org.example.cycle-b");
    const a = identity(aBytes);
    const b = identity(bBytes);
    const graph = new Map([
      [
        a.id,
        {
          identity: a,
          schemaVersion: 1 as const,
          coreContract: { minInclusive: 1, maxExclusive: 2 },
          artifactDigest: computeArtifactDigest(aBytes),
          provenance,
          dependencies: [b],
        },
      ],
      [
        b.id,
        {
          identity: b,
          schemaVersion: 1 as const,
          coreContract: { minInclusive: 1, maxExclusive: 2 },
          artifactDigest: computeArtifactDigest(bBytes),
          provenance,
          dependencies: [a],
        },
      ],
    ]);
    expect(
      code(() => resolveVerifiedPackClosure([a], (id) => graph.get(id))),
    ).toBe("dependency_cycle");
  });

  test("rejects unsupported schema, incompatible core, malformed dependencies and untrusted provenance", () => {
    const target = catalog();
    const bytes = pack("org.example.invalid");
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    value.schemaVersion = 2;
    const unsupported = encoder.encode(JSON.stringify(value));
    expect(code(() => register(target, unsupported))).toBe(
      "unsupported_schema",
    );
    expect(
      code(() =>
        register(
          target,
          pack("org.example.future", "1.0.0", [], {
            minInclusive: 2,
            maxExclusive: 3,
          }),
        ),
      ),
    ).toBe("incompatible_core_contract");
    value.schemaVersion = 1;
    value.dependencies = [
      { id: "org.example.dep", version: "latest", manifestDigest: placeholder },
    ];
    expect(
      code(() => register(target, encoder.encode(JSON.stringify(value)))),
    ).toBe("malformed_dependency_graph");
    expect(
      code(() =>
        target.register({
          bytes,
          artifactDigest: computeArtifactDigest(bytes),
          provenance: { installerId: "unknown", reference: "local/test" },
        }),
      ),
    ).toBe("untrusted_provenance");
    for (const reference of ["", "line\nbreak", "x".repeat(513)])
      expect(
        code(() =>
          target.register({
            bytes,
            artifactDigest: computeArtifactDigest(bytes),
            provenance: { installerId: provenance.installerId, reference },
          }),
        ),
      ).toBe("untrusted_provenance");
    value.dependencies = [];
    value.installerId = provenance.installerId;
    expect(
      code(() => register(target, encoder.encode(JSON.stringify(value)))),
    ).toBe("malformed_catalog_entry");
    expect(target.list()).toEqual([]);
  });

  test("fails closed if a catalog adapter supplies corrupt bytes or untrusted provenance", () => {
    const bytes = pack("org.example.read");
    const requested = identity(bytes);
    const target = catalog();
    register(target, bytes);
    const good = target.read(requested.id, requested.version)!;
    const corrupt: InstalledDomainPackCatalog = {
      coreContractVersion: 1,
      read: () => ({ ...good, artifactDigest: placeholder as ArtifactDigest }),
      list: () => [],
      trusts: () => true,
    };
    expect(code(() => resolveInstalledPacks(corrupt, [requested]))).toBe(
      "artifact_digest_mismatch",
    );
    const untrusted: InstalledDomainPackCatalog = {
      coreContractVersion: 1,
      read: () => good,
      list: () => [],
      trusts: () => false,
    };
    expect(code(() => resolveInstalledPacks(untrusted, [requested]))).toBe(
      "untrusted_provenance",
    );
    const wrongDescriptor: InstalledDomainPackCatalog = {
      coreContractVersion: 1,
      read: () => ({
        ...good,
        coreContract: { minInclusive: 0, maxExclusive: 2 },
      }),
      list: () => [],
      trusts: () => true,
    };
    expect(
      code(() => resolveInstalledPacks(wrongDescriptor, [requested])),
    ).toBe("malformed_catalog_entry");
    const incompatibleCore: InstalledDomainPackCatalog = {
      ...untrusted,
      coreContractVersion: 2,
      trusts: () => true,
    };
    expect(
      code(() => resolveInstalledPacks(incompatibleCore, [requested])),
    ).toBe("incompatible_core_contract");
  });

  test("rejects malformed explicit requests without fallback selection", () => {
    const target = catalog();
    expect(resolveInstalledPacks(target, [])).toEqual([]);
    expect(
      code(() =>
        resolveInstalledPacks(target, [
          {
            id: "bad",
            version: "latest",
            manifestDigest: placeholder,
          } as PackIdentity,
        ]),
      ),
    ).toBe("malformed_request");
  });
});

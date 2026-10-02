import {
  checkCoreContract,
  computeArtifactDigest,
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
  verifyDomainPackManifest,
  DomainPackManifestError,
} from "../../../domain-pack-contracts/src/index.ts";
import type {
  DomainPackId,
  DomainPackVersion,
} from "../../../domain-pack-contracts/src/index.ts";
import {
  DomainPackCatalogError,
  type DomainPackCatalogErrorCode,
  type InstalledDomainPackCatalog,
  type PackIdentity,
  type ResolvedInstalledPack,
} from "../ports/installed-domain-pack-catalog.port.ts";

function compareIdentity(a: PackIdentity, b: PackIdentity): number {
  for (const field of ["id", "version", "manifestDigest"] as const) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  return 0;
}

function identityKey(identity: PackIdentity): string {
  return `${identity.id}\u0000${identity.version}\u0000${identity.manifestDigest}`;
}

function manifestError(error: DomainPackManifestError): DomainPackCatalogError {
  const code: DomainPackCatalogErrorCode =
    error.code === "unsupported_schema"
      ? "unsupported_schema"
      : error.code === "digest_mismatch"
        ? "manifest_digest_mismatch"
        : error.code === "incompatible_core_contract"
          ? "incompatible_core_contract"
          : error.code === "invalid_dependency"
            ? "malformed_dependency_graph"
            : "malformed_catalog_entry";
  return new DomainPackCatalogError(
    code,
    `Installed pack manifest: ${error.message}`,
  );
}

/** Graph walk over already verified entries; kept separate so cycles can be tested without forging hash fixed points. */
export function resolveVerifiedPackClosure(
  requested: readonly PackIdentity[],
  load: (
    id: DomainPackId,
    version: DomainPackVersion,
  ) => ResolvedInstalledPack | undefined,
): readonly ResolvedInstalledPack[] {
  const selectedById = new Map<string, PackIdentity>();
  const visiting = new Set<string>();
  const resolved = new Map<string, ResolvedInstalledPack>();

  function visit(identity: PackIdentity, parent?: PackIdentity): void {
    const previous = selectedById.get(identity.id);
    if (previous && identityKey(previous) !== identityKey(identity))
      throw new DomainPackCatalogError(
        "version_conflict",
        `Conflicting identities for pack ${identity.id}`,
      );
    selectedById.set(identity.id, identity);

    const key = identityKey(identity);
    if (visiting.has(key))
      throw new DomainPackCatalogError(
        "dependency_cycle",
        `Dependency cycle includes ${identity.id}@${identity.version}`,
      );
    if (resolved.has(key)) return;

    const entry = load(identity.id, identity.version);
    if (!entry)
      throw new DomainPackCatalogError(
        parent ? "missing_dependency" : "missing_pack",
        `Pack ${identity.id}@${identity.version} is not installed`,
      );
    if (
      entry.identity.id !== identity.id ||
      entry.identity.version !== identity.version
    )
      throw new DomainPackCatalogError(
        "malformed_catalog_entry",
        `Catalog entry for ${identity.id}@${identity.version} contains a different pack`,
      );
    if (entry.identity.manifestDigest !== identity.manifestDigest)
      throw new DomainPackCatalogError(
        parent ? "dependency_digest_mismatch" : "manifest_digest_mismatch",
        `Pack ${identity.id}@${identity.version} has a different manifest digest`,
      );

    visiting.add(key);
    const dependencies = [...entry.dependencies].sort(compareIdentity);
    for (const dependency of dependencies) visit(dependency, identity);
    visiting.delete(key);
    resolved.set(key, { ...entry, dependencies });
  }

  for (const root of [...requested].sort(compareIdentity)) visit(root);
  return [...resolved.values()].sort((a, b) =>
    compareIdentity(a.identity, b.identity),
  );
}

/** Resolves availability only. It cannot select or mutate a project's packs. */
export function resolveInstalledPacks(
  catalog: InstalledDomainPackCatalog,
  requested: readonly PackIdentity[],
  coreContractVersion: number,
): readonly ResolvedInstalledPack[] {
  if (
    !Array.isArray(requested) ||
    !Number.isSafeInteger(coreContractVersion) ||
    coreContractVersion < 0
  )
    throw new DomainPackCatalogError(
      "malformed_request",
      "Expected explicit pack tuples and a nonnegative core contract version",
    );

  let roots: PackIdentity[];
  try {
    roots = requested.map((entry) => ({
      id: parseDomainPackId(entry?.id),
      version: parseDomainPackVersion(entry?.version),
      manifestDigest: parseManifestDigest(entry?.manifestDigest),
    }));
  } catch (error) {
    if (error instanceof DomainPackManifestError)
      throw new DomainPackCatalogError(
        "malformed_request",
        `Requested pack: ${error.message}`,
      );
    throw error;
  }
  return resolveVerifiedPackClosure(roots, (id, version) => {
    const artifact = catalog.read(id, version);
    if (!artifact) return undefined;
    if (!catalog.trusts(artifact.provenance))
      throw new DomainPackCatalogError(
        "untrusted_provenance",
        `Pack ${id}@${version} has no trusted installation provenance`,
      );
    if (
      !(artifact.bytes instanceof Uint8Array) ||
      computeArtifactDigest(artifact.bytes) !== artifact.artifactDigest
    )
      throw new DomainPackCatalogError(
        "artifact_digest_mismatch",
        `Installed artifact for ${id}@${version} differs from its digest`,
      );

    let manifest;
    try {
      manifest = verifyDomainPackManifest(artifact.bytes);
      checkCoreContract(manifest.coreContract, coreContractVersion);
    } catch (error) {
      if (error instanceof DomainPackManifestError) throw manifestError(error);
      throw error;
    }
    if (
      artifact.identity?.id !== manifest.id ||
      artifact.identity?.version !== manifest.version ||
      artifact.identity?.manifestDigest !== manifest.manifestDigest ||
      artifact.schemaVersion !== manifest.schemaVersion ||
      artifact.coreContract?.minInclusive !==
        manifest.coreContract.minInclusive ||
      artifact.coreContract?.maxExclusive !== manifest.coreContract.maxExclusive
    )
      throw new DomainPackCatalogError(
        "malformed_catalog_entry",
        `Catalog descriptor for ${id}@${version} differs from its verified manifest`,
      );
    return {
      identity: {
        id: manifest.id,
        version: manifest.version,
        manifestDigest: manifest.manifestDigest,
      },
      schemaVersion: manifest.schemaVersion,
      coreContract: { ...manifest.coreContract },
      artifactDigest: artifact.artifactDigest,
      provenance: { ...artifact.provenance },
      dependencies: manifest.dependencies,
    };
  });
}

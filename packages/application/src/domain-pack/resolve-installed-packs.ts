import {
  checkCoreContract,
  computeArtifactDigest,
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
  verifyDomainPackManifest,
  DomainPackManifestError,
} from "../../../domain-pack-contracts/src/index.ts";
import {
  DomainPackCatalogError,
  type DomainPackCatalogErrorCode,
  type InstalledDomainPackCatalog,
  type PackIdentity,
  type ResolvedInstalledPack,
} from "../ports/installed-domain-pack-catalog.port.ts";
import { resolveVerifiedPackClosure } from "./internal/verified-pack-closure.ts";

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

/** Resolves availability only. It cannot select or mutate a project's packs. */
export function resolveInstalledPacks(
  catalog: InstalledDomainPackCatalog,
  requested: readonly PackIdentity[],
): readonly ResolvedInstalledPack[] {
  const coreContractVersion = catalog.coreContractVersion;
  if (
    !Array.isArray(requested) ||
    !Number.isSafeInteger(coreContractVersion) ||
    coreContractVersion < 0
  )
    throw new DomainPackCatalogError(
      "malformed_request",
      "Expected explicit pack tuples and a trusted nonnegative core contract version",
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

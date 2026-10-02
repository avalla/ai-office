import {
  computeArtifactDigest,
  parseArtifactDigest,
  verifyDomainPackManifest,
  DomainPackManifestError,
} from "../../domain-pack-contracts/src/index.ts";
import type {
  ArtifactDigest,
  DomainPackId,
  DomainPackVersion,
} from "../../domain-pack-contracts/src/index.ts";
import {
  DomainPackCatalogError,
  type InstalledDomainPackCatalog,
  type InstalledPackArtifact,
  type InstalledPackDescriptor,
  type PackIdentity,
  type TrustedPackProvenance,
} from "../../application/src/ports/installed-domain-pack-catalog.port.ts";

export interface PackRegistration {
  readonly bytes: Uint8Array;
  readonly artifactDigest: ArtifactDigest;
  readonly provenance: TrustedPackProvenance;
}

function key(id: DomainPackId, version: DomainPackVersion): string {
  return `${id}\u0000${version}`;
}

function validProvenance(provenance: TrustedPackProvenance): boolean {
  return (
    provenance !== null &&
    typeof provenance === "object" &&
    typeof provenance.installerId === "string" &&
    /^[a-z][a-z0-9._-]*$/.test(provenance.installerId) &&
    typeof provenance.reference === "string" &&
    provenance.reference.length > 0 &&
    provenance.reference.length <= 512 &&
    !Array.from(provenance.reference).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

/** Deployment-local in-memory adapter. Trusted installer IDs come from host composition. */
export class InMemoryInstalledDomainPackCatalog implements InstalledDomainPackCatalog {
  private readonly trustedInstallerIds: ReadonlySet<string>;
  private readonly entries = new Map<string, InstalledPackArtifact>();
  readonly #coreContractVersion: number;

  constructor(
    coreContractVersion: number,
    trustedInstallerIds: readonly string[],
  ) {
    if (!Number.isSafeInteger(coreContractVersion) || coreContractVersion < 0)
      throw new DomainPackCatalogError(
        "malformed_request",
        "Invalid core contract version",
      );
    this.trustedInstallerIds = new Set(trustedInstallerIds);
    this.#coreContractVersion = coreContractVersion;
  }

  get coreContractVersion(): number {
    return this.#coreContractVersion;
  }

  trusts(provenance: TrustedPackProvenance): boolean {
    return (
      validProvenance(provenance) &&
      this.trustedInstallerIds.has(provenance.installerId)
    );
  }

  register(registration: PackRegistration): PackIdentity {
    if (!this.trusts(registration.provenance))
      throw new DomainPackCatalogError(
        "untrusted_provenance",
        "Pack installation provenance is not trusted",
      );
    if (!(registration.bytes instanceof Uint8Array))
      throw new DomainPackCatalogError(
        "malformed_catalog_entry",
        "Expected exact UTF-8 manifest bytes",
      );

    let declaredArtifactDigest: ArtifactDigest;
    try {
      declaredArtifactDigest = parseArtifactDigest(registration.artifactDigest);
    } catch (error) {
      if (error instanceof DomainPackManifestError)
        throw new DomainPackCatalogError(
          "artifact_digest_mismatch",
          "Invalid artifact digest declaration",
        );
      throw error;
    }
    const bytes = new Uint8Array(registration.bytes);
    if (computeArtifactDigest(bytes) !== declaredArtifactDigest)
      throw new DomainPackCatalogError(
        "artifact_digest_mismatch",
        "Installed artifact differs from its declared digest",
      );

    let manifest;
    try {
      manifest = verifyDomainPackManifest(bytes, this.coreContractVersion);
    } catch (error) {
      if (error instanceof DomainPackManifestError) {
        const code =
          error.code === "unsupported_schema"
            ? "unsupported_schema"
            : error.code === "digest_mismatch"
              ? "manifest_digest_mismatch"
              : error.code === "incompatible_core_contract"
                ? "incompatible_core_contract"
                : error.code === "invalid_dependency"
                  ? "malformed_dependency_graph"
                  : "malformed_catalog_entry";
        throw new DomainPackCatalogError(
          code,
          `Pack registration: ${error.message}`,
        );
      }
      throw error;
    }

    const identity: PackIdentity = {
      id: manifest.id,
      version: manifest.version,
      manifestDigest: manifest.manifestDigest,
    };
    const entryKey = key(identity.id, identity.version);
    const prior = this.entries.get(entryKey);
    if (prior) {
      const same =
        prior.identity.manifestDigest === identity.manifestDigest &&
        prior.artifactDigest === declaredArtifactDigest &&
        prior.provenance.installerId === registration.provenance.installerId &&
        prior.provenance.reference === registration.provenance.reference &&
        prior.bytes.length === bytes.length &&
        prior.bytes.every((value, index) => value === bytes[index]);
      if (!same)
        throw new DomainPackCatalogError(
          "duplicate_conflict",
          `Pack ${identity.id}@${identity.version} is already installed with different immutable content or provenance`,
        );
      return identity;
    }
    this.entries.set(entryKey, {
      identity,
      schemaVersion: manifest.schemaVersion,
      coreContract: { ...manifest.coreContract },
      bytes,
      artifactDigest: declaredArtifactDigest,
      provenance: { ...registration.provenance },
    });
    return identity;
  }

  read(
    id: DomainPackId,
    version: DomainPackVersion,
  ): InstalledPackArtifact | undefined {
    const entry = this.entries.get(key(id, version));
    if (!entry) return undefined;
    return {
      identity: { ...entry.identity },
      schemaVersion: entry.schemaVersion,
      coreContract: { ...entry.coreContract },
      bytes: new Uint8Array(entry.bytes),
      artifactDigest: entry.artifactDigest,
      provenance: { ...entry.provenance },
    };
  }

  list(): readonly InstalledPackDescriptor[] {
    return [...this.entries.values()]
      .map((entry) => ({
        identity: { ...entry.identity },
        schemaVersion: entry.schemaVersion,
        coreContract: { ...entry.coreContract },
        artifactDigest: entry.artifactDigest,
        provenance: { ...entry.provenance },
      }))
      .sort((a, b) =>
        a.identity.id < b.identity.id
          ? -1
          : a.identity.id > b.identity.id
            ? 1
            : a.identity.version < b.identity.version
              ? -1
              : a.identity.version > b.identity.version
                ? 1
                : a.identity.manifestDigest < b.identity.manifestDigest
                  ? -1
                  : a.identity.manifestDigest > b.identity.manifestDigest
                    ? 1
                    : 0,
      );
  }
}

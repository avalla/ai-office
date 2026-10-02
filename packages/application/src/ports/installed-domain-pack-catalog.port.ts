import type {
  ArtifactDigest,
  CoreContractCompatibility,
  DomainPackDependency,
  DomainPackId,
  DomainPackVersion,
} from "../../../domain-pack-contracts/src/index.ts";

/** Availability on one Runtime installation, never a project selection. */
export interface TrustedPackProvenance {
  readonly installerId: string;
  readonly reference: string;
}

export type PackIdentity = DomainPackDependency;

export interface InstalledPackDescriptor {
  readonly identity: PackIdentity;
  readonly schemaVersion: 1;
  readonly coreContract: CoreContractCompatibility;
  readonly artifactDigest: ArtifactDigest;
  readonly provenance: TrustedPackProvenance;
}

export interface InstalledPackArtifact extends InstalledPackDescriptor {
  readonly bytes: Uint8Array;
}

export interface InstalledDomainPackCatalog {
  read(
    id: DomainPackId,
    version: DomainPackVersion,
  ): InstalledPackArtifact | undefined;
  /** Diagnostic availability listing; it never selects a project pack. */
  list(): readonly InstalledPackDescriptor[];
  trusts(provenance: TrustedPackProvenance): boolean;
}

export interface ResolvedInstalledPack extends InstalledPackDescriptor {
  readonly dependencies: readonly PackIdentity[];
}

export type DomainPackCatalogErrorCode =
  | "malformed_request"
  | "malformed_catalog_entry"
  | "malformed_dependency_graph"
  | "unsupported_schema"
  | "manifest_digest_mismatch"
  | "artifact_digest_mismatch"
  | "incompatible_core_contract"
  | "untrusted_provenance"
  | "duplicate_conflict"
  | "version_conflict"
  | "missing_pack"
  | "missing_dependency"
  | "dependency_digest_mismatch"
  | "dependency_cycle";

export class DomainPackCatalogError extends Error {
  constructor(
    readonly code: DomainPackCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainPackCatalogError";
  }
}

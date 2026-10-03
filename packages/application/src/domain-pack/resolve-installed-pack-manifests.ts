import {
  DomainPackManifestError,
  verifyDomainPackManifest,
  type DomainPackManifest,
} from "../../../domain-pack-contracts/src/index.ts";
import type {
  InstalledDomainPackCatalog,
  PackIdentity,
} from "../ports/installed-domain-pack-catalog.port.ts";
import { resolveInstalledPacks } from "./resolve-installed-packs.ts";

export type CapturedPackManifestErrorCode =
  "artifact_not_captured" | "manifest_unverified" | "manifest_differs";

/** The artifact GP-04 verified could not be read back as its own manifest. */
export class CapturedPackManifestError extends Error {
  constructor(
    readonly code: CapturedPackManifestErrorCode,
    readonly manifestErrorCode?: DomainPackManifestError["code"],
  ) {
    super(`Captured pack manifest: ${code}`);
    this.name = "CapturedPackManifestError";
  }
}

export interface ResolvedPackManifest {
  readonly identity: PackIdentity;
  readonly manifest: DomainPackManifest;
}

/**
 * The exact GP-04 closure of `requested`, each with the manifest of the
 * artifact the resolver examined. A second catalog read could observe another
 * registration after validation, so the bytes are captured during resolution.
 * GP-04 failures propagate as `DomainPackCatalogError`.
 */
export function resolveInstalledPackManifests(
  catalog: InstalledDomainPackCatalog,
  requested: readonly PackIdentity[],
): readonly ResolvedPackManifest[] {
  const captured = new Map<string, Uint8Array>();
  const capturing: InstalledDomainPackCatalog = {
    coreContractVersion: catalog.coreContractVersion,
    list: () => catalog.list(),
    trusts: (provenance) => catalog.trusts(provenance),
    read: (id, version) => {
      const artifact = catalog.read(id, version);
      if (artifact)
        captured.set(`${id}\u0000${version}`, new Uint8Array(artifact.bytes));
      return artifact;
    },
  };
  return resolveInstalledPacks(capturing, requested).map(({ identity }) => {
    const bytes = captured.get(`${identity.id}\u0000${identity.version}`);
    if (!bytes) throw new CapturedPackManifestError("artifact_not_captured");
    let manifest: DomainPackManifest;
    try {
      manifest = verifyDomainPackManifest(bytes);
    } catch (error) {
      if (error instanceof DomainPackManifestError)
        throw new CapturedPackManifestError("manifest_unverified", error.code);
      throw error;
    }
    if (manifest.manifestDigest !== identity.manifestDigest)
      throw new CapturedPackManifestError("manifest_differs");
    return { identity, manifest };
  });
}

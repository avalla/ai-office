import type {
  DomainPackId,
  DomainPackVersion,
} from "../../../../domain-pack-contracts/src/index.ts";
import {
  DomainPackCatalogError,
  type PackIdentity,
  type ResolvedInstalledPack,
} from "../../ports/installed-domain-pack-catalog.port.ts";

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

/** Internal graph guard over already verified entries. Production callers must use resolveInstalledPacks. */
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
    const dependencies = entry.dependencies
      .map((dependency) => ({ ...dependency }))
      .sort(compareIdentity);
    for (const dependency of dependencies) visit(dependency, identity);
    visiting.delete(key);
    resolved.set(key, {
      ...entry,
      identity: { ...entry.identity },
      coreContract: { ...entry.coreContract },
      provenance: { ...entry.provenance },
      dependencies,
    });
  }

  const roots = [...requested].sort(compareIdentity);
  const rootById = new Map<string, PackIdentity>();
  for (const root of roots) {
    const previous = rootById.get(root.id);
    if (previous && identityKey(previous) !== identityKey(root))
      throw new DomainPackCatalogError(
        "version_conflict",
        `Conflicting identities for pack ${root.id}`,
      );
    rootById.set(root.id, root);
  }
  for (const root of roots) visit(root);
  return [...resolved.values()].sort((a, b) =>
    compareIdentity(a.identity, b.identity),
  );
}

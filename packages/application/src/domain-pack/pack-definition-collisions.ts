import type { ContributionKind } from "../../../domain-pack-contracts/src/index.ts";
import {
  DomainPackCatalogError,
  type InstalledDomainPackCatalog,
  type PackIdentity,
} from "../ports/installed-domain-pack-catalog.port.ts";
import { compareOwnedDefinitions } from "./project-definition.ts";
import {
  CapturedPackManifestError,
  resolveInstalledPackManifests,
  type ResolvedPackManifest,
} from "./resolve-installed-pack-manifests.ts";

/**
 * The one code for a project-owned definition and a pack definition with the
 * same kind and local ID, reported before a mutation or restore: by GP-07 for
 * a prospective definition, by GP-22 for a prospective binding and archive.
 */
export const packDefinitionCollision = "pack_definition_collision" as const;

export interface PackDefinitionCollision {
  readonly kind: ContributionKind;
  readonly id: string;
  /** `<pack ID>@<version>` of the first colliding pack, in code-unit order. */
  readonly pack: string;
}

/**
 * The exact GP-04 closure of `packs` with its manifests, or `undefined` when
 * it does not resolve on this host for any GP-04 or read-back reason. Nothing
 * is resolved against another installed version or digest.
 */
export function resolvablePackClosure(
  catalog: InstalledDomainPackCatalog,
  packs: readonly PackIdentity[],
): readonly ResolvedPackManifest[] | undefined {
  try {
    return resolveInstalledPackManifests(catalog, packs);
  } catch (error) {
    if (
      error instanceof DomainPackCatalogError ||
      error instanceof CapturedPackManifestError
    )
      return undefined;
    throw error;
  }
}

/**
 * Every project-owned `(kind, localId)` that also exists anywhere in the
 * resolved closure, selected packs and transitive dependencies alike. Identity
 * is compared exactly by code unit, as GP-06 does. One entry per colliding
 * definition, in GP-07's kind then local-ID order.
 */
export function packDefinitionCollisions(
  closure: readonly ResolvedPackManifest[],
  owned: readonly { readonly kind: ContributionKind; readonly id: string }[],
): PackDefinitionCollision[] {
  return [...owned].sort(compareOwnedDefinitions).flatMap(({ kind, id }) => {
    const pack = closure
      .filter(({ manifest }) =>
        // Stored state is untrusted input: an unknown kind matches nothing.
        (Object.hasOwn(manifest.contributions, kind)
          ? manifest.contributions[kind]
          : []
        ).some((entry) => entry.id === id),
      )
      .map(({ identity }) => `${identity.id}@${identity.version}`)
      .sort()[0];
    return pack === undefined ? [] : [{ kind, id, pack }];
  });
}

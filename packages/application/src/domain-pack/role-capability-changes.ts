import type { ResolvedPackManifest } from "./resolve-installed-pack-manifests.ts";
import { stablePackDefinitionId } from "./resolve-project-configuration.ts";

/**
 * A role whose declared capability set differs between two resolved closures.
 * Capabilities are local IDs of the role's own pack.
 */
export interface RoleCapabilityDifference {
  readonly roleId: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface RoleCapabilitySet {
  readonly roleId: string;
  readonly capabilities: readonly string[];
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Stable IDs of every role a closure provides, with or without capabilities. */
export function closureRoleIds(
  closure: readonly ResolvedPackManifest[],
): Set<string> {
  return new Set(
    closure.flatMap(({ identity, manifest }) =>
      manifest.contributions.roles.map((role) =>
        stablePackDefinitionId(identity.id, "roles", role.id),
      ),
    ),
  );
}

/** Declared capability sets of the roles of one closure, by stable role ID. */
export function roleCapabilitySets(
  closure: readonly ResolvedPackManifest[],
): RoleCapabilitySet[] {
  return closure
    .flatMap(({ identity, manifest }) =>
      manifest.contributions.roles.flatMap((role) =>
        role.capabilities?.length
          ? [
              {
                roleId: stablePackDefinitionId(identity.id, "roles", role.id),
                capabilities: [...role.capabilities],
              },
            ]
          : [],
      ),
    )
    .sort((left, right) => compare(left.roleId, right.roleId));
}

/**
 * Every role whose capability set differs between `before` and `after`,
 * including added and removed roles that declare capabilities. The one
 * computation behind the upgrade plan and the pack binding guard.
 */
export function roleCapabilityDifferences(
  before: readonly ResolvedPackManifest[],
  after: readonly ResolvedPackManifest[],
): RoleCapabilityDifference[] {
  const sets = (closure: readonly ResolvedPackManifest[]) =>
    new Map(
      roleCapabilitySets(closure).map((item) => [
        item.roleId,
        item.capabilities,
      ]),
    );
  const old = sets(before);
  const next = sets(after);
  const differences: RoleCapabilityDifference[] = [];
  for (const roleId of new Set([...old.keys(), ...next.keys()])) {
    const previous = old.get(roleId) ?? [];
    const current = next.get(roleId) ?? [];
    const added = current.filter((item) => !previous.includes(item));
    const removed = previous.filter((item) => !current.includes(item));
    if (added.length || removed.length)
      differences.push({ roleId, added, removed });
  }
  return differences.sort((left, right) => compare(left.roleId, right.roleId));
}

import type {
  CapabilityOperation,
  CapabilityRequirement,
} from "../../../domain-pack-contracts/src/index.ts";
import type {
  OperationProvider,
  OperationProviderCatalog,
} from "../ports/operation-provider-catalog.port.ts";
import type { ResolvedPackManifest } from "./resolve-installed-pack-manifests.ts";

/**
 * GP-16: the operation contracts of pack capabilities, checked against the
 * providers a host has registered. Everything here is a report or a refusal.
 * A binding grants nothing, and nothing in this module is read by the policy
 * engine, the controlled-action gateway or scheduling.
 */

export type CapabilityBindingIssueCode =
  | "missing_required_capability_provider"
  | "capability_provider_mismatch"
  | "configuration_invariant";

export interface CapabilityBindingIssue {
  readonly code: CapabilityBindingIssueCode;
  /** Names the pack, the capability and the operation, and nothing else. */
  readonly message: string;
}

export type ResolvedCapabilityOperation = CapabilityOperation &
  (
    | {
        readonly binding: "bound";
        readonly provider: { readonly id: string; readonly version: string };
      }
    | { readonly binding: "unbound_optional" }
  );

/**
 * One capability of the resolved pack closure. A label has no requirement
 * and no operation. `capabilityId` is the stable identity
 * `pack:<packId>/capabilities/<localId>`.
 */
export interface ResolvedCapability {
  readonly capabilityId: string;
  readonly requirement?: CapabilityRequirement;
  readonly operations: readonly ResolvedCapabilityOperation[];
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const capabilityId = (pack: string, localId: string): string =>
  `pack:${pack}/capabilities/${localId}`;

function isProvider(value: unknown): value is OperationProvider {
  if (value === null || typeof value !== "object") return false;
  const { id, version, operations } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    typeof version === "string" &&
    Array.isArray(operations) &&
    operations.every((entry: unknown) => {
      if (entry === null || typeof entry !== "object") return false;
      const { operation, mode } = entry as Record<string, unknown>;
      return (
        typeof operation === "string" &&
        (mode === "read" || mode === "mutation")
      );
    })
  );
}

type Offer = { id: string; version: string; mode: "read" | "mutation" };

/** Operation name to the one provider that lists it, or why there is none. */
function offers(
  providers: OperationProviderCatalog,
): Map<string, Offer> | CapabilityBindingIssue {
  let listed: unknown;
  try {
    listed = providers.list();
  } catch {
    listed = undefined;
  }
  // The cause is a host fault and may carry host detail; it is not reported.
  if (!Array.isArray(listed) || !listed.every(isProvider))
    return {
      code: "configuration_invariant",
      message: "Operation provider catalog could not be read",
    };
  const byOperation = new Map<string, Offer>();
  for (const { id, version, operations } of listed as OperationProvider[])
    for (const { operation, mode } of operations) {
      // Two providers of one name would make the binding a choice.
      if (byOperation.has(operation))
        return {
          code: "configuration_invariant",
          message:
            "Operation provider catalog lists an operation more than once",
        };
      byOperation.set(operation, { id, version, mode });
    }
  return byOperation;
}

/**
 * Binds every declared operation of a resolved closure, selected packs and
 * transitive dependencies alike, to the provider that lists it. Either a view
 * of every capability, or the reasons no view exists; never both. The
 * provider catalog is read only when some capability declares an operation.
 */
export function bindCapabilityContracts(
  closure: readonly ResolvedPackManifest[],
  providers: OperationProviderCatalog,
):
  | { readonly capabilities: readonly ResolvedCapability[] }
  | { readonly issues: readonly CapabilityBindingIssue[] } {
  const declared = closure
    .flatMap(({ identity, manifest }) =>
      manifest.contributions.capabilities.map((capability) => ({
        identity,
        capability,
      })),
    )
    .sort(
      (left, right) =>
        compare(left.identity.id, right.identity.id) ||
        compare(left.capability.id, right.capability.id),
    );
  let available = new Map<string, Offer>();
  if (declared.some(({ capability }) => capability.operations !== undefined)) {
    const read = offers(providers);
    if (!(read instanceof Map)) return { issues: [read] };
    available = read;
  }
  const issues: CapabilityBindingIssue[] = [];
  const capabilities = declared.map(
    ({ identity, capability }): ResolvedCapability => {
      const subject = `Pack ${identity.id}@${identity.version} capability capabilities/${capability.id}`;
      const operations = (capability.operations ?? []).map(
        ({ operation, mode }): ResolvedCapabilityOperation => {
          const offer = available.get(operation);
          if (offer !== undefined && offer.mode === mode)
            return {
              operation,
              mode,
              binding: "bound",
              provider: { id: offer.id, version: offer.version },
            };
          // A wrong mode is a wrong declaration, required or not.
          if (offer !== undefined)
            issues.push({
              code: "capability_provider_mismatch",
              message: `${subject} declares operation ${operation} in a mode that differs from its registered provider`,
            });
          else if (capability.requirement !== "optional")
            issues.push({
              code: "missing_required_capability_provider",
              message: `${subject} requires operation ${operation}, which no registered provider offers`,
            });
          return { operation, mode, binding: "unbound_optional" };
        },
      );
      return {
        capabilityId: capabilityId(identity.id, capability.id),
        ...(capability.requirement === undefined
          ? {}
          : { requirement: capability.requirement }),
        operations,
      };
    },
  );
  return issues.length > 0 ? { issues } : { capabilities };
}

/**
 * A capability whose operation contract differs between two resolved
 * closures. A changed mode is one removed and one added operation.
 * `requirement` is reported for every entry, changed or not, so an operation
 * change always shows whether it concerns a required or an optional
 * capability; `null` is a capability that is absent or a label on that side.
 */
export interface CapabilityContractDifference {
  readonly capabilityId: string;
  readonly addedOperations: readonly CapabilityOperation[];
  readonly removedOperations: readonly CapabilityOperation[];
  readonly requirement: {
    readonly before: CapabilityRequirement | null;
    readonly after: CapabilityRequirement | null;
  };
}

/** Stable IDs of every capability a closure declares, label or not. */
export function closureCapabilityIds(
  closure: readonly ResolvedPackManifest[],
): Set<string> {
  return new Set(
    closure.flatMap(({ identity, manifest }) =>
      manifest.contributions.capabilities.map((capability) =>
        capabilityId(identity.id, capability.id),
      ),
    ),
  );
}

/**
 * Every capability whose contract differs between `before` and `after`,
 * including added and removed capabilities that declare operations. The one
 * computation behind the upgrade plan and the pack binding guard.
 */
export function capabilityContractDifferences(
  before: readonly ResolvedPackManifest[],
  after: readonly ResolvedPackManifest[],
): CapabilityContractDifference[] {
  const contracts = (closure: readonly ResolvedPackManifest[]) =>
    new Map(
      closure.flatMap(({ identity, manifest }) =>
        manifest.contributions.capabilities.flatMap((capability) =>
          capability.operations === undefined
            ? []
            : [[capabilityId(identity.id, capability.id), capability] as const],
        ),
      ),
    );
  const old = contracts(before);
  const next = contracts(after);
  const key = ({ operation, mode }: CapabilityOperation): string =>
    `${operation}\u0000${mode}`;
  const differences: CapabilityContractDifference[] = [];
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const previous = old.get(id);
    const current = next.get(id);
    const previousKeys = new Set((previous?.operations ?? []).map(key));
    const currentKeys = new Set((current?.operations ?? []).map(key));
    const addedOperations = (current?.operations ?? [])
      .filter((entry) => !previousKeys.has(key(entry)))
      .map(({ operation, mode }) => ({ operation, mode }));
    const removedOperations = (previous?.operations ?? [])
      .filter((entry) => !currentKeys.has(key(entry)))
      .map(({ operation, mode }) => ({ operation, mode }));
    const requirement = {
      before: previous?.requirement ?? null,
      after: current?.requirement ?? null,
    };
    if (
      addedOperations.length ||
      removedOperations.length ||
      requirement.before !== requirement.after
    )
      differences.push({
        capabilityId: id,
        addedOperations,
        removedOperations,
        requirement,
      });
  }
  return differences.sort((left, right) =>
    compare(left.capabilityId, right.capabilityId),
  );
}

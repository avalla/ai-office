import { createHash } from "node:crypto";
import { canonicalizeJcsJson } from "../../../domain-pack-contracts/src/jcs.ts";
import {
  evidenceContractKinds,
  evidenceContractMembersOf,
  type EvidenceContract,
  type EvidenceContractKind,
} from "./pack-evidence-contracts.ts";
import type { ResolvedPackManifest } from "./resolve-installed-pack-manifests.ts";
import { stablePackDefinitionId } from "./resolve-project-configuration.ts";

/** A contract is plain JSON data and is compared in canonical form. */
const canonical = (contract: EvidenceContract): string =>
  canonicalizeJcsJson(
    contract as unknown as Parameters<typeof canonicalizeJcsJson>[0],
  );

/**
 * A contract that differs between two resolved closures. `before` is absent
 * when the first closure declares none for the definition, `after` when the
 * second declares none.
 */
export interface EvidenceContractDifference {
  readonly contractId: string;
  readonly change: "added" | "removed" | "changed";
  readonly before?: EvidenceContract;
  readonly after?: EvidenceContract;
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Stable IDs of every artifact type, evidence type and validator of a closure. */
export function closureEvidenceDefinitionIds(
  closure: readonly ResolvedPackManifest[],
): Set<string> {
  return new Set(
    closure.flatMap(({ identity, manifest }) =>
      evidenceContractKinds.flatMap((kind) =>
        manifest.contributions[kind].map((item) =>
          stablePackDefinitionId(identity.id, kind, item.id),
        ),
      ),
    ),
  );
}

/** Every typed contract of one closure, in ascending ID order. */
export function closureEvidenceContracts(
  closure: readonly ResolvedPackManifest[],
): EvidenceContract[] {
  return closure
    .flatMap(({ identity, manifest }) =>
      evidenceContractKinds.flatMap((kind) =>
        manifest.contributions[kind].flatMap((item) => {
          const members = evidenceContractMembersOf(kind, item);
          return members === undefined
            ? []
            : [
                {
                  contractId: stablePackDefinitionId(
                    identity.id,
                    kind,
                    item.id,
                  ),
                  kind,
                  ...members,
                },
              ];
        }),
      ),
    )
    .sort((left, right) => compare(left.contractId, right.contractId));
}

/**
 * Every definition whose typed contract differs between `before` and `after`:
 * any typed member, the adapter ID and version included. Presentation is not
 * compared. The one computation behind the upgrade plan and the pack binding
 * guard.
 */
export function evidenceContractDifferences(
  before: readonly ResolvedPackManifest[],
  after: readonly ResolvedPackManifest[],
): EvidenceContractDifference[] {
  const byId = (closure: readonly ResolvedPackManifest[]) =>
    new Map(
      closureEvidenceContracts(closure).map((contract) => [
        contract.contractId,
        contract,
      ]),
    );
  const old = byId(before);
  const next = byId(after);
  const differences: EvidenceContractDifference[] = [];
  for (const contractId of new Set([...old.keys(), ...next.keys()])) {
    const previous = old.get(contractId);
    const current = next.get(contractId);
    if (previous === undefined && current !== undefined)
      differences.push({ contractId, change: "added", after: current });
    else if (previous !== undefined && current === undefined)
      differences.push({ contractId, change: "removed", before: previous });
    else if (
      previous !== undefined &&
      current !== undefined &&
      canonical(previous) !== canonical(current)
    )
      differences.push({
        contractId,
        change: "changed",
        before: previous,
        after: current,
      });
  }
  return differences.sort((left, right) =>
    compare(left.contractId, right.contractId),
  );
}

/**
 * What the audit trail keeps of a contract: its identity, and for a validator
 * the adapter ID, the adapter version and the failure policy, and for every
 * kind a hash of the canonical contract, so a change that alters only a limit
 * or a schema stays visible. Never a schema, a limit, a media type or a text.
 */
export interface EvidenceContractAuditSummary {
  readonly contractId: string;
  readonly kind: EvidenceContractKind;
  readonly contentHash: string;
  readonly adapter?: { readonly id: string; readonly version: string };
  readonly failurePolicy?: "fail_closed";
}

export function summarizeEvidenceContract(
  contract: EvidenceContract,
): EvidenceContractAuditSummary {
  return {
    contractId: contract.contractId,
    kind: contract.kind,
    // The same canonical form the plan compares, so that two summaries differ
    // exactly when the contracts do, a limit or schema change included.
    contentHash: `sha256:${createHash("sha256").update(canonical(contract)).digest("hex")}`,
    ...(contract.kind === "validators"
      ? {
          ...(contract.adapter === undefined
            ? {}
            : {
                adapter: {
                  id: contract.adapter.id,
                  version: contract.adapter.version,
                },
              }),
          ...(contract.failurePolicy === undefined
            ? {}
            : { failurePolicy: contract.failurePolicy }),
        }
      : {}),
  };
}

export function summarizeEvidenceContractDifference(
  difference: EvidenceContractDifference,
): {
  readonly contractId: string;
  readonly change: EvidenceContractDifference["change"];
  readonly before?: EvidenceContractAuditSummary;
  readonly after?: EvidenceContractAuditSummary;
} {
  return {
    contractId: difference.contractId,
    change: difference.change,
    ...(difference.before === undefined
      ? {}
      : { before: summarizeEvidenceContract(difference.before) }),
    ...(difference.after === undefined
      ? {}
      : { after: summarizeEvidenceContract(difference.after) }),
  };
}

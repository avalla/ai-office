import type {
  ArtifactTypeContribution,
  Contribution,
  EvidenceTypeContribution,
  ValidatorContribution,
} from "../../../domain-pack-contracts/src/index.ts";

/**
 * The code of a selection change that alters an artifact type, evidence type
 * or validator reference of a definition present in both closures (GP-14A).
 * Reported by the binding preview and raised by `project:pack:apply`.
 */
export const evidenceContractChangeRequiresUpgrade =
  "evidence_contract_change_requires_upgrade" as const;

/** The three kinds whose entries may carry a GP-14A typed contract. */
export const evidenceContractKinds = [
  "artifactTypes",
  "evidenceTypes",
  "validators",
] as const;
export type EvidenceContractKind = (typeof evidenceContractKinds)[number];

/**
 * The members of each kind that make an entry a typed contract. Everything
 * else (`id`, `title`, `description`) is presentation. A project cannot
 * change them: they stay the pack's under every customization.
 */
export const evidenceContractMembers: Readonly<
  Record<EvidenceContractKind, readonly string[]>
> = {
  artifactTypes: ["mediaTypes", "maximumBytes", "contentSchema"],
  evidenceTypes: ["subject", "payloadSchema"],
  validators: [
    "adapter",
    "accepts",
    "inputSchema",
    "produces",
    "outputSchema",
    "failurePolicy",
    "timeoutMs",
    "maxInputBytes",
    "maxOutputBytes",
  ],
};

type TypedMembers = Omit<
  ArtifactTypeContribution & EvidenceTypeContribution & ValidatorContribution,
  keyof Contribution
>;

/**
 * The typed members of a definition, or `undefined` for a label that has none.
 * Plain JSON data, compared in canonical form.
 */
export function evidenceContractMembersOf(
  kind: EvidenceContractKind,
  payload: object,
): TypedMembers | undefined {
  const entries = evidenceContractMembers[kind].flatMap((member) => {
    const value = (payload as Record<string, unknown>)[member];
    return value === undefined ? [] : [[member, value] as const];
  });
  return entries.length === 0
    ? undefined
    : (Object.fromEntries(entries) as TypedMembers);
}

/**
 * A typed artifact type, evidence type or validator reference of a resolved
 * closure: its stable identity and its typed members, never a title or a
 * description. Nothing declared here runs, registers or is enforced.
 */
export type EvidenceContract = TypedMembers & {
  readonly contractId: string;
  readonly kind: EvidenceContractKind;
};

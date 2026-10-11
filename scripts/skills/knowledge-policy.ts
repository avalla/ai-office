/**
 * Knowledge retrieval policy for the `task-delivery` skill (M19-T3).
 *
 * One pure mapping from the configured `knowledgePolicy` value and the
 * store connection state to the action a handoff or resume gate takes.
 * It exists so the skill text (references/configuration.md) and the code
 * that validates the configuration agree on one table, and so the mapping
 * is testable without a store. Knowledge stays advisory under every
 * outcome: no policy value makes retrieved knowledge authoritative, and no
 * outcome writes anything back to the store.
 */

/** The configured policy values accepted in `.task-delivery.yaml`. */
export const knowledgePolicies = ["auto", "required", "disabled"] as const;
export type KnowledgePolicy = (typeof knowledgePolicies)[number];

/** The store usability half of the mapping, as reported by the Runtime. */
export const knowledgeStoreStates = [
  "connected",
  "disabled",
  "misconfigured",
  "unavailable",
] as const;
export type KnowledgeStoreState = (typeof knowledgeStoreStates)[number];

export type KnowledgePolicyDecision =
  | {
      /** Run `knowledge:task` and carry the hits into the handoff section. */
      readonly action: "retrieve";
      readonly policy: KnowledgePolicy;
      readonly state: "connected";
    }
  | {
      /** Continue the gate without a knowledge section. */
      readonly action: "proceed-without-knowledge";
      readonly policy: KnowledgePolicy;
      readonly state: KnowledgeStoreState;
      /** True when a one-line evidence note must record why. */
      readonly evidenceNote: boolean;
    }
  | {
      /** Stop the gate; the typed store error is recorded as evidence. */
      readonly action: "block-gate";
      readonly policy: "required";
      readonly state: Exclude<KnowledgeStoreState, "connected">;
    };

export function isKnowledgePolicy(value: unknown): value is KnowledgePolicy {
  return (
    typeof value === "string" &&
    (knowledgePolicies as readonly string[]).includes(value)
  );
}

/**
 * disabled: never retrieve, whatever the store state.
 * auto: retrieve when connected; otherwise proceed and record one evidence
 * line naming the state.
 * required: retrieve when connected; otherwise block the gate. Lowering the
 * policy to proceed is the authorizer's decision, never the executor's.
 */
export function resolveKnowledgePolicy(
  policy: KnowledgePolicy,
  state: KnowledgeStoreState,
): KnowledgePolicyDecision {
  if (policy === "disabled")
    return {
      action: "proceed-without-knowledge",
      policy,
      state,
      evidenceNote: false,
    };
  if (state === "connected") return { action: "retrieve", policy, state };
  if (policy === "auto")
    return {
      action: "proceed-without-knowledge",
      policy,
      state,
      evidenceNote: true,
    };
  return { action: "block-gate", policy, state };
}

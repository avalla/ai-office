import {
  canonicalStageResult,
  parseStageResultEnvelope,
  type StageResultEnvelope,
} from "@ai-office/domain/pipeline/stage-result.ts";

export type StageResultDeliveryAssessment =
  | { readonly decision: "accepted"; readonly envelope: StageResultEnvelope }
  /** Same canonical result already recorded: a safe no-op, never re-applied. */
  | { readonly decision: "duplicate"; readonly envelope: StageResultEnvelope }
  /** Produced by an AgentRun that is no longer the stage's current run. */
  | { readonly decision: "stale"; readonly envelope: StageResultEnvelope }
  /** A different result for a stage that already has one: never overwritten. */
  | { readonly decision: "conflict"; readonly envelope: StageResultEnvelope };

export interface StageResultDeliveryContext {
  /** The AgentRun currently bound to the stage attempt, when there is one. */
  readonly currentAgentRunId?: string;
  /** The result already recorded for this stage attempt, when there is one. */
  readonly recorded?: StageResultEnvelope;
}

/**
 * Classifies one delivery of a stage result. Pure and side-effect free: it
 * grants no authority, performs no retry and never decides to overwrite; the
 * caller applies only an `accepted` decision. Malformed input throws the
 * sanitized `DomainValidationError` of the domain contract.
 */
export function assessStageResultDelivery(
  delivered: unknown,
  context: StageResultDeliveryContext = {},
): StageResultDeliveryAssessment {
  const envelope = parseStageResultEnvelope(delivered);
  if (
    envelope.producer.kind === "agent_run" &&
    envelope.producer.agentRunId !== context.currentAgentRunId
  )
    return { decision: "stale", envelope };
  if (context.recorded !== undefined)
    return {
      decision:
        canonicalStageResult(context.recorded) ===
        canonicalStageResult(envelope)
          ? "duplicate"
          : "conflict",
      envelope,
    };
  return { decision: "accepted", envelope };
}

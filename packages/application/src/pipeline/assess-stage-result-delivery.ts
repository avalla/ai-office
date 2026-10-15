import {
  canonicalStageResult,
  parseStageResultEnvelope,
  sameStageResultProducer,
  type StageResultEnvelope,
  type StageResultProducer,
} from "@ai-office/domain/pipeline/stage-result.ts";

export type StageResultDeliveryDecision =
  | "accepted"
  /** Same canonical result already recorded: a safe no-op, never re-applied. */
  | "duplicate"
  /** Delivered by an AgentRun that is no longer the stage's current run. */
  | "stale"
  /** A different result for a stage that already has one: never overwritten. */
  | "conflict"
  /** The payload claims a producer other than the authenticated deliverer. */
  | "producer_mismatch";

export interface StageResultDeliveryAssessment {
  readonly decision: StageResultDeliveryDecision;
  readonly envelope: StageResultEnvelope;
}

export interface StageResultDeliveryContext {
  /**
   * Who actually delivered the payload, established by the Runtime from the
   * authenticated AgentRun or operator command. The envelope's own `producer`
   * is only a claim and must equal this.
   */
  readonly deliveredBy: StageResultProducer;
  /** The AgentRun currently bound to the stage attempt, when there is one. */
  readonly currentAgentRunId?: string;
  /** The result already recorded for this stage attempt, when there is one. */
  readonly recorded?: StageResultEnvelope;
}

/**
 * Classifies one delivery of a stage result. Pure and side-effect free: it
 * grants no authority, performs no retry and never decides to overwrite; the
 * caller applies only an `accepted` decision. Precedence, first match wins:
 * producer mismatch, identical recorded result (duplicate), superseded
 * AgentRun (stale), different recorded result (conflict), accepted. An
 * ordinary at-least-once redelivery of a recorded result is therefore a
 * `duplicate` even after its run is no longer bound. Malformed input throws
 * the sanitized `DomainValidationError` of the domain contract.
 */
export function assessStageResultDelivery(
  delivered: unknown,
  context: StageResultDeliveryContext,
): StageResultDeliveryAssessment {
  const envelope = parseStageResultEnvelope(delivered);
  if (!sameStageResultProducer(envelope.producer, context.deliveredBy))
    return { decision: "producer_mismatch", envelope };
  const { recorded } = context;
  if (
    recorded !== undefined &&
    canonicalStageResult(recorded) === canonicalStageResult(envelope)
  )
    return { decision: "duplicate", envelope };
  if (
    context.deliveredBy.kind === "agent_run" &&
    context.deliveredBy.agentRunId !== context.currentAgentRunId
  )
    return { decision: "stale", envelope };
  if (recorded !== undefined) return { decision: "conflict", envelope };
  return { decision: "accepted", envelope };
}

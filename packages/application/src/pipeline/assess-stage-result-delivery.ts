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
  /**
   * True only for an `accepted` operator delivery while an AgentRun is still
   * bound to the stage. That is a pre-emption of the run, not a plain
   * acceptance: a caller that applies it must record it through the existing
   * attributed override path (with a reason), never as an ordinary completion.
   */
  readonly preemptsBoundRun: boolean;
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
  // The context is read once so a getter-backed context cannot change the
  // decision between checks.
  const { deliveredBy, currentAgentRunId, recorded: recordedInput } = context;
  const envelope = parseStageResultEnvelope(delivered);
  if (!sameStageResultProducer(envelope.producer, deliveredBy))
    return { decision: "producer_mismatch", envelope, preemptsBoundRun: false };
  // A recorded result is re-validated, so a rehydrated row is compared in
  // canonical form and a malformed one fails with the typed error.
  const recorded =
    recordedInput === undefined
      ? undefined
      : parseStageResultEnvelope(recordedInput);
  if (
    recorded !== undefined &&
    canonicalStageResult(recorded) === canonicalStageResult(envelope)
  )
    return { decision: "duplicate", envelope, preemptsBoundRun: false };
  if (
    deliveredBy.kind === "agent_run" &&
    deliveredBy.agentRunId !== currentAgentRunId
  )
    return { decision: "stale", envelope, preemptsBoundRun: false };
  if (recorded !== undefined)
    return { decision: "conflict", envelope, preemptsBoundRun: false };
  return {
    decision: "accepted",
    envelope,
    preemptsBoundRun:
      deliveredBy.kind === "operator" && currentAgentRunId !== undefined,
  };
}

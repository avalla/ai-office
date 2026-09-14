import { DomainValidationError } from "../errors.ts";

/** Which precedence rule produced a run's concrete model. */
export type ModelSelectionSource =
  | "project_agent_override"
  | "agent_override"
  | "role_policy"
  | "default"
  | "legacy_default";

export const modelSelectionSources: readonly ModelSelectionSource[] = [
  "project_agent_override",
  "agent_override",
  "role_policy",
  "default",
  "legacy_default",
];

/**
 * The concrete, non-secret model assignment frozen when a run is scheduled.
 *
 * `policy` is the semantic requirement the role declared; `profile` is the
 * deployment profile that satisfied it, when one did. Credentials, provider
 * client configuration and host paths never belong here.
 */
export interface AgentRunModelSelection {
  policy: string;
  profile: string | null;
  modelRef: string;
  providerId: string;
  model: string;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
  source: ModelSelectionSource;
}

/**
 * `unrouted` records that the Runtime had no model routing configured when the
 * run was scheduled, so the selected executor keeps its own default. A run
 * without any routing record predates model routing and is never reinterpreted.
 */
export type AgentRunModelRouting =
  | { status: "unrouted" }
  | { status: "resolved"; selection: AgentRunModelSelection };

export const modelTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const providerIdPattern = /^[a-z][a-z0-9_-]{0,31}$/u;
export const providerModelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
export const reasoningEffortPattern = /^[a-z][a-z0-9_-]{0,31}$/u;
export const maximumOutputTokens = 10_000_000;

const selectionKeys = [
  "policy",
  "profile",
  "modelRef",
  "providerId",
  "model",
  "reasoningEffort",
  "maxOutputTokens",
  "source",
];

function invalid(): never {
  throw new DomainValidationError("Invalid agent run model routing");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    invalid();
}

/** A role policy is operator-authored text; it only has to be printable. */
function validPolicy(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 200 &&
    !/\p{Cc}/u.test(value)
  );
}

function parseSelection(value: unknown): AgentRunModelSelection {
  const selection = record(value);
  exactKeys(selection, selectionKeys);
  const {
    policy,
    profile,
    modelRef,
    providerId,
    model,
    reasoningEffort,
    maxOutputTokens,
    source,
  } = selection;
  if (
    !validPolicy(policy) ||
    (profile !== null &&
      (typeof profile !== "string" || !modelTokenPattern.test(profile))) ||
    typeof providerId !== "string" ||
    !providerIdPattern.test(providerId) ||
    typeof model !== "string" ||
    !providerModelPattern.test(model) ||
    modelRef !== `${providerId}:${model}` ||
    (reasoningEffort !== null &&
      (typeof reasoningEffort !== "string" ||
        !reasoningEffortPattern.test(reasoningEffort))) ||
    (maxOutputTokens !== null &&
      (typeof maxOutputTokens !== "number" ||
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        maxOutputTokens > maximumOutputTokens)) ||
    typeof source !== "string" ||
    !modelSelectionSources.includes(source as ModelSelectionSource) ||
    // A concrete agent override names a model directly, never a profile.
    (profile === null &&
      source !== "project_agent_override" &&
      source !== "agent_override" &&
      source !== "legacy_default") ||
    (profile !== null && source === "legacy_default")
  )
    invalid();
  return Object.freeze({
    policy,
    profile,
    modelRef,
    providerId,
    model,
    reasoningEffort,
    maxOutputTokens,
    source: source as ModelSelectionSource,
  });
}

export function parseAgentRunModelRouting(
  value: unknown,
): AgentRunModelRouting {
  const routing = record(value);
  if (routing.status === "unrouted") {
    exactKeys(routing, ["status"]);
    return Object.freeze({ status: "unrouted" });
  }
  if (routing.status !== "resolved") invalid();
  exactKeys(routing, ["status", "selection"]);
  return Object.freeze({
    status: "resolved",
    selection: parseSelection(routing.selection),
  });
}

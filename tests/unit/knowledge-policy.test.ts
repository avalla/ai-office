import { describe, expect, test } from "vitest";
import {
  isKnowledgePolicy,
  knowledgePolicies,
  knowledgeStoreStates,
  resolveKnowledgePolicy,
} from "../../scripts/skills/knowledge-policy.ts";

describe("resolveKnowledgePolicy", () => {
  test.each(knowledgePolicies.flatMap((policy) =>
    knowledgeStoreStates.map((state) => [policy, state] as const),
  ))("maps policy %s with store state %s", (policy, state) => {
    const decision = resolveKnowledgePolicy(policy, state);
    expect(decision.policy).toBe(policy);
    expect(decision.state).toBe(state);
    if (state === "connected") {
      // Every policy retrieves when the store is connected; disabled never
      // retrieves at all.
      expect(decision.action).toBe(policy === "disabled" ? "proceed-without-knowledge" : "retrieve");
      return;
    }
    if (policy === "disabled") {
      expect(decision.action).toBe("proceed-without-knowledge");
      expect(decision).toMatchObject({ evidenceNote: false });
      return;
    }
    if (policy === "auto") {
      expect(decision.action).toBe("proceed-without-knowledge");
      expect(decision).toMatchObject({ evidenceNote: true });
      return;
    }
    expect(decision).toEqual({
      action: "block-gate",
      policy: "required",
      state,
    });
  });

  test("blocks the required gate for each non-connected state", () => {
    for (const state of ["disabled", "misconfigured", "unavailable"] as const) {
      expect(resolveKnowledgePolicy("required", state)).toEqual({
        action: "block-gate",
        policy: "required",
        state,
      });
    }
  });

  test("disabled never retrieves, even against a connected store", () => {
    expect(resolveKnowledgePolicy("disabled", "connected")).toEqual({
      action: "proceed-without-knowledge",
      policy: "disabled",
      state: "connected",
      evidenceNote: false,
    });
  });
});

describe("isKnowledgePolicy", () => {
  test("accepts exactly the three policy words", () => {
    for (const policy of knowledgePolicies)
      expect(isKnowledgePolicy(policy)).toBe(true);
    for (const value of ["", "AUTO", "on", null, undefined, 17, "auto "])
      expect(isKnowledgePolicy(value)).toBe(false);
  });
});

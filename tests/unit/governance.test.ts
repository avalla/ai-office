import { describe, expect, test } from "vitest";
import { isGovernanceTransitionAllowed } from "@ai-office/domain/governance/governance.ts";

describe("governance lifecycles", () => {
  test("allows forward transitions and rejects skipped terminal states", () => {
    expect(
      isGovernanceTransitionAllowed("milestone", "planned", "active"),
    ).toBe(true);
    expect(
      isGovernanceTransitionAllowed("milestone", "planned", "completed"),
    ).toBe(false);
    expect(
      isGovernanceTransitionAllowed("requirement", "implemented", "verified"),
    ).toBe(true);
    expect(isGovernanceTransitionAllowed("adr", "rejected", "accepted")).toBe(
      false,
    );
  });
});

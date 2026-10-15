import { describe, expect, test } from "vitest";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import {
  canonicalStageResult,
  parseStageResultEnvelope,
  stageResultLimits,
} from "@ai-office/domain/pipeline/stage-result.ts";
import { assessStageResultDelivery } from "@ai-office/application/pipeline/assess-stage-result-delivery.ts";

const valid = {
  version: 1,
  outcome: "succeeded",
  summary: "Implemented the change",
  producer: { kind: "agent_run", agentRunId: "run-1" },
  data: { files: 3, notes: ["a", "b"] },
};

function rejection(value: unknown): string {
  try {
    parseStageResultEnvelope(value);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainValidationError);
    return (error as Error).message;
  }
  throw new Error("expected the envelope to be rejected");
}

describe("stage result envelope", () => {
  test("accepts a valid bounded result and freezes it", () => {
    const envelope = parseStageResultEnvelope(valid);
    expect(envelope).toMatchObject({ version: 1, outcome: "succeeded" });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.producer)).toBe(true);
  });

  test("accepts an operator producer and a failed result with an error", () => {
    const envelope = parseStageResultEnvelope({
      version: 1,
      outcome: "failed",
      summary: "Could not finish",
      producer: { kind: "operator", actorLabel: "andrea" },
      error: { code: "validation_failed", message: "Tests did not pass" },
    });
    expect(envelope.error?.code).toBe("validation_failed");
  });

  test("rejects an unknown or missing version", () => {
    expect(rejection({ ...valid, version: 2 })).toContain("version");
    const { version: _version, ...withoutVersion } = valid;
    expect(rejection(withoutVersion)).toContain("version");
  });

  test.each([
    ["missing summary", { ...valid, summary: undefined }, "summary"],
    ["blank summary", { ...valid, summary: "   " }, "summary"],
    ["unknown outcome", { ...valid, outcome: "approved" }, "outcome"],
    ["unknown top-level field", { ...valid, approved: true }, "unknown fields"],
    ["non-object envelope", "text", "envelope"],
    ["array envelope", [], "envelope"],
  ])("rejects %s", (_name, value, fragment) => {
    expect(rejection(value)).toContain(fragment);
  });

  test.each([
    ["missing producer", { ...valid, producer: undefined }],
    ["unknown producer kind", { ...valid, producer: { kind: "bot" } }],
    ["agent run without id", { ...valid, producer: { kind: "agent_run" } }],
    [
      "agent run id with illegal characters",
      { ...valid, producer: { kind: "agent_run", agentRunId: "run 1/../" } },
    ],
    [
      "agent run with extra field",
      { ...valid, producer: { kind: "agent_run", agentRunId: "r", x: 1 } },
    ],
    [
      "operator without label",
      { ...valid, producer: { kind: "operator", actorLabel: "" } },
    ],
  ])("rejects a malformed producer: %s", (_name, value) => {
    expect(rejection(value)).toContain("producer");
  });

  test("requires an error for a failed result and forbids it on success", () => {
    expect(
      rejection({ ...valid, outcome: "failed", data: undefined }),
    ).toContain("requires error");
    expect(
      rejection({
        ...valid,
        error: { code: "validation_failed", message: "x" },
      }),
    ).toContain("cannot carry error");
  });

  test("rejects a malformed error code and extra error fields", () => {
    const failed = { ...valid, outcome: "failed", data: undefined };
    expect(
      rejection({ ...failed, error: { code: "Bad Code", message: "x" } }),
    ).toContain("error.code");
    expect(
      rejection({
        ...failed,
        error: { code: "ok_code", message: "x", stack: "at foo" },
      }),
    ).toContain("unknown fields");
  });

  test("rejects oversized fields", () => {
    expect(
      rejection({
        ...valid,
        summary: "x".repeat(stageResultLimits.summaryBytes + 1),
      }),
    ).toContain("summary exceeds");
    expect(
      rejection({
        ...valid,
        data: { blob: "x".repeat(stageResultLimits.dataBytes) },
      }),
    ).toContain("data exceeds");
    expect(
      rejection({
        ...valid,
        outcome: "failed",
        data: undefined,
        error: {
          code: "too_long",
          message: "x".repeat(stageResultLimits.errorMessageBytes + 1),
        },
      }),
    ).toContain("error.message exceeds");
  });

  test("measures the limit in bytes, not characters", () => {
    expect(
      rejection({
        ...valid,
        summary: "é".repeat(stageResultLimits.summaryBytes / 2 + 1),
      }),
    ).toContain("summary exceeds");
  });

  test("rejects control characters in text fields", () => {
    expect(rejection({ ...valid, summary: "bad\u0000text" })).toContain(
      "control characters",
    );
  });

  test("rejects sensitive data fields without echoing their content", () => {
    const message = rejection({
      ...valid,
      data: { nested: { apiKey: "sk-live-super-secret-value" } },
    });
    expect(message).toContain("sensitive");
    expect(message).not.toContain("sk-live-super-secret-value");
    expect(message).not.toContain("apiKey");
  });

  test("rejects non-canonical data such as undefined values and cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(rejection({ ...valid, data: cyclic })).toContain("data");
    expect(rejection({ ...valid, data: "text" })).toContain("data");
  });

  test("cannot claim capability, review or approval semantics", () => {
    for (const field of ["capabilities", "approval", "review", "grants"])
      expect(rejection({ ...valid, [field]: true })).toContain(
        "unknown fields",
      );
  });

  test("canonical form is independent of key order", () => {
    const left = parseStageResultEnvelope(valid);
    const right = parseStageResultEnvelope({
      producer: valid.producer,
      data: { notes: ["a", "b"], files: 3 },
      summary: valid.summary,
      outcome: valid.outcome,
      version: 1,
    });
    expect(canonicalStageResult(left)).toBe(canonicalStageResult(right));
  });
});

describe("assessStageResultDelivery", () => {
  const current = { currentAgentRunId: "run-1" };

  test("accepts the first delivery from the current AgentRun", () => {
    expect(assessStageResultDelivery(valid, current).decision).toBe("accepted");
  });

  test("treats an identical redelivery as a duplicate no-op", () => {
    const recorded = parseStageResultEnvelope(valid);
    const reordered = { ...valid, data: { notes: ["a", "b"], files: 3 } };
    expect(
      assessStageResultDelivery(reordered, { ...current, recorded }).decision,
    ).toBe("duplicate");
  });

  test("never overwrites a different recorded result", () => {
    const recorded = parseStageResultEnvelope(valid);
    expect(
      assessStageResultDelivery(
        { ...valid, summary: "Different outcome" },
        { ...current, recorded },
      ).decision,
    ).toBe("conflict");
  });

  test("flags a result from a superseded AgentRun as stale", () => {
    expect(
      assessStageResultDelivery(valid, { currentAgentRunId: "run-2" }).decision,
    ).toBe("stale");
    expect(assessStageResultDelivery(valid).decision).toBe("stale");
  });

  test("stale takes precedence over a recorded result", () => {
    const recorded = parseStageResultEnvelope(valid);
    expect(
      assessStageResultDelivery(valid, {
        currentAgentRunId: "run-2",
        recorded,
      }).decision,
    ).toBe("stale");
  });

  test("an operator result is not bound to an AgentRun", () => {
    expect(
      assessStageResultDelivery({
        ...valid,
        producer: { kind: "operator", actorLabel: "andrea" },
      }).decision,
    ).toBe("accepted");
  });

  test("a malformed delivery throws a sanitized typed error", () => {
    expect(() =>
      assessStageResultDelivery({ ...valid, version: 9 }, current),
    ).toThrow(DomainValidationError);
  });

  test("assessment has no side effects and exposes no retry decision", () => {
    const result = assessStageResultDelivery(valid, current);
    expect(Object.keys(result).sort()).toEqual(["decision", "envelope"]);
  });
});

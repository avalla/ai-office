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
      "forbidden characters",
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

describe("stage result hardening", () => {
  test("rejects a truly absent summary key", () => {
    const { summary: _summary, ...withoutSummary } = valid;
    expect(rejection(withoutSummary)).toContain("summary");
  });

  test("refuses a deeply nested payload quickly, before normalizing it", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 20_000; level += 1) deep = { next: deep };
    const started = performance.now();
    expect(rejection({ ...valid, data: deep })).toContain("nested too deeply");
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("refuses a wide payload by node budget", () => {
    const wide = Object.fromEntries(
      Array.from({ length: stageResultLimits.dataNodes + 1 }, (_, index) => [
        `k${index}`,
        index,
      ]),
    );
    expect(rejection({ ...valid, data: wide })).toContain("too many nodes");
  });

  test("refuses an oversized string before scanning it", () => {
    expect(rejection({ ...valid, summary: "x".repeat(5_000_000) })).toContain(
      "summary exceeds",
    );
  });

  test("does not invoke accessors while guarding data", () => {
    let invoked = false;
    const hostile = {
      get trap() {
        invoked = true;
        return 1;
      },
    };
    expect(rejection({ ...valid, data: hostile })).toContain("canonical JSON");
    expect(invoked).toBe(false);
  });

  test.each([
    ["authorization header", "Authorization: Bearer abcdefgh12345678"],
    ["bearer token", "failed with Bearer abcdefghijklmnop"],
    ["github token", "pushed using ghp_abcdefghijklmnop1234"],
    ["assignment", "retry with password=hunter2"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ])("rejects credential-like content in error.message: %s", (_name, text) => {
    const message = rejection({
      ...valid,
      outcome: "failed",
      data: undefined,
      error: { code: "failed_call", message: text },
    });
    expect(message).toContain("credential-like");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("abcdefgh");
  });

  test("rejects credential-like content in the summary and in data strings", () => {
    expect(
      rejection({ ...valid, summary: "token: abcdef1234567890" }),
    ).toContain("credential-like");
    expect(
      rejection({ ...valid, data: { note: "use sk-abcdefghijkl1234" } }),
    ).toContain("credential-like");
  });

  test.each(["githubToken", "accessToken", "client_secret", "dbPassword"])(
    "rejects a data key that contains a sensitive name: %s",
    (key) => {
      const message = rejection({ ...valid, data: { [key]: "x" } });
      expect(message).toContain("sensitive");
      expect(message).not.toContain(key);
    },
  );

  test("rejects line breaks in single-line fields but not in the summary", () => {
    expect(
      rejection({
        ...valid,
        producer: { kind: "operator", actorLabel: "a\nINFO forged" },
      }),
    ).toContain("single line");
    expect(
      rejection({
        ...valid,
        outcome: "failed",
        data: undefined,
        error: { code: "multi_line", message: "line one\nline two" },
      }),
    ).toContain("single line");
    expect(
      parseStageResultEnvelope({ ...valid, summary: "line one\nline two" })
        .summary,
    ).toBe("line one\nline two");
  });

  test.each(
    [0x202e, 0x2066, 0x2028, 0x0085].map((code) => String.fromCodePoint(code)),
  )("rejects spoofing character #%# in any text field", (character) => {
    expect(rejection({ ...valid, summary: `ok${character}gnp.exe` })).toContain(
      "forbidden characters",
    );
    expect(
      rejection({
        ...valid,
        producer: { kind: "operator", actorLabel: `a${character}b` },
      }),
    ).toContain("forbidden characters");
  });

  test("rejects a malformed actor label", () => {
    expect(
      rejection({
        ...valid,
        producer: { kind: "operator", actorLabel: "<script>" },
      }),
    ).toContain("actorLabel");
  });

  test("reads each top-level field exactly once", () => {
    const reads: Record<string, number> = {};
    const target: Record<string, unknown> = {
      version: 1,
      outcome: "failed",
      summary: "s",
      producer: { kind: "operator", actorLabel: "andrea" },
      data: { a: 1 },
      error: { code: "boom", message: "m" },
    };
    const counted = new Proxy(target, {
      get(object, property) {
        const key = String(property);
        reads[key] = (reads[key] ?? 0) + 1;
        return object[key];
      },
    });
    parseStageResultEnvelope(counted);
    for (const key of [
      "version",
      "outcome",
      "summary",
      "producer",
      "data",
      "error",
    ])
      expect(reads[key]).toBe(1);
  });
});

describe("assessStageResultDelivery", () => {
  const agent = { kind: "agent_run", agentRunId: "run-1" } as const;
  const operator = { kind: "operator", actorLabel: "andrea" } as const;
  const current = { deliveredBy: agent, currentAgentRunId: "run-1" };
  const operatorResult = { ...valid, producer: operator };

  test("accepts the first delivery from the current AgentRun", () => {
    expect(assessStageResultDelivery(valid, current).decision).toBe("accepted");
  });

  test("accepts an operator delivery that is not bound to an AgentRun", () => {
    expect(
      assessStageResultDelivery(operatorResult, { deliveredBy: operator })
        .decision,
    ).toBe("accepted");
  });

  test("treats an identical redelivery as a duplicate no-op", () => {
    const recorded = parseStageResultEnvelope(valid);
    const reordered = { ...valid, data: { notes: ["a", "b"], files: 3 } };
    expect(
      assessStageResultDelivery(reordered, { ...current, recorded }).decision,
    ).toBe("duplicate");
  });

  test("redelivery stays a duplicate after the run is no longer bound", () => {
    const recorded = parseStageResultEnvelope(valid);
    expect(
      assessStageResultDelivery(valid, {
        deliveredBy: agent,
        recorded,
      }).decision,
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
      assessStageResultDelivery(valid, {
        deliveredBy: agent,
        currentAgentRunId: "run-2",
      }).decision,
    ).toBe("stale");
    expect(
      assessStageResultDelivery(valid, { deliveredBy: agent }).decision,
    ).toBe("stale");
  });

  test("a different result from a stale run is stale, not a conflict", () => {
    const recorded = parseStageResultEnvelope({
      ...valid,
      producer: { kind: "agent_run", agentRunId: "run-2" },
    });
    expect(
      assessStageResultDelivery(valid, {
        deliveredBy: agent,
        currentAgentRunId: "run-2",
        recorded,
      }).decision,
    ).toBe("stale");
  });

  test("a stale run cannot bypass the check by claiming to be an operator", () => {
    expect(
      assessStageResultDelivery(operatorResult, {
        deliveredBy: agent,
        currentAgentRunId: "run-2",
      }).decision,
    ).toBe("producer_mismatch");
  });

  test("an operator cannot deliver as an AgentRun, nor as another operator", () => {
    expect(
      assessStageResultDelivery(valid, { deliveredBy: operator }).decision,
    ).toBe("producer_mismatch");
    expect(
      assessStageResultDelivery(operatorResult, {
        deliveredBy: { kind: "operator", actorLabel: "someone-else" },
      }).decision,
    ).toBe("producer_mismatch");
  });

  test("an AgentRun cannot deliver as another AgentRun", () => {
    expect(
      assessStageResultDelivery(valid, {
        deliveredBy: { kind: "agent_run", agentRunId: "run-9" },
        currentAgentRunId: "run-9",
      }).decision,
    ).toBe("producer_mismatch");
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

import { describe, expect, test } from "vitest";
import {
  daemonProtocolLimits,
  daemonProtocolVersion,
  isDaemonCommandRequest,
  isDaemonErrorResponse,
} from "@ai-office/application/protocol/daemon-protocol.ts";

describe("daemon protocol validation", () => {
  const valid = {
    protocolVersion: daemonProtocolVersion,
    requestId: "request-1",
    args: ["project:profile", "--project", "project"],
  };

  test("accepts a bounded versioned request", () => {
    expect(isDaemonCommandRequest(valid)).toBe(true);
  });

  test.each([
    [{ ...valid, protocolVersion: 2 }],
    [{ ...valid, operatorSurface: true }],
    [{ ...valid, requestId: "" }],
    [
      {
        ...valid,
        requestId: "x".repeat(daemonProtocolLimits.maxRequestIdLength + 1),
      },
    ],
    [
      {
        ...valid,
        args: new Array(daemonProtocolLimits.maxArguments + 1).fill("x"),
      },
    ],
    [
      {
        ...valid,
        args: ["x".repeat(daemonProtocolLimits.maxArgumentLength + 1)],
      },
    ],
    [
      {
        ...valid,
        promptAnswer: "x".repeat(
          daemonProtocolLimits.maxPromptAnswerLength + 1,
        ),
      },
    ],
  ])("rejects invalid or oversized request fields", (value) => {
    expect(isDaemonCommandRequest(value)).toBe(false);
  });

  test("recognizes typed error responses", () => {
    expect(
      isDaemonErrorResponse({
        protocolVersion: daemonProtocolVersion,
        requestId: "request-1",
        error: { code: "INVALID_REQUEST", message: "Invalid request" },
      }),
    ).toBe(true);
  });
});

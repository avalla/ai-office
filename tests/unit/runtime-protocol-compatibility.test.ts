import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  daemonProtocolLimits,
  daemonProtocolVersion,
  isDaemonCommandRequest,
  isDaemonCommandResponse,
  isDaemonErrorResponse,
} from "@ai-office/application/protocol/daemon-protocol.ts";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Renaming the daemon to "the Runtime host" is a vocabulary change inside the
 * application. Anything already written to disk or already on the wire is not:
 * audit rows are append-only history and the socket protocol is version 1.
 */
describe("Runtime host wire and audit compatibility", () => {
  test("the daemon protocol stays at version 1 with its original shape", () => {
    expect(daemonProtocolVersion).toBe(1);
    expect(daemonProtocolLimits).toEqual({
      maxPayloadBytes: 64 * 1024,
      maxArguments: 64,
      maxArgumentLength: 16 * 1024,
      maxRequestIdLength: 128,
      maxPromptAnswerLength: 16 * 1024,
    });

    expect(
      isDaemonCommandRequest({
        protocolVersion: 1,
        requestId: "request-1",
        args: ["task:list", "--project", "p1"],
      }),
    ).toBe(true);
    expect(
      isDaemonCommandRequest({
        protocolVersion: 2,
        requestId: "request-1",
        args: [],
      }),
    ).toBe(false);
    expect(
      isDaemonCommandResponse({
        protocolVersion: 1,
        requestId: "request-1",
        exitCode: 0,
        stdout: [],
        stderr: [],
      }),
    ).toBe(true);
    expect(
      isDaemonErrorResponse({
        protocolVersion: 1,
        requestId: "request-1",
        error: { code: "INVALID_REQUEST", message: "bad" },
      }),
    ).toBe(true);
  });

  test("the Runtime host still emits the original audit event vocabulary", () => {
    const source = readFileSync(
      join(repositoryRoot, "apps", "daemon", "src", "office-daemon.ts"),
      "utf8",
    );
    const emitted = [...source.matchAll(/eventType: "([^"]+)"/g)]
      .map((match) => match[1]!)
      .sort();

    expect(emitted).toEqual([
      "command.completed",
      "command.failed",
      "command.received",
      "daemon.started",
      "daemon.stopped",
    ]);
  });
});

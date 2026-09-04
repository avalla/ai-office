import { describe, expect, test } from "vitest";
import type {
  AiOfficeRuntime,
  AiOfficeRuntimeCommand,
} from "@ai-office/application/runtime/ai-office-runtime.ts";
import {
  daemonProtocolVersion,
  type DaemonCommandRequest,
} from "@ai-office/application/protocol/daemon-protocol.ts";
import { LocalCommandHandler } from "../../apps/daemon/src/local-command-handler.ts";

describe("AI Office Runtime boundary", () => {
  test("keeps daemon transport metadata outside Runtime execution semantics", async () => {
    let received: AiOfficeRuntimeCommand | undefined;
    const runtime: AiOfficeRuntime = {
      execute: async (command) => {
        received = command;
        return {
          exitCode: 0,
          stdout: ["done"],
          stderr: [],
        };
      },
    };
    const request: DaemonCommandRequest = {
      protocolVersion: daemonProtocolVersion,
      requestId: "transport-request-id",
      args: ["task:list", "--project", "project-1"],
      promptAnswer: "answer",
    };

    const response = await new LocalCommandHandler(runtime).execute(request);

    expect(received).toEqual({
      args: ["task:list", "--project", "project-1"],
      promptAnswer: "answer",
    });
    expect(response).toEqual({
      protocolVersion: daemonProtocolVersion,
      requestId: "transport-request-id",
      exitCode: 0,
      stdout: ["done"],
      stderr: [],
    });
  });
});

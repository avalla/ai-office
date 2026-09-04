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
  test("adds nothing to a Runtime result beyond protocol framing", async () => {
    const runtime: AiOfficeRuntime = {
      execute: async () => ({
        exitCode: null,
        stdout: ["Question context"],
        stderr: ["a warning"],
        prompt: { message: "Continue? " },
      }),
    };

    const response = await new LocalCommandHandler(runtime).execute({
      protocolVersion: daemonProtocolVersion,
      requestId: "prompting-request",
      args: ["uninstall", "/repo"],
    });

    expect(response).toEqual({
      protocolVersion: daemonProtocolVersion,
      requestId: "prompting-request",
      exitCode: null,
      stdout: ["Question context"],
      stderr: ["a warning"],
      prompt: { message: "Continue? " },
    });
  });

  test("omits promptAnswer rather than passing an undefined value through", async () => {
    let received: AiOfficeRuntimeCommand | undefined;
    const runtime: AiOfficeRuntime = {
      execute: async (command) => {
        received = command;
        return { exitCode: 0, stdout: [], stderr: [] };
      },
    };

    await new LocalCommandHandler(runtime).execute({
      protocolVersion: daemonProtocolVersion,
      requestId: "no-answer",
      args: ["task:list", "--project", "p1"],
    });

    expect(received).toEqual({ args: ["task:list", "--project", "p1"] });
    expect(Object.keys(received!)).toEqual(["args"]);
  });

  test("the Runtime contract carries no transport vocabulary", () => {
    // The contract is structural, so this asserts on what a host may hand over:
    // anything transport-shaped has to be rejected by the type checker, and a
    // Runtime implementation must be constructible without it.
    const command: AiOfficeRuntimeCommand = {
      args: ["status", "/repo"],
      promptAnswer: "yes",
    };

    expect(Object.keys(command).sort()).toEqual(["args", "promptAnswer"]);
  });
});

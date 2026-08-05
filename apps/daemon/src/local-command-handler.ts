import type {
  DaemonCommandRequest,
  DaemonCommandResponse
} from "@ai-office/application/protocol/daemon-protocol.ts";
import { daemonProtocolVersion } from "@ai-office/application/protocol/daemon-protocol.ts";
import {
  CliPromptRequiredError,
  runCli,
  type CliIo
} from "../../cli/src/cli.ts";

export interface DaemonCommandHandler {
  execute(request: DaemonCommandRequest): Promise<DaemonCommandResponse>;
}

export class LocalCommandHandler implements DaemonCommandHandler {
  constructor(
    private readonly projectRoot: string,
    private readonly migrationDirectory?: string
  ) {}

  async execute(request: DaemonCommandRequest): Promise<DaemonCommandResponse> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let promptAnswerConsumed = false;
    const io: CliIo = {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      prompt: async (message) => {
        if (request.promptAnswer === undefined || promptAnswerConsumed) {
          throw new CliPromptRequiredError(message);
        }
        promptAnswerConsumed = true;
        return request.promptAnswer;
      }
    };

    try {
      const exitCode = await runCli(request.args, {
        projectRoot: this.projectRoot,
        ...(this.migrationDirectory === undefined
          ? {}
          : { migrationDirectory: this.migrationDirectory }),
        io,
        propagatePromptRequired: true
      });

      return {
        protocolVersion: daemonProtocolVersion,
        requestId: request.requestId,
        exitCode,
        stdout,
        stderr
      };
    } catch (error) {
      if (error instanceof CliPromptRequiredError) {
        return {
          protocolVersion: daemonProtocolVersion,
          requestId: request.requestId,
          exitCode: null,
          stdout,
          stderr,
          prompt: { message: error.prompt }
        };
      }
      throw error;
    }
  }
}

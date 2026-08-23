import type {
  DaemonCommandRequest,
  DaemonCommandResponse,
} from "@ai-office/application/protocol/daemon-protocol.ts";
import { daemonProtocolVersion } from "@ai-office/application/protocol/daemon-protocol.ts";
import {
  CliPromptRequiredError,
  runCli,
  type CliIo,
} from "../../cli/src/cli.ts";
import type { OnboardingQuestionGenerator } from "@ai-office/application/ports/onboarding-question-generator.port.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";

export interface DaemonCommandHandler {
  execute(request: DaemonCommandRequest): Promise<DaemonCommandResponse>;
}

export class LocalCommandHandler implements DaemonCommandHandler {
  constructor(
    private readonly projectRoot: string,
    private readonly migrationDirectory?: string,
    private readonly onboardingGenerator?: OnboardingQuestionGenerator,
    private readonly globalDatabasePath?: string,
    private readonly globalMigrationDirectory?: string,
    private readonly agentClients?: AgentClientCatalog,
    private readonly projectBindings?: ProjectBindingAdapter,
    private readonly defaultOfficeManifest?: OfficeManifest,
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
      },
    };

    try {
      const exitCode = await runCli(request.args, {
        projectRoot: this.projectRoot,
        ...(this.migrationDirectory === undefined
          ? {}
          : { migrationDirectory: this.migrationDirectory }),
        ...(this.onboardingGenerator === undefined
          ? {}
          : { onboardingGenerator: this.onboardingGenerator }),
        ...(this.globalDatabasePath === undefined
          ? {}
          : { globalDatabasePath: this.globalDatabasePath }),
        ...(this.globalMigrationDirectory === undefined
          ? {}
          : { globalMigrationDirectory: this.globalMigrationDirectory }),
        ...(this.agentClients === undefined
          ? {}
          : { agentClients: this.agentClients }),
        ...(this.projectBindings === undefined
          ? {}
          : { projectBindings: this.projectBindings }),
        ...(this.defaultOfficeManifest === undefined
          ? {}
          : { defaultOfficeManifest: this.defaultOfficeManifest }),
        io,
        propagatePromptRequired: true,
      });

      return {
        protocolVersion: daemonProtocolVersion,
        requestId: request.requestId,
        exitCode,
        stdout,
        stderr,
      };
    } catch (error) {
      if (error instanceof CliPromptRequiredError) {
        return {
          protocolVersion: daemonProtocolVersion,
          requestId: request.requestId,
          exitCode: null,
          stdout,
          stderr,
          prompt: { message: error.prompt },
        };
      }
      throw error;
    }
  }
}

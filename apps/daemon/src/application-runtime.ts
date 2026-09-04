import type {
  AiOfficeRuntime,
  AiOfficeRuntimeCommand,
  AiOfficeRuntimeResult,
} from "@ai-office/application/runtime/ai-office-runtime.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import type { RuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import {
  CliPromptRequiredError,
  runCli,
  type CliIo,
} from "../../cli/src/cli.ts";

/**
 * Current in-process composition of AI Office application services.
 *
 * Only the persistent Runtime host constructs this implementation for
 * authoritative commands. It intentionally does not know about IPC, request
 * IDs, daemon health, sockets, or process lifecycle.
 */
export class ApplicationRuntime implements AiOfficeRuntime {
  constructor(
    private readonly runtimePaths: RuntimePaths,
    private readonly commandRoot: string,
    private readonly migrationDirectory?: string,
    private readonly globalMigrationDirectory?: string,
    private readonly agentClients?: AgentClientCatalog,
    private readonly projectBindings?: ProjectBindingAdapter,
    private readonly defaultOfficeManifest?: OfficeManifest,
  ) {}

  async execute(
    command: AiOfficeRuntimeCommand,
  ): Promise<AiOfficeRuntimeResult> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let promptAnswerConsumed = false;
    const io: CliIo = {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      prompt: async (message) => {
        if (command.promptAnswer === undefined || promptAnswerConsumed) {
          throw new CliPromptRequiredError(message);
        }
        promptAnswerConsumed = true;
        return command.promptAnswer;
      },
    };

    try {
      const exitCode = await runCli(command.args, {
        projectRoot: this.commandRoot,
        runtimePaths: this.runtimePaths,
        ...(this.migrationDirectory === undefined
          ? {}
          : { migrationDirectory: this.migrationDirectory }),
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

      return { exitCode, stdout, stderr };
    } catch (error) {
      if (error instanceof CliPromptRequiredError) {
        return {
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

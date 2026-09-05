import type {
  AiOfficeRuntime,
  AiOfficeRuntimeCommand,
  AiOfficeRuntimeResult,
} from "@ai-office/application/runtime/ai-office-runtime.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import type { RuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import { randomUUID } from "node:crypto";
import { RunExecutionControl } from "@ai-office/application/runtime/run-execution-control.ts";
import type { AgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import {
  CliPromptRequiredError,
  executeRuntimeCommand,
  type RuntimeCommandIo,
} from "./runtime-command.ts";

/**
 * Current in-process composition of AI Office application services.
 *
 * Only the persistent Runtime host constructs this implementation for
 * authoritative commands. It intentionally does not know about IPC, request
 * IDs, daemon health, sockets, or process lifecycle.
 */
export class ApplicationRuntime implements AiOfficeRuntime {
  private readonly executionControl = new RunExecutionControl(randomUUID());
  private readonly pending = new Set<Promise<AiOfficeRuntimeResult>>();
  private stopping = false;

  async stop(): Promise<void> {
    this.stopping = true;
    this.executionControl.stop();
    await Promise.allSettled([...this.pending]);
  }

  execute(command: AiOfficeRuntimeCommand): Promise<AiOfficeRuntimeResult> {
    if (this.stopping)
      return Promise.resolve({
        exitCode: 1,
        stdout: [],
        stderr: ["Runtime is stopping"],
      });
    const work = this.executeCommand(command);
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }
  constructor(
    private readonly runtimePaths: RuntimePaths,
    private readonly commandRoot: string,
    private readonly migrationDirectory?: string,
    private readonly globalMigrationDirectory?: string,
    private readonly agentClients?: AgentClientCatalog,
    private readonly projectBindings?: ProjectBindingAdapter,
    private readonly defaultOfficeManifest?: OfficeManifest,
    private readonly agentExecutor?: AgentExecutor,
  ) {}

  private async executeCommand(
    command: AiOfficeRuntimeCommand,
  ): Promise<AiOfficeRuntimeResult> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let promptAnswerConsumed = false;
    const io: RuntimeCommandIo = {
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
      const exitCode = await executeRuntimeCommand(command.args, {
        executionControl: this.executionControl,
        ...(this.agentExecutor === undefined
          ? {}
          : { agentExecutor: this.agentExecutor }),
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

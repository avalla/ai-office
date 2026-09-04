import type {
  DaemonCommandRequest,
  DaemonCommandResponse,
} from "@ai-office/application/protocol/daemon-protocol.ts";
import { daemonProtocolVersion } from "@ai-office/application/protocol/daemon-protocol.ts";
import type { AiOfficeRuntime } from "@ai-office/application/runtime/ai-office-runtime.ts";

export interface DaemonCommandHandler {
  execute(request: DaemonCommandRequest): Promise<DaemonCommandResponse>;
}

export class LocalCommandHandler implements DaemonCommandHandler {
  constructor(private readonly runtime: AiOfficeRuntime) {}

  async execute(request: DaemonCommandRequest): Promise<DaemonCommandResponse> {
    const result = await this.runtime.execute({
      args: request.args,
      ...(request.promptAnswer === undefined
        ? {}
        : { promptAnswer: request.promptAnswer }),
    });
    return {
      protocolVersion: daemonProtocolVersion,
      requestId: request.requestId,
      ...result,
    };
  }
}

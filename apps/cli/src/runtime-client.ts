import type {
  AiOfficeRuntimeCommand,
  AiOfficeRuntimeResult,
} from "@ai-office/application/runtime/ai-office-runtime.ts";

export interface RuntimeHealth {
  status: "ok";
  startedAt: string;
}

/** Client-side boundary used by CLI and future local client adapters. */
export interface RuntimeClient {
  health(): Promise<RuntimeHealth>;
  execute(
    args: AiOfficeRuntimeCommand["args"],
    promptAnswer?: string,
  ): Promise<AiOfficeRuntimeResult>;
}

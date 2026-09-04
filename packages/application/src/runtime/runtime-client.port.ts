import type {
  AiOfficeRuntimeCommand,
  AiOfficeRuntimeResult,
} from "./ai-office-runtime.ts";

export interface RuntimeHealth {
  status: "ok";
  startedAt: string;
}

/**
 * Client-side boundary onto the authoritative AI Office Runtime.
 *
 * It lives with the Runtime contract rather than in the CLI because every
 * local client adapter — the CLI today, other local clients later — implements
 * the same port. Transport selection stays in the adapter.
 */
export interface RuntimeClient {
  health(): Promise<RuntimeHealth>;
  execute(
    args: AiOfficeRuntimeCommand["args"],
    promptAnswer?: string,
  ): Promise<AiOfficeRuntimeResult>;
}

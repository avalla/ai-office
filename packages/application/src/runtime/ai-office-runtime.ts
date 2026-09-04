/**
 * Transport-independent command boundary for the authoritative AI Office Runtime.
 *
 * The current machine interface is command-oriented. Keeping request IDs,
 * protocol versions, sockets, and process lifecycle out of this contract lets
 * the persistent daemon host adapt IPC without making it part of application
 * execution semantics.
 */
export interface AiOfficeRuntimeCommand {
  args: string[];
  promptAnswer?: string;
}

export interface AiOfficeRuntimePrompt {
  message: string;
}

export interface AiOfficeRuntimeResult {
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
  prompt?: AiOfficeRuntimePrompt;
}

export interface AiOfficeRuntime {
  execute(command: AiOfficeRuntimeCommand): Promise<AiOfficeRuntimeResult>;
}

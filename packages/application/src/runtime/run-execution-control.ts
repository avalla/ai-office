import { DomainValidationError } from "@ai-office/domain/errors.ts";

/** Ephemeral liveness, owned by one persistent Runtime instance. Not authority. */
export class RunExecutionControl {
  private readonly live = new Map<
    string,
    { taskId: string; controller: AbortController }
  >();
  private stopping = false;
  constructor(readonly ownerId: string) {}
  reserve(runId: string, taskId: string): AbortSignal | null {
    if (this.stopping) throw new DomainValidationError("Runtime is stopping");
    if (this.live.has(runId)) return null;
    const controller = new AbortController();
    this.live.set(runId, { taskId, controller });
    return controller.signal;
  }
  has(runId: string): boolean {
    return this.live.has(runId);
  }
  cancellationRequested(runId: string): boolean {
    return this.live.get(runId)?.controller.signal.aborted ?? false;
  }
  cancel(runId: string): boolean {
    const value = this.live.get(runId);
    if (value === undefined) return false;
    value.controller.abort();
    return true;
  }
  release(runId: string): void {
    this.live.delete(runId);
  }
  stop(): void {
    this.stopping = true;
    for (const value of this.live.values()) value.controller.abort();
  }
}

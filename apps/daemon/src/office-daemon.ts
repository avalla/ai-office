import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import {
  daemonProtocolVersion,
  isDaemonCommandRequest,
  type DaemonHealthResponse
} from "@ai-office/application/protocol/daemon-protocol.ts";
import { CommandQueue } from "./command-queue.ts";
import type { DaemonCommandHandler } from "./local-command-handler.ts";

export class DaemonAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`AI Office daemon is already running at ${socketPath}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export interface OfficeDaemonOptions {
  socketPath: string;
  handler: DaemonCommandHandler;
  events: RecordAuditEvent;
  now?: () => Date;
  onStopped?: () => void;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

export class OfficeDaemon {
  private readonly queue = new CommandQueue();
  private readonly now: () => Date;
  private startedAt?: Date;
  private started = false;

  constructor(private readonly options: OfficeDaemonOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.started) throw new Error("Office daemon instances can only be started once");
    this.started = true;
    let server: ReturnType<typeof Bun.serve> | undefined;

    try {
      await this.prepareSocket();
      mkdirSync(dirname(this.options.socketPath), { recursive: true });
      this.startedAt = this.now();
      server = Bun.serve({
        unix: this.options.socketPath,
        fetch: (request) => this.route(request)
      });
      chmodSync(this.options.socketPath, 0o600);
      await this.options.events.execute({
        eventType: "daemon.started",
        actorType: "daemon",
        payload: { protocolVersion: daemonProtocolVersion }
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      try {
        if (server !== undefined) {
          await server.stop(false);
          await this.options.events.execute({
            eventType: "daemon.stopped",
            actorType: "daemon",
            payload: {}
          });
        }
      } finally {
        if (server !== undefined) this.removeSocket();
        this.options.onStopped?.();
      }
    }
  }

  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      const response: DaemonHealthResponse = {
        protocolVersion: daemonProtocolVersion,
        status: "ok",
        startedAt: this.startedAt?.toISOString() ?? this.now().toISOString()
      };
      return json(response);
    }

    if (path !== "/commands") return json({ error: "Not found" }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return json({ error: "Request body must be valid JSON" }, 400);
    }
    if (!isDaemonCommandRequest(value)) {
      return json({ error: "Invalid daemon command request" }, 400);
    }

    return this.queue.enqueue(async () => {
      const command = value.args[0] ?? "help";
      const startedAt = this.now();
      await this.options.events.execute({
        eventType: "command.received",
        actorType: "cli",
        actorId: value.requestId,
        payload: { command }
      });

      try {
        const response = await this.options.handler.execute(value);
        await this.options.events.execute({
          eventType: "command.completed",
          actorType: "daemon",
          actorId: value.requestId,
          payload: {
            command,
            exitCode: response.exitCode,
            interactionRequired: response.prompt !== undefined,
            durationMs: Math.max(0, this.now().getTime() - startedAt.getTime())
          }
        });
        return json(response);
      } catch {
        await this.options.events.execute({
          eventType: "command.failed",
          actorType: "daemon",
          actorId: value.requestId,
          payload: {
            command,
            durationMs: Math.max(0, this.now().getTime() - startedAt.getTime())
          }
        });
        return json({ error: "Command execution failed" }, 500);
      }
    });
  }

  private async prepareSocket(): Promise<void> {
    if (!existsSync(this.options.socketPath)) return;

    try {
      const response = await fetch("http://localhost/health", {
        unix: this.options.socketPath,
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) throw new DaemonAlreadyRunningError(this.options.socketPath);
    } catch (error) {
      if (error instanceof DaemonAlreadyRunningError) throw error;
    }

    this.removeSocket();
  }

  private removeSocket(): void {
    if (existsSync(this.options.socketPath)) {
      rmSync(this.options.socketPath);
    }
  }
}

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import {
  daemonProtocolLimits,
  daemonProtocolVersion,
  isDaemonCommandRequest,
  type DaemonHealthResponse,
} from "@ai-office/application/protocol/daemon-protocol.ts";
import { commandInvalidationTopics } from "@ai-office/application/protocol/query-protocol.ts";
import type { OperationalEventBus } from "@ai-office/application/events/operational-event-bus.ts";
import { CommandQueue } from "./command-queue.ts";
import type { DaemonCommandHandler } from "./local-command-handler.ts";
import type { QueryApi } from "./query-api.ts";

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
  commandTimeoutMs?: number;
  /**
   * Read-only query surface. Optional so a daemon can be constructed without
   * it, but the production bootstrap always supplies one.
   */
  queryApi?: QueryApi;
  /** Publishes invalidation hints after a command completes. */
  queryEvents?: OperationalEventBus;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
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
    if (this.started)
      throw new Error("Office daemon instances can only be started once");
    this.started = true;
    let server: ReturnType<typeof Bun.serve> | undefined;

    try {
      await this.prepareSocket();
      mkdirSync(dirname(this.options.socketPath), { recursive: true });
      this.startedAt = this.now();
      // A Unix-socket server takes no idle-timeout option, so the event
      // stream stays alive through its heartbeat rather than by relaxing a
      // server bound. See QueryApi's heartbeat interval.
      server = Bun.serve({
        unix: this.options.socketPath,
        fetch: (request) => this.route(request),
      });
      chmodSync(this.options.socketPath, 0o600);
      await this.options.events.execute({
        eventType: "daemon.started",
        actorType: "daemon",
        payload: { protocolVersion: daemonProtocolVersion },
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
          // A server-sent response never completes on its own, so a graceful
          // stop would wait for it forever. Ending the streams first also
          // releases their listeners and heartbeat timers.
          this.options.queryApi?.closeStreams();
          await server.stop(false);
          await this.options.events.execute({
            eventType: "daemon.stopped",
            actorType: "daemon",
            payload: {},
          });
        }
      } finally {
        // Event subscribers hold a listener and a heartbeat timer; dropping
        // them here keeps a stopped daemon from retaining either.
        this.options.queryEvents?.clear();
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
        startedAt: this.startedAt?.toISOString() ?? this.now().toISOString(),
      };
      return json(response);
    }

    const query = await this.options.queryApi?.handle(request);
    if (query !== undefined && query !== null) return query;

    if (path !== "/commands") return json({ error: "Not found" }, 404);
    if (request.method !== "POST")
      return json({ error: "Method not allowed" }, 405);

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (
      Number.isFinite(contentLength) &&
      contentLength > daemonProtocolLimits.maxPayloadBytes
    )
      return this.errorResponse(
        "",
        "PAYLOAD_TOO_LARGE",
        "Daemon command payload is too large",
        413,
      );

    let value: unknown;
    try {
      const body = await request.text();
      if (
        new TextEncoder().encode(body).byteLength >
        daemonProtocolLimits.maxPayloadBytes
      )
        return this.errorResponse(
          "",
          "PAYLOAD_TOO_LARGE",
          "Daemon command payload is too large",
          413,
        );
      value = JSON.parse(body) as unknown;
    } catch {
      return this.errorResponse(
        "",
        "INVALID_REQUEST",
        "Request body must be valid JSON",
        400,
      );
    }
    if (!isDaemonCommandRequest(value)) {
      const requestId =
        typeof value === "object" &&
        value !== null &&
        typeof (value as Record<string, unknown>).requestId === "string"
          ? ((value as Record<string, unknown>).requestId as string)
          : "";
      return this.errorResponse(
        requestId,
        "INVALID_REQUEST",
        "Invalid daemon command request",
        400,
      );
    }

    const execute = async () => {
      const command = value.args[0] ?? "help";
      const startedAt = this.now();
      await this.options.events.execute({
        eventType: "command.received",
        actorType: "cli",
        actorId: value.requestId,
        payload: { command },
      });

      try {
        const response = await this.withCommandTimeout(
          this.options.handler.execute(value),
        );
        await this.options.events.execute({
          eventType: "command.completed",
          actorType: "daemon",
          actorId: value.requestId,
          payload: {
            command,
            exitCode: response.exitCode,
            interactionRequired: response.prompt !== undefined,
            durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
          },
        });
        // Publishing here — after the command handler returned and its audit
        // event was written — means every authoritative write the runtime
        // performs has already landed before a subscriber is told to re-query.
        this.options.queryEvents?.publish(commandInvalidationTopics(command));
        return json(response);
      } catch (error) {
        await this.options.events.execute({
          eventType: "command.failed",
          actorType: "daemon",
          actorId: value.requestId,
          payload: {
            command,
            durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
          },
        });
        const timedOut = error instanceof DaemonCommandTimeoutError;
        return this.errorResponse(
          value.requestId,
          timedOut ? "COMMAND_TIMEOUT" : "INTERNAL_ERROR",
          timedOut ? "Daemon command timed out" : "Command execution failed",
          timedOut ? 504 : 500,
        );
      }
    };

    return value.args[0] === "run:tick"
      ? execute()
      : this.queue.enqueue(execute);
  }

  private async withCommandTimeout<T>(work: Promise<T>): Promise<T> {
    const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(
            () => reject(new DaemonCommandTimeoutError()),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private errorResponse(
    requestId: string,
    code:
      | "INVALID_REQUEST"
      | "PAYLOAD_TOO_LARGE"
      | "COMMAND_TIMEOUT"
      | "INTERNAL_ERROR",
    message: string,
    status: number,
  ): Response {
    return json(
      {
        protocolVersion: daemonProtocolVersion,
        requestId,
        error: { code, message },
      },
      status,
    );
  }

  private async prepareSocket(): Promise<void> {
    if (!existsSync(this.options.socketPath)) return;

    try {
      const response = await fetch("http://localhost/health", {
        unix: this.options.socketPath,
        signal: AbortSignal.timeout(500),
      });
      if (response.ok)
        throw new DaemonAlreadyRunningError(this.options.socketPath);
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

class DaemonCommandTimeoutError extends Error {
  constructor() {
    super("Daemon command timed out");
    this.name = "DaemonCommandTimeoutError";
  }
}

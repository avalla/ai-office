import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
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
import { coordinationApiVersion } from "@ai-office/application/protocol/coordination-query-protocol.ts";

export class RuntimeHostAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`AI Office Runtime host is already running at ${socketPath}`);
    this.name = "RuntimeHostAlreadyRunningError";
  }
}

export interface PersistentRuntimeHostOptions {
  socketPath: string;
  handler: DaemonCommandHandler;
  events: RecordAuditEvent;
  now?: () => Date;
  onStopped?: () => void | Promise<void>;
  onStarting?: () => Promise<void>;
  onStopping?: () => Promise<void>;
  commandTimeoutMs?: number;
  /**
   * Read-only query surface. Optional so a daemon can be constructed without
   * it, but the production bootstrap always supplies one.
   */
  queryApi?: QueryApi;
  /** Publishes invalidation hints after a command completes. */
  queryEvents?: OperationalEventBus;
  queueStatus?: () => Promise<NonNullable<DaemonHealthResponse["queue"]>>;
  knowledgeStatus?: NonNullable<DaemonHealthResponse["knowledge"]>;
  /**
   * The read-only coordination listener (ADR-0036 Decision 5), present only
   * when the owner enabled it. Its handler answers every request on its own
   * socket; nothing on that socket reaches the query API or `/commands`.
   */
  coordinationListener?: CoordinationListener;
}

export interface CoordinationListener {
  socketPath: string;
  handle(request: Request): Promise<Response>;
  /** Refuses further work; called before the listener stops. */
  close(): void;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export class PersistentRuntimeHost {
  private readonly queue = new CommandQueue();
  private readonly now: () => Date;
  private startedAt?: Date;
  private started = false;

  constructor(private readonly options: PersistentRuntimeHostOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The instant this host started serving; `undefined` before start. */
  get startedAtInstant(): Date | undefined {
    return this.startedAt;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.started)
      throw new Error("Office daemon instances can only be started once");
    this.started = true;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let coordinationServer: ReturnType<typeof Bun.serve> | undefined;

    try {
      await this.prepareSocket();
      mkdirSync(dirname(this.options.socketPath), { recursive: true });
      this.startedAt = this.now();
      // A Unix-socket server takes no idle-timeout option, so the event
      // stream stays alive through its heartbeat rather than by relaxing a
      // server bound. See QueryApi's heartbeat interval.
      server = Bun.serve({
        unix: this.options.socketPath,
        fetch: (request, host) =>
          this.route(request, () => host.timeout(request, 0)),
      });
      chmodSync(this.options.socketPath, 0o600);
      coordinationServer = await this.startCoordinationListener();
      await this.options.onStarting?.();
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
          await this.options.onStopping?.();
          // Reads hold no stream or state, so in-flight ones are not awaited:
          // a slow client cannot delay the Runtime stop.
          this.options.coordinationListener?.close();
          await coordinationServer?.stop(true);
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
        if (coordinationServer !== undefined)
          this.removeSocket(this.options.coordinationListener!.socketPath);
        if (server !== undefined) this.removeSocket(this.options.socketPath);
        await this.options.onStopped?.();
      }
    }
  }

  private async route(
    request: Request,
    allowLongResponse: () => void,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      const response: DaemonHealthResponse = {
        protocolVersion: daemonProtocolVersion,
        status: "ok",
        startedAt: this.startedAt?.toISOString() ?? this.now().toISOString(),
        ...(this.options.knowledgeStatus === undefined
          ? {}
          : { knowledge: this.options.knowledgeStatus }),
        ...(this.options.queueStatus === undefined
          ? {}
          : { queue: await this.options.queueStatus() }),
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
        const work = this.options.handler.execute(value);
        const response =
          command === "run:tick"
            ? await work
            : await this.withCommandTimeout(work);
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
        // A failed command is not a command that changed nothing: it may have
        // committed part of its work before failing, and it always appended
        // audit rows. Publishing the same conservative topic set as the success
        // path is the only assumption that cannot leave a dashboard stale.
        this.options.queryEvents?.publish(commandInvalidationTopics(command));
        const timedOut = error instanceof DaemonCommandTimeoutError;
        return this.errorResponse(
          value.requestId,
          timedOut ? "COMMAND_TIMEOUT" : "INTERNAL_ERROR",
          timedOut ? "Daemon command timed out" : "Command execution failed",
          timedOut ? 504 : 500,
        );
      }
    };

    if (value.args[0] === "run:tick") {
      // Only a validated long-running command bypasses the socket idle bound.
      // Worker deadlines and run cancellation still govern the execution.
      allowLongResponse();
      return execute();
    }
    return this.queue.enqueue(execute);
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

  /**
   * Starts the coordination listener when one is configured. The listener is
   * optional: a failure to bind it is reported and leaves it closed, never
   * the Runtime down, and never opens anything broader in its place.
   */
  private async startCoordinationListener(): Promise<
    ReturnType<typeof Bun.serve> | undefined
  > {
    const listener = this.options.coordinationListener;
    if (listener === undefined) return undefined;
    try {
      // The listener never shares the main socket, which is live by now.
      if (resolve(listener.socketPath) === resolve(this.options.socketPath))
        throw new Error("Coordination socket path is the main socket path");
      // Only a stale socket is ever replaced; any other file at the path is
      // left alone and keeps the listener closed.
      if (
        existsSync(listener.socketPath) &&
        !lstatSync(listener.socketPath).isSocket()
      )
        throw new Error("Coordination socket path is not a socket");
      await this.prepareCoordinationSocket(listener.socketPath);
      // Created owner-only from the start, not only after the chmod below.
      const previousUmask = process.umask(0o177);
      let server: ReturnType<typeof Bun.serve>;
      try {
        server = Bun.serve({
          unix: listener.socketPath,
          fetch: async (request) => {
            try {
              return await listener.handle(request);
            } catch {
              return json(
                {
                  coordinationApiVersion,
                  error: {
                    code: "INTERNAL_ERROR",
                    message: "Query execution failed",
                  },
                },
                500,
              );
            }
          },
        });
      } finally {
        process.umask(previousUmask);
      }
      try {
        chmodSync(listener.socketPath, 0o600);
      } catch (error) {
        await server.stop(true);
        this.removeSocket(listener.socketPath);
        throw error;
      }
      return server;
    } catch {
      // The socket path can be user-specific; the reason stays out of logs.
      console.error(
        "Coordination listener could not start; it stays disabled until the Runtime restarts.",
      );
      return undefined;
    }
  }

  /**
   * Removes a stale coordination socket. Only a refused connection proves
   * nothing listens there; an accepted connection (whatever the protocol), a
   * timeout or any other error leaves the file alone and the listener closed.
   */
  private async prepareCoordinationSocket(socketPath: string): Promise<void> {
    if (!existsSync(socketPath)) return;
    const outcome = await new Promise<"refused" | "other">((resolve) => {
      const connection = createConnection(socketPath);
      const settle = (value: "refused" | "other") => {
        clearTimeout(timer);
        connection.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => settle("other"), 500);
      connection.once("connect", () => settle("other"));
      connection.once("error", (error: NodeJS.ErrnoException) =>
        settle(error.code === "ECONNREFUSED" ? "refused" : "other"),
      );
    });
    if (outcome !== "refused")
      throw new RuntimeHostAlreadyRunningError(socketPath);
    this.removeSocket(socketPath);
  }

  private async prepareSocket(): Promise<void> {
    if (!existsSync(this.options.socketPath)) return;

    try {
      const response = await fetch("http://localhost/health", {
        unix: this.options.socketPath,
        signal: AbortSignal.timeout(500),
      });
      if (response.ok)
        throw new RuntimeHostAlreadyRunningError(this.options.socketPath);
    } catch (error) {
      if (error instanceof RuntimeHostAlreadyRunningError) throw error;
    }

    this.removeSocket(this.options.socketPath);
  }

  private removeSocket(socketPath: string): void {
    if (existsSync(socketPath)) {
      rmSync(socketPath);
    }
  }
}

// Compatibility exports: daemon remains the name of the current local hosting
// mechanism and of the version-1 protocol/audit vocabulary.
/**
 * Pre-Runtime names. Identity aliases, not subclasses, so `instanceof`
 * behaves identically through either name. See the compatibility contract in
 * `apps/cli/src/daemon-client.ts`.
 */
export {
  PersistentRuntimeHost as OfficeDaemon,
  RuntimeHostAlreadyRunningError as DaemonAlreadyRunningError,
};
export type OfficeDaemonOptions = PersistentRuntimeHostOptions;

class DaemonCommandTimeoutError extends Error {
  constructor() {
    super("Daemon command timed out");
    this.name = "DaemonCommandTimeoutError";
  }
}

/**
 * HTTP transport for the read-only query surface.
 *
 * This module only parses requests, validates parameters, and serializes
 * results. It contains no SQL and no domain logic: every answer comes from
 * {@link OperationalQueryService}. Keeping it that thin is what lets another
 * client — a CLI query command, an MCP tool — consume the same read models
 * without going through HTTP.
 */

import {
  OperationalQueryService,
  OperationalResourceNotFoundError,
} from "@ai-office/application/queries/operational-query-service.ts";
import {
  parseBoolean,
  parseIdentifier,
  parseInstant,
  parseLimit,
  queryApiPrefix,
  queryApiVersion,
  queryLimits,
  QueryValidationError,
  type QueryErrorCode,
  type QueryEvent,
} from "@ai-office/application/protocol/query-protocol.ts";
import {
  OperationalEventBusFullError,
  type OperationalEventBus,
} from "@ai-office/application/events/operational-event-bus.ts";

export interface QueryApiOptions {
  queries: OperationalQueryService;
  events: OperationalEventBus;
  /** Interval between SSE keep-alive comments. */
  heartbeatMs?: number;
}

function json(value: unknown, status = 200): Response {
  return Response.json(
    { queryApiVersion, ...(value as Record<string, unknown>) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function errorResponse(
  code: QueryErrorCode,
  message: string,
  status: number,
): Response {
  return Response.json(
    { queryApiVersion, error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Splits `/api/<segment>/...` into decoded segments.
 *
 * A path outside the prefix is "not mine" so the daemon can keep routing it.
 * A path inside the prefix that cannot be decoded, or whose segment hides a
 * separator behind percent-encoding, is a malformed request to this surface —
 * distinct from an unknown one, and reported as such.
 */
type RouteMatch =
  | { kind: "other" }
  | { kind: "malformed" }
  | { kind: "matched"; segments: string[] };

function routeSegments(pathname: string): RouteMatch {
  if (pathname !== queryApiPrefix && !pathname.startsWith(`${queryApiPrefix}/`))
    return { kind: "other" };
  const rest = pathname.slice(queryApiPrefix.length).replace(/^\//, "");
  if (rest === "") return { kind: "matched", segments: [] };
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { kind: "malformed" };
    }
    if (decoded.includes("/")) return { kind: "malformed" };
    segments.push(decoded);
  }
  return { kind: "matched", segments };
}

export class QueryApi {
  private readonly queries: OperationalQueryService;
  private readonly events: OperationalEventBus;
  private readonly heartbeatMs: number;
  private readonly streams = new Set<StreamSubscription>();

  constructor(options: QueryApiOptions) {
    this.queries = options.queries;
    this.events = options.events;
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
  }

  /** Returns `null` when the request is not addressed to the query surface. */
  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = routeSegments(url.pathname);
    if (match.kind === "other") return null;

    if (request.method !== "GET")
      return errorResponse(
        "METHOD_NOT_ALLOWED",
        "The query API is read-only and only accepts GET",
        405,
      );

    if (match.kind === "malformed")
      return errorResponse(
        "INVALID_REQUEST",
        "The request path is not a valid query route",
        400,
      );

    try {
      return await this.route(match.segments, url);
    } catch (error) {
      if (error instanceof QueryValidationError)
        return errorResponse("INVALID_REQUEST", error.message, 400);
      if (error instanceof OperationalResourceNotFoundError)
        return errorResponse("NOT_FOUND", error.message, 404);
      if (error instanceof OperationalEventBusFullError)
        return errorResponse(
          "TOO_MANY_SUBSCRIBERS",
          "Too many event subscribers are connected",
          503,
        );
      // Internal failures never leak a message or a stack trace.
      return errorResponse("INTERNAL_ERROR", "Query execution failed", 500);
    }
  }

  private async route(
    segments: readonly string[],
    url: URL,
  ): Promise<Response> {
    const parameters = url.searchParams;
    const [first, second, third] = segments;

    if (first === "events" && segments.length === 1) return this.streamEvents();

    if (first === "dashboard" && segments.length === 1)
      return json({
        dashboard: await this.queries.getDashboardOverview({
          activityLimit: parseLimit(
            parameters.get("activityLimit"),
            queryLimits.activity,
          ),
        }),
      });

    if (first === "projects") {
      if (segments.length === 1)
        return json({ projects: await this.queries.listProjects() });

      const projectId = parseIdentifier(second, "projectId");
      if (segments.length === 2)
        return json({
          project: await this.queries.getProjectDetail(projectId, {
            taskLimit: parseLimit(
              parameters.get("taskLimit"),
              queryLimits.tasks,
            ),
            runLimit: parseLimit(parameters.get("runLimit"), queryLimits.runs),
            activityLimit: parseLimit(
              parameters.get("activityLimit"),
              queryLimits.activity,
            ),
          }),
        });

      if (segments.length === 3 && third === "tasks")
        return json({
          tasks: await this.queries.listTasks(
            projectId,
            parseLimit(parameters.get("limit"), queryLimits.tasks),
          ),
        });

      if (segments.length === 3 && third === "pipelines")
        return json({
          pipelines: await this.queries.listPipelineRuns(projectId, {
            activeOnly: parseBoolean(parameters.get("active"), "active"),
            limit: parseLimit(parameters.get("limit"), queryLimits.pipelines),
          }),
        });

      if (segments.length === 3 && third === "agents")
        return json({ agents: await this.queries.listAgents(projectId) });
    }

    if (first === "runs") {
      if (segments.length === 1) {
        const projectId = parameters.get("project");
        return json({
          runs: await this.queries.listRuns({
            ...(projectId === null
              ? {}
              : { projectId: parseIdentifier(projectId, "project") }),
            activeOnly: parseBoolean(parameters.get("active"), "active"),
            limit: parseLimit(parameters.get("limit"), queryLimits.runs),
          }),
        });
      }
      if (segments.length === 2)
        return json({
          run: await this.queries.getRunDetail(
            parseIdentifier(second, "runId"),
          ),
        });
    }

    if (first === "reviews" && segments.length === 1) {
      const projectId = parameters.get("project");
      return json({
        reviews: await this.queries.listReviews({
          ...(projectId === null
            ? {}
            : { projectId: parseIdentifier(projectId, "project") }),
          pendingOnly: parseBoolean(parameters.get("pending"), "pending"),
          limit: parseLimit(parameters.get("limit"), queryLimits.reviews),
        }),
      });
    }

    if (first === "approvals" && segments.length === 1) {
      const projectId = parameters.get("project");
      return json({
        approvals: await this.queries.listApprovals({
          ...(projectId === null
            ? {}
            : { projectId: parseIdentifier(projectId, "project") }),
          limit: parseLimit(parameters.get("limit"), queryLimits.reviews),
        }),
      });
    }

    if (first === "activity" && segments.length === 1) {
      const projectId = parameters.get("project");
      const before = parseInstant(parameters.get("before"), "before");
      return json({
        activity: await this.queries.listActivity({
          ...(projectId === null
            ? {}
            : { projectId: parseIdentifier(projectId, "project") }),
          ...(before === undefined ? {} : { before }),
          limit: parseLimit(parameters.get("limit"), queryLimits.activity),
        }),
      });
    }

    return errorResponse("NOT_FOUND", "Unknown query route", 404);
  }

  /**
   * Server-sent invalidation stream.
   *
   * The stream carries topics only. A subscriber that misses an event is stale
   * until the next one or until it reconnects; it can never be wrong, because
   * the topic is not the data. Subscription and heartbeat are released whether
   * the client disconnects or the daemon shuts down, so neither path can leak a
   * listener or a timer.
   */
  private streamEvents(): Response {
    const encoder = new TextEncoder();
    let subscription: StreamSubscription | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // The consumer went away between the check and the enqueue.
            closed = true;
          }
        };

        send(`retry: 2000\n\n`);
        send(`event: ready\ndata: ${JSON.stringify({ queryApiVersion })}\n\n`);

        const release = this.events.subscribe((event: QueryEvent) => {
          if (closed) throw new Error("stream closed");
          send(`event: invalidate\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(
          () => send(`: heartbeat\n\n`),
          this.heartbeatMs,
        );

        subscription = {
          dispose: (endStream) => {
            if (closed) return;
            closed = true;
            release();
            clearInterval(heartbeat);
            if (!endStream) return;
            try {
              controller.close();
            } catch {
              // Already closed by the consumer disconnecting.
            }
          },
        };
        this.streams.add(subscription);
      },
      cancel: () => {
        if (subscription === undefined) return;
        this.streams.delete(subscription);
        subscription.dispose(false);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }

  /**
   * Ends every open stream.
   *
   * A server-sent response never completes on its own, so a graceful
   * `server.stop()` would wait forever for one. The daemon calls this before
   * stopping, which is also what lets a connected dashboard see the
   * disconnection and reconnect when the daemon comes back.
   */
  closeStreams(): void {
    for (const subscription of [...this.streams]) {
      this.streams.delete(subscription);
      subscription.dispose(true);
    }
  }
}

interface StreamSubscription {
  /** `endStream` closes the response body as well as releasing resources. */
  dispose(endStream: boolean): void;
}

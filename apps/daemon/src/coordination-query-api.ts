/**
 * HTTP transport of the read-only coordination listener (CB-10, ADR-0036
 * Decision 5).
 *
 * This handler is the whole surface of the coordination socket: it answers
 * every request itself and never falls through to the dashboard query API or
 * the command route. It parses, applies the owner's per-project exposure
 * policy, calls the shared {@link CoordinationReadService} and serializes; it
 * holds no SQL, writes nothing and receives no principal.
 */

import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import {
  PlanningScopeNotFoundError,
  PlanningSnapshotQueryError,
} from "@ai-office/application/coordination/get-planning-snapshot.ts";
import {
  CoordinationClassNotEnabledError,
  CoordinationOperationError,
  CoordinationResponseTooLargeError,
  type CoordinationReadService,
} from "@ai-office/application/coordination/coordination-read-service.ts";
import type { PlanningDataClass } from "@ai-office/application/coordination/planning-snapshot.ts";
import { PlanningReadBusyError } from "@ai-office/application/ports/planning-read.port.ts";
import {
  coordinationApiVersion,
  coordinationQueryLimits,
  parseCoordinationReadParameters,
  parseCoordinationRoute,
  type CoordinationHealthResponse,
  type CoordinationQueryErrorCode,
} from "@ai-office/application/protocol/coordination-query-protocol.ts";
import { QueryValidationError } from "@ai-office/application/protocol/query-protocol.ts";

export interface CoordinationQueryApiOptions {
  reads: CoordinationReadService;
  /** Enabled projects and their classes; any other project is not served. */
  projects: ReadonlyMap<string, readonly PlanningDataClass[]>;
  /** The Runtime host start instant, reported by the health route. */
  startedAt: () => Date;
  /** Concurrent read requests served at once; more answer RUNTIME_BUSY. */
  maxInFlight?: number;
}

/**
 * Each read loads and hashes a whole project planning state on the Runtime
 * event loop, so a client of this socket cannot queue unbounded work there.
 */
const defaultMaxInFlight = 8;

const headers = { "cache-control": "no-store" } as const;

function errorResponse(
  code: CoordinationQueryErrorCode,
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(
    { coordinationApiVersion, error: { code, message } },
    { status, headers: { ...headers, ...extraHeaders } },
  );
}

// One message for an unknown and a not-enabled project, so the listener does
// not reveal which projects exist.
const projectNotFound = () =>
  errorResponse("NOT_FOUND", "Project not found", 404);

const busy = (message: string) =>
  errorResponse("RUNTIME_BUSY", message, 503, { "retry-after": "1" });

export class CoordinationQueryApi {
  private inFlight = 0;
  private closed = false;

  constructor(private readonly options: CoordinationQueryApiOptions) {}

  /**
   * Called when the host stops: new reads are refused, and a read still
   * retrying past the stop (its storage now closed) is not logged as a fault.
   */
  close(): void {
    this.closed = true;
  }

  async handle(request: Request): Promise<Response> {
    if (this.closed) return busy("The Runtime is stopping");
    if (request.method !== "GET")
      return errorResponse(
        "METHOD_NOT_ALLOWED",
        "The coordination listener is read-only and only accepts GET",
        405,
      );
    const url = new URL(request.url);
    if (
      new TextEncoder().encode(url.search).byteLength >
      coordinationQueryLimits.maxQueryBytes
    )
      return errorResponse(
        "PAYLOAD_TOO_LARGE",
        `Request parameters exceed ${coordinationQueryLimits.maxQueryBytes} bytes`,
        414,
      );
    try {
      const route = parseCoordinationRoute(url.pathname);
      if (route.kind === "not_found")
        return errorResponse("NOT_FOUND", "Not found", 404);
      if (route.kind === "health") {
        if (url.search !== "")
          throw new QueryValidationError("The health route takes no parameters");
        const health: CoordinationHealthResponse = {
          coordinationApiVersion,
          status: "ok",
          startedAt: this.options.startedAt().toISOString(),
        };
        return Response.json(health, { headers });
      }
      const parameters = parseCoordinationReadParameters(url.searchParams);
      if (this.inFlight >= (this.options.maxInFlight ?? defaultMaxInFlight))
        return busy("Too many concurrent reads; retry");
      this.inFlight += 1;
      try {
        const response = await this.options.reads.execute(
          {
            projectId: route.projectId,
            operation: route.operation,
            milestoneId: parameters.milestoneId,
            offset: parameters.offset,
            limit: parameters.limit,
            classes: parameters.classes,
          },
          { kind: "exposure", projects: this.options.projects },
        );
        return Response.json(response, { headers });
      } finally {
        this.inFlight -= 1;
      }
    } catch (error) {
      if (
        error instanceof QueryValidationError ||
        error instanceof PlanningSnapshotQueryError ||
        error instanceof CoordinationOperationError ||
        error instanceof CoordinationClassNotEnabledError
      )
        return errorResponse("INVALID_REQUEST", error.message, 400);
      if (error instanceof ProjectNotFoundError) return projectNotFound();
      if (error instanceof PlanningScopeNotFoundError)
        return errorResponse("NOT_FOUND", "Milestone not found", 404);
      if (error instanceof CoordinationResponseTooLargeError)
        return errorResponse("PAYLOAD_TOO_LARGE", error.message, 413);
      if (error instanceof PlanningReadBusyError)
        return busy("A write is in progress; retry");
      // Internal failures never leak a message or a stack trace to the
      // client; the operator log names only the error type.
      if (!this.closed)
        console.error(
        `Coordination listener read failed: ${error instanceof Error ? error.name : "unknown error"}`,
      );
      return errorResponse("INTERNAL_ERROR", "Query execution failed", 500);
    }
  }
}

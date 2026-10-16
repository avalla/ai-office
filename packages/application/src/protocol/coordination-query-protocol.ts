/**
 * Coordination query protocol (CB-10, ADR-0036 Decision 5).
 *
 * The route grammar of the read-only coordination listener. It is a profile
 * of its own, versioned apart from the dashboard query protocol: only GET
 * routes under {@link coordinationQueryPrefix}, a dedicated health route and
 * nothing else. Everything here is pure, so the CB-11B query client can
 * import it without the Runtime.
 */

import {
  coordinationApiVersion,
  coordinationReadOperations,
  type CoordinationReadOperation,
} from "../coordination/coordination-read-service.ts";
import { parseIdentifier, QueryValidationError } from "./query-protocol.ts";

export { coordinationApiVersion };

export const coordinationQueryPrefix = "/api/coordination/v1";

export const coordinationQueryLimits = {
  /** UTF-8 bytes of the request target after the path: `?` and parameters. */
  maxQueryBytes: 4096,
} as const;

export type CoordinationQueryErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "PAYLOAD_TOO_LARGE"
  | "RUNTIME_BUSY"
  | "INTERNAL_ERROR";

export interface CoordinationQueryErrorResponse {
  coordinationApiVersion: typeof coordinationApiVersion;
  error: { code: CoordinationQueryErrorCode; message: string };
}

/** Exactly the contract version, status and start instant; nothing else. */
export interface CoordinationHealthResponse {
  coordinationApiVersion: typeof coordinationApiVersion;
  status: "ok";
  startedAt: string;
}

export type CoordinationRoute =
  | { kind: "health" }
  | {
      kind: "read";
      projectId: string;
      operation: CoordinationReadOperation;
    }
  | { kind: "not_found" };

/**
 * Matches a request path. Anything outside the grammar, including every
 * dashboard and command route, is `not_found`; there is no wildcard.
 */
export function parseCoordinationRoute(pathname: string): CoordinationRoute {
  if (!pathname.startsWith(`${coordinationQueryPrefix}/`))
    return { kind: "not_found" };
  const segments = pathname.slice(coordinationQueryPrefix.length + 1).split("/");
  if (segments.length === 1 && segments[0] === "health")
    return { kind: "health" };
  if (segments.length !== 3 || segments[0] !== "projects")
    return { kind: "not_found" };
  let projectId: string;
  try {
    projectId = decodeURIComponent(segments[1]!);
  } catch {
    throw new QueryValidationError("project is not a valid identifier");
  }
  const operation = segments[2]!;
  if (!(coordinationReadOperations as readonly string[]).includes(operation))
    return { kind: "not_found" };
  return {
    kind: "read",
    projectId: parseIdentifier(projectId, "project"),
    operation: operation as CoordinationReadOperation,
  };
}

export interface CoordinationReadParameters {
  milestoneId: string | null;
  offset?: number;
  limit?: number;
  classes?: string[];
}

const parameterNames = ["milestone", "offset", "limit", "classes"] as const;

function decimal(name: string, value: string): number {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value))
    throw new QueryValidationError(
      `${name} must be a non-negative decimal integer`,
    );
  return Number(value);
}

/**
 * Parses the closed parameter set of a read route. An unknown or repeated
 * parameter is refused, never ignored.
 */
export function parseCoordinationReadParameters(
  parameters: URLSearchParams,
): CoordinationReadParameters {
  const seen = new Set<string>();
  for (const name of parameters.keys()) {
    if (!(parameterNames as readonly string[]).includes(name))
      throw new QueryValidationError(`Unknown parameter ${name.slice(0, 64)}`);
    if (seen.has(name))
      throw new QueryValidationError(`Parameter ${name} is repeated`);
    seen.add(name);
  }
  const milestone = parameters.get("milestone");
  const offset = parameters.get("offset");
  const limit = parameters.get("limit");
  const classes = parameters.get("classes");
  return {
    milestoneId:
      milestone === null ? null : parseIdentifier(milestone, "milestone"),
    ...(offset === null ? {} : { offset: decimal("offset", offset) }),
    ...(limit === null ? {} : { limit: decimal("limit", limit) }),
    ...(classes === null ? {} : { classes: classes.split(",") }),
  };
}

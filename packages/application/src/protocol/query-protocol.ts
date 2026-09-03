/**
 * Local query protocol.
 *
 * The daemon exposes two independent contracts on the same Unix socket: the
 * existing command protocol (`daemon-protocol.ts`, version 1) and this
 * read-only query protocol. They are versioned separately because they change
 * for different reasons — a new CLI command does not change how a dashboard
 * reads operational state, and vice versa.
 *
 * Everything here is pure: parsing, validation, and limits. No transport, no
 * storage, no domain logic.
 */

export const queryApiVersion = 1 as const;

/** Prefix of every read-only query route on the daemon socket. */
export const queryApiPrefix = "/api";

export const queryLimits = {
  activity: { default: 50, max: 200 },
  tasks: { default: 100, max: 500 },
  runs: { default: 50, max: 200 },
  runEvents: { default: 100, max: 500 },
  reviews: { default: 50, max: 200 },
  pipelines: { default: 50, max: 200 },
  /** Upper bound on identifier length accepted from a route parameter. */
  maxIdentifierLength: 128,
} as const;

/**
 * Invalidation topics published when authoritative state may have changed.
 *
 * These are hints that tell a client which queries to re-run. They are not a
 * change log and carry no state of their own, so they cannot become a second
 * source of truth.
 */
export const queryEventTopics = [
  "project.updated",
  "task.updated",
  "run.updated",
  "pipeline.updated",
  "review.updated",
  "approval.updated",
  "activity.created",
] as const;

export type QueryEventTopic = (typeof queryEventTopics)[number];

export interface QueryEvent {
  topic: QueryEventTopic;
  /** Present when the change is known to be scoped to one project. */
  projectId?: string;
  occurredAt: string;
}

export type QueryErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "TOO_MANY_SUBSCRIBERS"
  | "INTERNAL_ERROR";

export interface QueryErrorResponse {
  queryApiVersion: typeof queryApiVersion;
  error: { code: QueryErrorCode; message: string };
}

/** Every successful query response carries the contract version. */
export type QueryResponse<T> = { queryApiVersion: typeof queryApiVersion } & T;

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

const identifierPattern = /^[A-Za-z0-9._:-]+$/;

/**
 * Validates an identifier taken from a route or query parameter.
 *
 * Identifiers reach SQL as bound parameters, so this is a contract check rather
 * than an injection defence: it keeps malformed input from being reported as
 * "not found" and bounds the work a request can request.
 */
export function parseIdentifier(
  value: string | undefined,
  name: string,
): string {
  if (value === undefined || value.length === 0)
    throw new QueryValidationError(`${name} is required`);
  if (value.length > queryLimits.maxIdentifierLength)
    throw new QueryValidationError(`${name} is too long`);
  if (!identifierPattern.test(value))
    throw new QueryValidationError(`${name} is not a valid identifier`);
  return value;
}

export function parseLimit(
  value: string | null,
  bounds: { default: number; max: number },
): number {
  if (value === null || value === "") return bounds.default;
  if (!/^\d{1,6}$/.test(value))
    throw new QueryValidationError("limit must be a positive integer");
  const parsed = Number(value);
  if (parsed < 1) throw new QueryValidationError("limit must be at least 1");
  return Math.min(parsed, bounds.max);
}

export function parseInstant(
  value: string | null,
  name: string,
): Date | undefined {
  if (value === null || value === "") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new QueryValidationError(`${name} must be an ISO-8601 instant`);
  return parsed;
}

export function parseBoolean(value: string | null, name: string): boolean {
  if (value === null || value === "" || value === "false") return false;
  if (value === "true" || value === "1") return true;
  throw new QueryValidationError(`${name} must be true or false`);
}

/**
 * Maps a completed daemon command to the query topics it may have invalidated.
 *
 * The mapping is intentionally coarse and conservative: it may invalidate more
 * than strictly necessary, but it must never claim a change did not happen.
 * Every completed command appends audit rows, so `activity.created` is always
 * included.
 */
export function commandInvalidationTopics(
  command: string,
): readonly QueryEventTopic[] {
  const topics = new Set<QueryEventTopic>(["activity.created"]);
  const add = (...values: QueryEventTopic[]) => {
    for (const value of values) topics.add(value);
  };

  if (command.startsWith("task:")) add("task.updated", "project.updated");
  else if (command.startsWith("run:"))
    add("run.updated", "task.updated", "pipeline.updated");
  else if (command.startsWith("pipeline:"))
    add("pipeline.updated", "task.updated", "run.updated");
  else if (command.startsWith("review:"))
    add("review.updated", "approval.updated", "task.updated");
  else if (command.startsWith("action:")) add("run.updated", "project.updated");
  else if (
    command.startsWith("milestone:") ||
    command.startsWith("requirement:") ||
    command.startsWith("adr:") ||
    command.startsWith("governance:")
  )
    add("project.updated", "review.updated");
  else if (command.startsWith("agent:")) add("project.updated", "run.updated");
  else if (
    command.startsWith("project:") ||
    command.startsWith("office:") ||
    command === "install" ||
    command === "uninstall" ||
    command === "handover:confirm"
  )
    add("project.updated", "task.updated", "pipeline.updated");

  return [...topics];
}

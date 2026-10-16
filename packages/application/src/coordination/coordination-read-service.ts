/**
 * The client-neutral coordination read API (CB-10, ADR-0036 Decisions 5 and 7).
 *
 * One application service over the CB-02 planning read model. The CLI and the
 * read-only coordination listener call it, and later adapters (the GitHub
 * bridge, the MCP server) reach it through that listener; none recomputes the
 * read model or has an authority path of its own. Every response is built by
 * the exposure registry's mappers and is bounded in size.
 */

import { createHash } from "node:crypto";
import { ProjectNotFoundError } from "../errors.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type { TaskStatus } from "@ai-office/domain/task/task.ts";
import {
  exposeItem,
  type CoordinationExposedCollection,
  type CoordinationExposedItem,
} from "./coordination-exposure.ts";
import {
  planningClassSet,
  PlanningSnapshotQueryError,
  type GetPlanningSnapshot,
} from "./get-planning-snapshot.ts";
import {
  planningSnapshotPage,
  type PlanningDataClass,
  type PlanningSnapshot,
  type PlanningSnapshotCollection,
  type PlanningSnapshotScope,
  type planningSnapshotSchemaVersion,
} from "./planning-snapshot.ts";

export const coordinationApiVersion = 1 as const;

export const coordinationReadOperations = [
  "status",
  "milestones",
  "tasks",
  "requirements",
  "dependencies",
  "blockers",
  "runnable",
] as const;

export type CoordinationReadOperation =
  (typeof coordinationReadOperations)[number];

export const coordinationResponseLimits = {
  /** Serialized UTF-8 bytes of one response. */
  maxResponseBytes: 256 * 1024,
} as const;

const taskStatuses = [
  "pending",
  "assigned",
  "running",
  "blocked",
  "waiting_review",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TaskStatus[];

/** The read operation is not one of {@link coordinationReadOperations}. */
export class CoordinationOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinationOperationError";
  }
}

/** A requested data class is not enabled for this caller. */
export class CoordinationClassNotEnabledError extends Error {
  constructor() {
    super("The requested data classes are not enabled for this project");
    this.name = "CoordinationClassNotEnabledError";
  }
}

/** The response would exceed {@link coordinationResponseLimits}. */
export class CoordinationResponseTooLargeError extends Error {
  constructor() {
    super(
      `The response exceeds ${coordinationResponseLimits.maxResponseBytes} bytes; request a smaller limit`,
    );
    this.name = "CoordinationResponseTooLargeError";
  }
}

export interface CoordinationReadQuery {
  projectId: string;
  operation: string;
  milestoneId?: string | null | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  /** Requested classes; defaults to every allowed class. */
  classes?: readonly string[] | undefined;
}

/**
 * Who may read what. `owner` is the trusted-local operator on the main
 * socket: every project, classes P and T. `exposure` is the owner's
 * listener configuration: only the listed projects, each with its enabled
 * classes; any other project answers exactly like a missing one. Every
 * adapter passes its policy here, so no adapter holds an authority check of
 * its own.
 */
export type CoordinationReadPolicy =
  | { kind: "owner" }
  | {
      kind: "exposure";
      /** Project id to its enabled classes; P is always among them. */
      projects: ReadonlyMap<string, readonly PlanningDataClass[]>;
    };

interface CoordinationResponseBase {
  coordinationApiVersion: typeof coordinationApiVersion;
  operation: CoordinationReadOperation;
  schemaVersion: typeof planningSnapshotSchemaVersion;
  snapshotId: string;
  scope: PlanningSnapshotScope;
  classes: PlanningDataClass[];
  counts: Record<PlanningSnapshotCollection, number>;
}

export interface CoordinationStatusResponse extends CoordinationResponseBase {
  operation: "status";
  /** Tasks in the scope by recorded status; every status is present. */
  taskStatusCounts: Record<TaskStatus, number>;
}

export interface CoordinationCollectionResponse
  extends CoordinationResponseBase {
  collection: CoordinationExposedCollection;
  section: "authoritative" | "derived";
  page: { offset: number; limit: number; total: number; truncated: boolean };
  /** `sha256:<hex>` of the canonical response without this field. */
  pageDigest: string;
  items: CoordinationExposedItem[];
}

export type CoordinationReadResponse =
  | CoordinationStatusResponse
  | CoordinationCollectionResponse;

function isOperation(value: string): value is CoordinationReadOperation {
  return (coordinationReadOperations as readonly string[]).includes(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

const ownerClasses: readonly PlanningDataClass[] = ["P", "T"];

const exposedCollections = [
  "milestones",
  "tasks",
  "requirements",
  "dependencies",
  "blockers",
  "runnable",
] as const satisfies readonly CoordinationExposedCollection[];

/**
 * The whole scope as it may leave the Runtime, and its identity. The
 * coordination `snapshotId` is the digest of this exposed projection, not
 * the CB-02 identity over stored values: a scrubbed credential or the cut
 * tail of a title must not change an identity a caller can see, or the
 * identity would confirm a guessed secret.
 */
function exposedProjection(
  snapshot: PlanningSnapshot,
  counts: Record<PlanningSnapshotCollection, number>,
): {
  snapshotId: string;
  collections: Record<CoordinationExposedCollection, CoordinationExposedItem[]>;
} {
  const collections = {
    milestones: snapshot.authoritative.milestones,
    tasks: snapshot.authoritative.tasks,
    requirements: snapshot.authoritative.requirements,
    dependencies: snapshot.authoritative.dependencies,
    blockers: snapshot.derived.blockers,
    runnable: snapshot.derived.runnable,
  } satisfies Record<CoordinationExposedCollection, readonly object[]>;
  const exposed = Object.fromEntries(
    exposedCollections.map((name) => [
      name,
      collections[name].map((item) =>
        exposeItem(name, item, snapshot.classes),
      ),
    ]),
  ) as Record<CoordinationExposedCollection, CoordinationExposedItem[]>;
  return {
    snapshotId: `snapshot:sha256:${sha256({
      coordinationApiVersion,
      schemaVersion: snapshot.schemaVersion,
      scope: snapshot.scope,
      classes: snapshot.classes,
      counts,
      collections: exposed,
    })}`,
    collections: exposed,
  };
}

export class CoordinationReadService {
  constructor(private readonly snapshots: GetPlanningSnapshot) {}

  async execute(
    query: CoordinationReadQuery,
    policy: CoordinationReadPolicy = { kind: "owner" },
  ): Promise<CoordinationReadResponse> {
    if (!isOperation(query.operation))
      throw new CoordinationOperationError(
        `Coordination operation must be one of: ${coordinationReadOperations.join(", ")}`,
      );
    const allowedClasses =
      policy.kind === "owner"
        ? ownerClasses
        : policy.projects.get(query.projectId);
    if (allowedClasses === undefined)
      throw new ProjectNotFoundError(query.projectId);
    const requested = query.classes ?? allowedClasses;
    // Validate the class grammar first, so an invalid value is reported as
    // invalid rather than as not enabled.
    const classes = planningClassSet(requested);
    if (classes.some((value) => !allowedClasses.includes(value)))
      throw new CoordinationClassNotEnabledError();

    const response =
      query.operation === "status"
        ? await this.status(query, classes)
        : await this.collection(query, query.operation, classes);
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      coordinationResponseLimits.maxResponseBytes
    )
      throw new CoordinationResponseTooLargeError();
    return response;
  }

  private async status(
    query: CoordinationReadQuery,
    classes: PlanningDataClass[],
  ): Promise<CoordinationStatusResponse> {
    if (query.offset !== undefined || query.limit !== undefined)
      throw new PlanningSnapshotQueryError(
        "The status operation takes no offset or limit",
      );
    const snapshot = await this.snapshots.readSnapshot({
      projectId: query.projectId,
      milestoneId: query.milestoneId,
      classes,
    });
    const taskStatusCounts = Object.fromEntries(
      taskStatuses.map((status) => [
        status,
        snapshot.authoritative.tasks.filter((task) => task.status === status)
          .length,
      ]),
    ) as Record<TaskStatus, number>;
    const { counts } = planningSnapshotPage(snapshot, "tasks", {
      offset: 0,
      limit: 1,
    });
    return {
      coordinationApiVersion,
      operation: "status",
      schemaVersion: snapshot.schemaVersion,
      snapshotId: exposedProjection(snapshot, counts).snapshotId,
      scope: snapshot.scope,
      classes: snapshot.classes,
      counts,
      taskStatusCounts,
    };
  }

  private async collection(
    query: CoordinationReadQuery,
    collection: CoordinationExposedCollection,
    classes: PlanningDataClass[],
  ): Promise<CoordinationCollectionResponse> {
    const { snapshot, page } = await this.snapshots.executeWithSnapshot({
      projectId: query.projectId,
      milestoneId: query.milestoneId,
      collection,
      offset: query.offset,
      limit: query.limit,
      classes,
    });
    const exposed = exposedProjection(snapshot, page.counts);
    const header = {
      coordinationApiVersion,
      operation: collection,
      schemaVersion: page.schemaVersion,
      snapshotId: exposed.snapshotId,
      scope: page.scope,
      classes: page.classes,
      counts: page.counts,
      collection,
      section: page.section,
      page: page.page,
    };
    const items = exposed.collections[collection].slice(
      page.page.offset,
      page.page.offset + page.items.length,
    );
    return {
      ...header,
      pageDigest: `sha256:${sha256({ ...header, items })}`,
      items,
    };
  }
}

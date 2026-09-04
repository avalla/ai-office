import { createHash } from "node:crypto";
import * as z from "zod";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import {
  assertNoSensitiveFields,
  isSensitiveFieldKey,
  normalizeSensitiveFieldKey,
} from "@ai-office/domain/capability/sensitive-fields.ts";
import { officeManifestSchema } from "../office/office-manifest-schema.ts";
import { portableGitRemote } from "./project-git-provenance.ts";

export const portableProjectFormat = "ai-office-project" as const;
export const portableProjectFormatVersion = 1 as const;
export const portableProjectExtension = ".aioffice" as const;
export const maximumPortableProjectBytes = 32 * 1024 * 1024;

const id = z.string().trim().min(1).max(256);
const shortText = z.string().max(2_000);
const longText = z.string().max(256_000);
const timestamp = z.string().refine(
  (value) => {
    const parsed = Date.parse(value);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
  },
  {
    message: "must be a canonical UTC ISO-8601 timestamp",
  },
);
const checksum = z.string().regex(/^[0-9a-f]{64}$/u);
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const actor = z.strictObject({
  type: z.enum(["user", "agent", "system"]),
  id,
  displayName: shortText.optional(),
});

const portableProjectStateShape = z.strictObject({
  project: z.strictObject({
    name: z.string().trim().min(1).max(500),
    description: longText.optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  tasks: z
    .array(
      z.strictObject({
        id,
        title: z.string().trim().min(1).max(10_000),
        description: longText.optional(),
        status: z.enum([
          "pending",
          "assigned",
          "running",
          "blocked",
          "waiting_review",
          "completed",
          "failed",
          "cancelled",
        ]),
        priority: z.number().int().safe(),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    )
    .max(100_000),
  profileEntries: z
    .array(
      z.strictObject({
        id,
        category: shortText,
        key: shortText,
        value: jsonValue,
        origin: z.enum(["detected", "inferred", "user"]),
        confidence: z.number().min(0).max(1),
        confirmedAt: timestamp.optional(),
        createdAt: timestamp,
      }),
    )
    .max(100_000),
  officeManifests: z
    .array(
      z.strictObject({
        id,
        revision: z.number().int().positive(),
        manifest: officeManifestSchema,
        appliedAt: timestamp,
      }),
    )
    .max(10_000),
  governance: z.strictObject({
    milestones: z.array(
      z.strictObject({
        id,
        title: shortText,
        description: longText.optional(),
        status: z.enum(["planned", "active", "completed", "cancelled"]),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    requirements: z.array(
      z.strictObject({
        id,
        milestoneId: id.optional(),
        key: shortText,
        title: shortText,
        description: longText,
        status: z.enum([
          "proposed",
          "accepted",
          "implemented",
          "verified",
          "rejected",
        ]),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    adrs: z.array(
      z.strictObject({
        id,
        title: shortText,
        context: longText,
        decision: longText,
        consequences: longText,
        status: z.enum([
          "proposed",
          "accepted",
          "rejected",
          "deprecated",
          "superseded",
        ]),
        supersededById: id.optional(),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    /**
     * Explicit Task <-> Requirement links.
     *
     * Optional, and omitted entirely when a project has none, on purpose. The
     * archive checksum is recomputed over the *parsed* state, so any key that
     * is always present would change the checksum of every existing v1 archive
     * and make it unreadable. Omitting it keeps a link-free project's archive
     * byte-identical to one produced before this field existed, while an
     * archive that does carry links is correctly refused by an older binary
     * that could not restore them.
     *
     * It lives under `governance` rather than at the top level because
     * `manifest.contents` is a frozen tuple in format version 1: adding an
     * entry would break old manifests, and the link is the requirement-side
     * association that the existing `governance` entry already declares.
     */
    taskRequirements: z
      .array(
        z.strictObject({
          taskId: id,
          requirementId: id,
          createdAt: timestamp,
        }),
      )
      .max(1_000_000)
      .optional(),
    reviews: z.array(
      z.strictObject({
        id,
        subjectType: z.enum([
          "task",
          "agent_run",
          "requirement",
          "adr",
          "milestone",
        ]),
        subjectId: id,
        reviewer: actor,
        status: z.enum(["pending", "approved", "rejected"]),
        summary: longText.optional(),
        createdAt: timestamp,
        completedAt: timestamp.optional(),
      }),
    ),
    approvals: z.array(
      z.strictObject({
        id,
        reviewId: id,
        decision: z.enum(["approved", "rejected"]),
        actor,
        rationale: longText.optional(),
        createdAt: timestamp,
      }),
    ),
  }),
  agents: z.strictObject({
    roles: z.array(
      z.strictObject({
        id,
        key: shortText,
        name: shortText,
        version: z.number().int().positive(),
        capabilities: z.array(shortText).max(1_000),
        tools: z.array(shortText).max(1_000),
        modelPolicy: shortText,
        limits: z.strictObject({
          maxIterations: z.number().int().positive(),
          maxCostMicros: z.string().regex(/^\d+$/u),
          timeoutSeconds: z.number().int().positive(),
        }),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    definitions: z.array(
      z.strictObject({
        id,
        roleId: id,
        name: shortText,
        enabled: z.boolean(),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    terminalRuns: z.array(
      z.strictObject({
        id,
        taskId: id,
        agentId: id,
        status: z.enum(["completed", "failed", "cancelled"]),
        createdAt: timestamp,
        startedAt: timestamp.optional(),
        completedAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
  }),
});

export const portableProjectStateSchema = portableProjectStateShape.superRefine(
  (state, context) => {
    const milestones = new Set(
      state.governance.milestones.map((item) => item.id),
    );
    const requirements = new Set(
      state.governance.requirements.map((item) => item.id),
    );
    const adrs = new Set(state.governance.adrs.map((item) => item.id));
    const tasks = new Set(state.tasks.map((item) => item.id));
    const roles = new Set(state.agents.roles.map((item) => item.id));
    const agents = new Set(state.agents.definitions.map((item) => item.id));
    const runs = new Set(state.agents.terminalRuns.map((item) => item.id));
    const reviews = new Map(
      state.governance.reviews.map((item) => [item.id, item] as const),
    );
    const approvals = new Map<
      string,
      (typeof state.governance.approvals)[number]
    >();

    const missing = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: "custom", path, message });
    };
    for (const [index, item] of state.governance.requirements.entries())
      if (item.milestoneId !== undefined && !milestones.has(item.milestoneId))
        missing(
          ["governance", "requirements", index, "milestoneId"],
          `Referenced milestone ${item.milestoneId} is not portable`,
        );
    for (const [index, item] of state.governance.adrs.entries())
      if (item.supersededById !== undefined && !adrs.has(item.supersededById))
        missing(
          ["governance", "adrs", index, "supersededById"],
          `Referenced ADR ${item.supersededById} is not portable`,
        );
    const subjects = {
      task: tasks,
      agent_run: runs,
      requirement: requirements,
      adr: adrs,
      milestone: milestones,
    };
    for (const [index, item] of state.governance.reviews.entries()) {
      if (!subjects[item.subjectType].has(item.subjectId))
        missing(
          ["governance", "reviews", index, "subjectId"],
          `Referenced ${item.subjectType} ${item.subjectId} is not portable`,
        );
    }
    for (const [index, item] of state.governance.approvals.entries()) {
      const review = reviews.get(item.reviewId);
      if (review === undefined) {
        missing(
          ["governance", "approvals", index, "reviewId"],
          `Referenced review ${item.reviewId} is not portable`,
        );
        continue;
      }
      if (approvals.has(item.reviewId))
        missing(
          ["governance", "approvals", index, "reviewId"],
          `Review ${item.reviewId} has more than one approval`,
        );
      approvals.set(item.reviewId, item);
      if (review.status !== item.decision)
        missing(
          ["governance", "approvals", index, "decision"],
          `Approval decision does not match review ${item.reviewId}`,
        );
    }
    for (const [index, item] of state.governance.reviews.entries()) {
      const approval = approvals.get(item.id);
      if (item.status === "pending") {
        if (approval !== undefined)
          missing(
            ["governance", "reviews", index, "status"],
            `Pending review ${item.id} cannot have an approval`,
          );
        if (item.completedAt !== undefined)
          missing(
            ["governance", "reviews", index, "completedAt"],
            `Pending review ${item.id} cannot be completed`,
          );
      } else {
        if (approval === undefined)
          missing(
            ["governance", "reviews", index, "status"],
            `Decided review ${item.id} requires a portable approval`,
          );
        if (item.completedAt === undefined)
          missing(
            ["governance", "reviews", index, "completedAt"],
            `Decided review ${item.id} requires a completion timestamp`,
          );
      }
    }
    for (const [index, item] of state.agents.definitions.entries())
      if (!roles.has(item.roleId))
        missing(
          ["agents", "definitions", index, "roleId"],
          `Referenced role ${item.roleId} is not portable`,
        );
    const links = new Set<string>();
    for (const [index, item] of (
      state.governance.taskRequirements ?? []
    ).entries()) {
      const path = ["governance", "taskRequirements", index] as const;
      // A link is meaningless without both ends inside the snapshot, so
      // referential closure is enforced here rather than discovered at restore.
      if (!tasks.has(item.taskId))
        missing(
          [...path, "taskId"],
          `Referenced task ${item.taskId} is not portable`,
        );
      if (!requirements.has(item.requirementId))
        missing(
          [...path, "requirementId"],
          `Referenced requirement ${item.requirementId} is not portable`,
        );
      const key = `${item.taskId}\u0000${item.requirementId}`;
      if (links.has(key))
        missing(
          [...path],
          `Task ${item.taskId} is linked to requirement ${item.requirementId} more than once`,
        );
      links.add(key);
    }
    for (const [index, item] of state.agents.terminalRuns.entries()) {
      if (!tasks.has(item.taskId))
        missing(
          ["agents", "terminalRuns", index, "taskId"],
          `Referenced task ${item.taskId} is not portable`,
        );
      if (!agents.has(item.agentId))
        missing(
          ["agents", "terminalRuns", index, "agentId"],
          `Referenced agent ${item.agentId} is not portable`,
        );
    }
  },
);

export type PortableProjectState = z.infer<typeof portableProjectStateSchema>;

export const portableProjectManifestSchema = z.strictObject({
  format: z.literal(portableProjectFormat),
  formatVersion: z.literal(portableProjectFormatVersion),
  projectIdentity: id,
  createdAt: timestamp,
  revision: z.strictObject({
    id,
    parentRevisionId: id.optional(),
    stateChecksum: checksum,
  }),
  source: z
    .strictObject({
      type: z.enum(["git", "directory"]),
      remote: z
        .string()
        .max(8_000)
        .refine((value) => portableGitRemote(value) === value, {
          message: "must be normalized network-safe Git provenance",
        })
        .optional(),
      branch: shortText.optional(),
    })
    .optional(),
  contents: z.tuple([
    z.literal("project"),
    z.literal("tasks"),
    z.literal("profile"),
    z.literal("office_manifests"),
    z.literal("governance"),
    z.literal("agent_definitions"),
    z.literal("terminal_run_summaries"),
  ]),
});

export type PortableProjectManifest = z.infer<
  typeof portableProjectManifestSchema
>;

export const portableProjectArchiveSchema = z.strictObject({
  manifest: portableProjectManifestSchema,
  state: portableProjectStateSchema,
  integrity: z.strictObject({
    algorithm: z.literal("sha256"),
    checksum,
  }),
});

export type PortableProjectArchive = z.infer<
  typeof portableProjectArchiveSchema
>;

export class PortableProjectArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableProjectArchiveError";
  }
}

const sensitiveProfileLabelSuffixes = [
  "apikey",
  "accesstoken",
  "password",
  "secret",
  "credential",
  "credentialref",
  "credentials",
  "authorization",
  "token",
] as const;

function sensitiveProfileLabel(value: string): boolean {
  if (isSensitiveFieldKey(value)) return true;
  const normalized = normalizeSensitiveFieldKey(value);
  return sensitiveProfileLabelSuffixes.some(
    (suffix) => normalized.length > suffix.length && normalized.endsWith(suffix),
  );
}

export function assertPortableProfileEntriesSafe(
  entries: PortableProjectState["profileEntries"],
): void {
  for (const entry of entries) {
    const sensitiveLabel = [entry.key, entry.category].find(
      sensitiveProfileLabel,
    );
    if (sensitiveLabel === undefined) continue;
    throw new PortableProjectArchiveError(
      `Portable snapshot rejected: project profile entry ${entry.id} is labelled as sensitive credential data (${sensitiveLabel}). Move credentials to the AI Office credential/secret mechanism before creating a backup.`,
    );
  }
}

export function assertPortableProjectStateSafe(
  state: PortableProjectState,
): void {
  assertNoSensitiveFields(state, "Portable project state");
  assertPortableProfileEntriesSafe(state.profileEntries);
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalStringify(value), "utf8")
    .digest("hex");
}

export function portableStateChecksum(state: PortableProjectState): string {
  return sha256Canonical(state);
}

export function createPortableProjectArchive(input: {
  manifest: PortableProjectManifest;
  state: PortableProjectState;
}): PortableProjectArchive {
  const state = portableProjectStateSchema.parse(input.state);
  assertPortableProjectStateSafe(state);
  const stateChecksum = portableStateChecksum(state);
  if (input.manifest.revision.stateChecksum !== stateChecksum)
    throw new PortableProjectArchiveError(
      "Snapshot revision checksum does not match portable state",
    );
  const manifest = portableProjectManifestSchema.parse(input.manifest);
  const basis = { manifest, state };
  return {
    ...basis,
    integrity: { algorithm: "sha256", checksum: sha256Canonical(basis) },
  };
}

export function serializePortableProjectArchive(
  archive: PortableProjectArchive,
): string {
  return `${canonicalStringify(archive)}\n`;
}

export function parsePortableProjectArchive(
  text: string,
): PortableProjectArchive {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new PortableProjectArchiveError(
      "Portable project archive is not valid JSON",
    );
  }
  const parsed = portableProjectArchiveSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PortableProjectArchiveError(
      issue === undefined
        ? "Portable project archive does not match format version 1"
        : `Portable project archive ${issue.path.join(".") || "root"}: ${issue.message}`,
    );
  }
  assertPortableProjectStateSafe(parsed.data.state);
  const expectedState = portableStateChecksum(parsed.data.state);
  if (parsed.data.manifest.revision.stateChecksum !== expectedState)
    throw new PortableProjectArchiveError(
      "Portable project archive state checksum mismatch",
    );
  const expectedArchive = sha256Canonical({
    manifest: parsed.data.manifest,
    state: parsed.data.state,
  });
  if (parsed.data.integrity.checksum !== expectedArchive)
    throw new PortableProjectArchiveError(
      "Portable project archive integrity checksum mismatch",
    );
  return parsed.data;
}

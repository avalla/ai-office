import { createHash } from "node:crypto";
import * as z from "zod";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import { assertNoSensitiveFields } from "@ai-office/domain/capability/sensitive-fields.ts";
import { officeManifestSchema } from "../office/office-manifest-schema.ts";

export const portableProjectFormat = "ai-office-project" as const;
export const portableProjectFormatVersion = 1 as const;
export const portableProjectExtension = ".aioffice" as const;
export const maximumPortableProjectBytes = 32 * 1024 * 1024;

const id = z.string().trim().min(1).max(256);
const shortText = z.string().max(2_000);
const longText = z.string().max(256_000);
const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be an ISO-8601 timestamp",
  });
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

export const portableProjectStateSchema = z.strictObject({
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
      remote: z.string().max(8_000).optional(),
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
  assertNoSensitiveFields(state, "Portable project state");
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
  assertNoSensitiveFields(parsed.data.state, "Portable project state");
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

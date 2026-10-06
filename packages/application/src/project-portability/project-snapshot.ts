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
import { assertAcyclicDependency } from "@ai-office/domain/task/task-dependency.ts";
import {
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
} from "../../../domain-pack-contracts/src/index.ts";
import {
  hasAgentReferences,
  isDefinitionText,
  maximumDefinitionTextLength,
  maximumWorkflowStages,
} from "../domain-pack/project-definition.ts";

export const portableProjectFormat = "ai-office-project" as const;

/**
 * Portable archive format versions, each identifying exactly one schema.
 *
 * Version 1 is frozen at the shape it shipped with: `governance` is strict and
 * carries no `taskRequirements`, so a v1 archive cannot express a
 * Task <-> Requirement link and a v1 reader never has to guess.
 *
 * Version 2 adds that link, as a required `governance.taskRequirements` array
 * and a matching `contents` entry. Extending v1 to mean "sometimes with links"
 * would have left one version number describing two contracts: an archive an
 * old binary legitimately believes it understands, whose strict schema it then
 * rejects.
 *
 * Historical v1-v4 readers and their exact wire contracts remain supported.
 * New backups use v6 for authoritative project definitions. v5 remains frozen.
 * v7 has the v6 contents and additionally carries a role omission; it is
 * written only for a state that contains one, so v6 keeps its frozen meaning.
 * v8 has the v7 contents and additionally carries an agent disable and agent
 * reference fields; it is written only for a state that contains either.
 */
export const portableProjectFormatVersions = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type PortableProjectFormatVersion =
  (typeof portableProjectFormatVersions)[number];

/** Historical base format for a project with no Task <-> Requirement links. */
export const portableProjectBaseFormatVersion = 1 as const;
/** Historical linked-task format. */
export const portableProjectLinkedFormatVersion = 2 as const;
export const portableProjectDependencyFormatVersion = 3 as const;
export const portableProjectExecutionHistoryFormatVersion = 4 as const;
export const portableProjectPackBindingFormatVersion = 5 as const;
export const portableProjectDefinitionFormatVersion = 6 as const;
export const portableProjectRoleOmissionFormatVersion = 7 as const;
export const portableProjectAgentArchetypeFormatVersion = 8 as const;
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

const portableProjectCommonShape = {
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
} as const;

/**
 * Explicit Task <-> Requirement links, introduced in format version 2.
 *
 * It lives under `governance` rather than at the top level because the link is
 * the requirement-side association the existing `governance` content entry
 * already declares; version 2's `contents` tuple names it separately so the
 * manifest still describes what the archive holds.
 */
const taskRequirementLinks = z
  .array(
    z.strictObject({
      taskId: id,
      requirementId: id,
      createdAt: timestamp,
    }),
  )
  .max(1_000_000);

const taskDependencies = z
  .array(
    z.strictObject({
      taskId: id,
      dependsOnTaskId: id,
      createdAt: timestamp,
    }),
  )
  .max(1_000_000);

const taskExecutionHistory = z
  .array(
    z.strictObject({
      taskId: id,
      state: z.enum(["never", "unknown", "executed"]),
      firstKnownAt: timestamp.optional(),
    }),
  )
  .max(100_000);

const portablePackBinding = z
  .strictObject({
    configurationRevision: z.number().int().nonnegative().safe(),
    packs: z
      .array(
        z.strictObject({
          id: z.string().refine((value) => {
            try {
              parseDomainPackId(value);
              return true;
            } catch {
              return false;
            }
          }, "invalid Domain Pack ID"),
          version: z.string().refine((value) => {
            try {
              parseDomainPackVersion(value);
              return true;
            } catch {
              return false;
            }
          }, "invalid exact Domain Pack version"),
          manifestDigest: z.string().refine((value) => {
            try {
              parseManifestDigest(value);
              return true;
            } catch {
              return false;
            }
          }, "invalid manifest digest"),
        }),
      )
      .superRefine((packs, context) => {
        const seen = new Set<string>();
        for (const [index, pack] of packs.entries()) {
          if (seen.has(pack.id))
            context.addIssue({
              code: "custom",
              path: [index, "id"],
              message: `Pack ${pack.id} is selected more than once`,
            });
          if (index > 0 && packs[index - 1]!.id > pack.id)
            context.addIssue({
              code: "custom",
              path: [index, "id"],
              message: "Pack selection must be sorted by ID",
            });
          seen.add(pack.id);
        }
      }),
  })
  .superRefine((binding, context) => {
    if (binding.configurationRevision === 0 && binding.packs.length > 0)
      context.addIssue({
        code: "custom",
        path: ["configurationRevision"],
        message:
          "A nonempty selection requires a positive configuration revision",
      });
  });

const portableDefinitionKind = z.enum([
  "roles",
  "taskTypes",
  "agents",
  "artifactTypes",
  "evidenceTypes",
  "knowledge",
  "prompts",
]);
const portableOwnedKind = z.union([
  portableDefinitionKind,
  z.literal("workflows"),
]);
const portableDefinitionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const portableDefinitionText = z
  .string()
  .max(maximumDefinitionTextLength)
  .refine(isDefinitionText, {
    message: "must be valid Unicode text without U+0000",
  });
const portableDescriptivePayload = z.strictObject({
  id: portableDefinitionId,
  title: portableDefinitionText.optional(),
  description: portableDefinitionText.optional(),
});
const portableExtensionPayload = z.strictObject({
  title: portableDefinitionText.optional(),
  description: portableDefinitionText.optional(),
});
/** A non-empty set of local IDs; "none" is the absent field. */
const portableReferenceList = z
  .array(portableDefinitionId)
  .min(1)
  .refine((items) => new Set(items).size === items.length, {
    message: "Duplicate reference",
  });
/** The GP-12 agent envelope: descriptive fields and declarative references. */
const portableAgentPayload = portableDescriptivePayload.extend({
  role: portableDefinitionId.optional(),
  prompts: portableReferenceList.optional(),
  knowledge: portableReferenceList.optional(),
  capabilities: portableReferenceList.optional(),
});
const portableWorkflowPayload = portableDescriptivePayload.extend({
  taskType: portableDefinitionId,
  stages: z
    .array(
      z.strictObject({ id: portableDefinitionId, role: portableDefinitionId }),
    )
    .max(maximumWorkflowStages),
});
const portableExactDefinitionSource = z.strictObject({
  id: z.string().refine((value) => {
    try {
      parseDomainPackId(value);
      return true;
    } catch {
      return false;
    }
  }),
  version: z.string().refine((value) => {
    try {
      parseDomainPackVersion(value);
      return true;
    } catch {
      return false;
    }
  }),
  manifestDigest: z.string().refine((value) => {
    try {
      parseManifestDigest(value);
      return true;
    } catch {
      return false;
    }
  }),
  kind: portableDefinitionKind,
  localId: portableDefinitionId,
});
const portableDefinitionState = z
  .strictObject({
    revision: z.number().int().nonnegative().safe(),
    owned: z
      .array(
        z.strictObject({
          origin: z.literal("project_owned"),
          kind: portableOwnedKind,
          id: portableDefinitionId,
          revision: z.number().int().positive().safe(),
          enabled: z.boolean(),
          payload: z.union([
            portableDescriptivePayload,
            portableWorkflowPayload,
            portableAgentPayload,
          ]),
          actorId: id,
          changedAt: timestamp,
        }),
      )
      .max(100_000),
    overrides: z
      .array(
        z.strictObject({
          origin: z.literal("project_override"),
          source: portableExactDefinitionSource,
          operation: z.enum(["replace", "extend", "disable"]),
          revision: z.number().int().positive().safe(),
          payload: z
            .union([
              portableDescriptivePayload,
              portableExtensionPayload,
              portableAgentPayload,
            ])
            .optional(),
          actorId: id,
          changedAt: timestamp,
        }),
      )
      .max(100_000),
  })
  .superRefine((state, context) => {
    const owned = new Set<string>();
    for (const [index, item] of state.owned.entries()) {
      const key = `${item.kind}\u0000${item.id}`;
      if (owned.has(key) || item.payload.id !== item.id)
        context.addIssue({
          code: "custom",
          path: ["owned", index],
          message: "Duplicate or conflicting project definition identity",
        });
      if ((item.kind === "workflows") !== "stages" in item.payload)
        context.addIssue({
          code: "custom",
          path: ["owned", index, "payload"],
          message: "Workflow kind requires its typed payload",
        });
      // Only an agent has references, and a project-owned agent cannot
      // request capabilities.
      if (
        hasAgentReferences(item.payload) &&
        (item.kind !== "agents" || "capabilities" in item.payload)
      )
        context.addIssue({
          code: "custom",
          path: ["owned", index, "payload"],
          message: "Unsupported agent reference fields",
        });
      if (
        "stages" in item.payload &&
        new Set(item.payload.stages.map((stage) => stage.id)).size !==
          item.payload.stages.length
      )
        context.addIssue({
          code: "custom",
          path: ["owned", index, "payload", "stages"],
          message: "Duplicate workflow stage ID",
        });
      owned.add(key);
    }
    const overrides = new Set<string>();
    for (const [index, item] of state.overrides.entries()) {
      const source = item.source;
      const key = `${source.id}\u0000${source.version}\u0000${source.manifestDigest}\u0000${source.kind}\u0000${source.localId}`;
      if (overrides.has(key))
        context.addIssue({
          code: "custom",
          path: ["overrides", index],
          message: "Duplicate override target",
        });
      overrides.add(key);
      // Only a replacement of an agent has references, and requested
      // capabilities need a role.
      if (
        item.payload !== undefined &&
        hasAgentReferences(item.payload) &&
        (source.kind !== "agents" ||
          item.operation !== "replace" ||
          ("capabilities" in item.payload && !("role" in item.payload)))
      )
        context.addIssue({
          code: "custom",
          path: ["overrides", index, "payload"],
          message: "Unsupported agent reference fields",
        });
      if (
        (item.operation === "disable" &&
          (!["prompts", "roles", "agents"].includes(source.kind) ||
            item.payload !== undefined)) ||
        (item.operation !== "disable" &&
          (item.payload === undefined ||
            (item.operation === "replace" &&
              (!("id" in item.payload) ||
                item.payload.id !== source.localId)) ||
            (item.operation === "extend" &&
              ("id" in item.payload ||
                Object.keys(item.payload).length === 0))))
      )
        context.addIssue({
          code: "custom",
          path: ["overrides", index],
          message: "Unsupported or malformed override operation",
        });
    }
    if (
      state.revision === 0 &&
      (state.owned.length > 0 || state.overrides.length > 0)
    )
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Nonempty definition state needs a positive revision",
      });
  });
/**
 * Format 7 froze `disable` as prompt-or-role and payloads as descriptive; an
 * agent disable and agent reference fields need format 8.
 */
const portableDefinitionStateV7 = portableDefinitionState.superRefine(
  (state, context) => {
    for (const [index, item] of state.owned.entries())
      if (hasAgentReferences(item.payload))
        context.addIssue({
          code: "custom",
          path: ["owned", index, "payload"],
          message: "Unsupported agent reference fields",
        });
    for (const [index, item] of state.overrides.entries())
      if (
        (item.operation === "disable" && item.source.kind === "agents") ||
        (item.payload !== undefined && hasAgentReferences(item.payload))
      )
        context.addIssue({
          code: "custom",
          path: ["overrides", index],
          message: "Unsupported or malformed override operation",
        });
  },
);
/** Format 6 froze `disable` as prompt-only; a role omission needs format 7. */
const portableDefinitionStateV6 = portableDefinitionStateV7.superRefine(
  (state, context) => {
    for (const [index, item] of state.overrides.entries())
      if (item.operation === "disable" && item.source.kind === "roles")
        context.addIssue({
          code: "custom",
          path: ["overrides", index],
          message: "Unsupported or malformed override operation",
        });
  },
);

/** Governance exactly as format version 1 froze it. */
const portableGovernanceShape = z.strictObject({
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
});

const portableAgentsShape = z.strictObject({
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
});

/** The wire schema of a format version 1 archive's state. */
const portableProjectStateShapeV1 = z.strictObject({
  ...portableProjectCommonShape,
  governance: portableGovernanceShape,
  agents: portableAgentsShape,
});

/** The wire schema of a format version 2 archive's state. */
const portableProjectStateShapeV2 = z.strictObject({
  ...portableProjectCommonShape,
  governance: portableGovernanceShape.extend({
    taskRequirements: taskRequirementLinks,
  }),
  agents: portableAgentsShape,
});

const portableProjectStateShapeV3 = z.strictObject({
  ...portableProjectCommonShape,
  taskDependencies,
  governance: portableGovernanceShape.extend({
    taskRequirements: taskRequirementLinks,
  }),
  agents: portableAgentsShape,
});

const portableProjectStateShapeV4 = z.strictObject({
  ...portableProjectCommonShape,
  taskDependencies,
  taskExecutionHistory,
  governance: portableGovernanceShape.extend({
    taskRequirements: taskRequirementLinks,
  }),
  agents: portableAgentsShape,
});

const portableProjectStateShapeV5 = portableProjectStateShapeV4.extend({
  packBinding: portablePackBinding,
});
const portableProjectStateShapeV6 = portableProjectStateShapeV5.extend({
  definitions: portableDefinitionStateV6,
});
const portableProjectStateShapeV7 = portableProjectStateShapeV5.extend({
  definitions: portableDefinitionStateV7,
});
const portableProjectStateShapeV8 = portableProjectStateShapeV5.extend({
  definitions: portableDefinitionState,
});

/**
 * The producer/reader union. Fields added in later versions are optional here.
 *
 * This is the type the runtime builds and restores; which of the two wire
 * contracts it serializes into is decided by whether the links are there. It is
 * never the schema an archive is parsed with — those are strict per version, so
 * linkage can never appear in a v1 archive.
 */
const portableProjectStateShape = z.strictObject({
  ...portableProjectCommonShape,
  taskDependencies: taskDependencies.optional(),
  taskExecutionHistory: taskExecutionHistory.optional(),
  packBinding: portablePackBinding.optional(),
  definitions: portableDefinitionState.optional(),
  governance: portableGovernanceShape.extend({
    taskRequirements: taskRequirementLinks.optional(),
  }),
  agents: portableAgentsShape,
});

const referentialClosure = (
  state: z.infer<typeof portableProjectStateShape>,
  context: z.RefinementCtx,
) => {
  const milestones = new Set(
    state.governance.milestones.map((item) => item.id),
  );
  const requirements = new Set(
    state.governance.requirements.map((item) => item.id),
  );
  const adrs = new Set(state.governance.adrs.map((item) => item.id));
  const tasks = new Set(state.tasks.map((item) => item.id));
  const taskStatuses = new Map(
    state.tasks.map((item) => [item.id, item.status] as const),
  );
  const runTasks = new Set(
    state.agents.terminalRuns.map((item) => item.taskId),
  );
  const missing = (path: (string | number)[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  if (state.taskExecutionHistory !== undefined) {
    const histories = new Set<string>();
    for (const [index, item] of state.taskExecutionHistory.entries()) {
      if (!tasks.has(item.taskId))
        missing(
          ["taskExecutionHistory", index, "taskId"],
          `Referenced task ${item.taskId} is not portable`,
        );
      if (histories.has(item.taskId))
        missing(
          ["taskExecutionHistory", index, "taskId"],
          `Task ${item.taskId} has duplicate execution knowledge`,
        );
      histories.add(item.taskId);
      if (item.state !== "executed" && item.firstKnownAt !== undefined)
        missing(
          ["taskExecutionHistory", index, "firstKnownAt"],
          "Only executed history may have a known timestamp",
        );
      if (
        item.state !== "executed" &&
        ["running", "waiting_review"].includes(
          taskStatuses.get(item.taskId) ?? "",
        )
      )
        missing(
          ["taskExecutionHistory", index, "state"],
          "Active execution proves execution history",
        );
      if (item.state !== "executed" && runTasks.has(item.taskId))
        missing(
          ["taskExecutionHistory", index, "state"],
          "An AgentRun proves execution history",
        );
    }
    for (const taskId of tasks)
      if (!histories.has(taskId))
        missing(
          ["taskExecutionHistory"],
          `Task ${taskId} lacks explicit execution knowledge`,
        );
  }
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
  const dependencies = new Set<string>();
  const validatedEdges: { taskId: string; dependsOnTaskId: string }[] = [];
  for (const [index, item] of (state.taskDependencies ?? []).entries()) {
    const path = ["taskDependencies", index] as const;
    if (!tasks.has(item.taskId))
      missing(
        [...path, "taskId"],
        `Referenced task ${item.taskId} is not portable`,
      );
    if (!tasks.has(item.dependsOnTaskId))
      missing(
        [...path, "dependsOnTaskId"],
        `Referenced task ${item.dependsOnTaskId} is not portable`,
      );
    const key = `${item.taskId}\u0000${item.dependsOnTaskId}`;
    if (dependencies.has(key))
      missing(
        [...path],
        `Task dependency ${item.taskId} -> ${item.dependsOnTaskId} appears more than once`,
      );
    dependencies.add(key);
    try {
      assertAcyclicDependency(
        item.taskId,
        item.dependsOnTaskId,
        validatedEdges,
      );
    } catch {
      missing([...path], "Task dependencies contain a cycle");
    }
    validatedEdges.push(item);
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
};

/**
 * Referential closure is the same rule in both versions, applied once. A v1
 * state simply has no links to close.
 */
export const portableProjectStateSchema =
  portableProjectStateShape.superRefine(referentialClosure);
export const portableProjectStateSchemaV1 =
  portableProjectStateShapeV1.superRefine(referentialClosure);
export const portableProjectStateSchemaV2 =
  portableProjectStateShapeV2.superRefine(referentialClosure);
export const portableProjectStateSchemaV3 =
  portableProjectStateShapeV3.superRefine(referentialClosure);
export const portableProjectStateSchemaV4 =
  portableProjectStateShapeV4.superRefine(referentialClosure);
export const portableProjectStateSchemaV5 =
  portableProjectStateShapeV5.superRefine(referentialClosure);
export const portableProjectStateSchemaV6 =
  portableProjectStateShapeV6.superRefine(referentialClosure);
export const portableProjectStateSchemaV7 =
  portableProjectStateShapeV7.superRefine(referentialClosure);
export const portableProjectStateSchemaV8 =
  portableProjectStateShapeV8.superRefine(referentialClosure);

export type PortableProjectState = z.infer<typeof portableProjectStateSchema>;

/** Task <-> Requirement links carried by a state, in either version. */
export function portableTaskRequirementLinks(
  state: PortableProjectState,
): readonly { taskId: string; requirementId: string; createdAt: string }[] {
  return state.governance.taskRequirements ?? [];
}

/**
 * The lowest format version that can express this state without losing
 * anything. Current SQLite state always has execution knowledge and writes v4.
 */
export function portableProjectFormatVersionFor(
  state: PortableProjectState,
): PortableProjectFormatVersion {
  // An agent disable and agent reference fields are what format 7 cannot
  // express.
  if (
    state.definitions?.overrides.some(
      (item) =>
        (item.operation === "disable" && item.source.kind === "agents") ||
        (item.payload !== undefined && hasAgentReferences(item.payload)),
    ) ||
    state.definitions?.owned.some((item) => hasAgentReferences(item.payload))
  )
    return portableProjectAgentArchetypeFormatVersion;
  // A role omission is the one definition entry format 6 cannot express.
  if (
    state.definitions?.overrides.some(
      (item) => item.operation === "disable" && item.source.kind === "roles",
    )
  )
    return portableProjectRoleOmissionFormatVersion;
  if (state.definitions !== undefined)
    return portableProjectDefinitionFormatVersion;
  if (state.packBinding !== undefined)
    return portableProjectPackBindingFormatVersion;
  if (state.taskExecutionHistory !== undefined)
    return portableProjectExecutionHistoryFormatVersion;
  if ((state.taskDependencies ?? []).length > 0)
    return portableProjectDependencyFormatVersion;
  return portableTaskRequirementLinks(state).length > 0
    ? portableProjectLinkedFormatVersion
    : portableProjectBaseFormatVersion;
}

/** Compare an upgraded local state against an archive's frozen wire contract. */
export function portableStateAtFormatVersion(
  state: PortableProjectState,
  version: PortableProjectFormatVersion,
): PortableProjectState {
  // Formats 6, 7 and 8 carry the same sections; a role omission simply never
  // matches a format-6 archive, nor an agent disable a format-7 one.
  if (version === 8 || version === 7 || version === 6) return state;
  const {
    packBinding: _packBinding,
    definitions: _definitions,
    taskExecutionHistory: _history,
    taskDependencies,
    governance,
    ...common
  } = state;
  if (version === 5)
    return {
      ...common,
      taskDependencies,
      taskExecutionHistory: state.taskExecutionHistory,
      packBinding: state.packBinding,
      governance,
    };
  if (version === 4)
    return {
      ...common,
      taskDependencies,
      taskExecutionHistory: state.taskExecutionHistory,
      governance,
    };
  if (version === 3) return { ...common, taskDependencies, governance };
  const { taskRequirements, ...oldGovernance } = governance;
  if (version === 2)
    return { ...common, governance: { ...oldGovernance, taskRequirements } };
  return { ...common, governance: oldGovernance };
}

const manifestContentsV1 = [
  z.literal("project"),
  z.literal("tasks"),
  z.literal("profile"),
  z.literal("office_manifests"),
  z.literal("governance"),
  z.literal("agent_definitions"),
  z.literal("terminal_run_summaries"),
] as const;

/** The `contents` tuple each version declares. Frozen per version. */
export const portableProjectContents = {
  1: [
    "project",
    "tasks",
    "profile",
    "office_manifests",
    "governance",
    "agent_definitions",
    "terminal_run_summaries",
  ],
  2: [
    "project",
    "tasks",
    "profile",
    "office_manifests",
    "governance",
    "agent_definitions",
    "terminal_run_summaries",
    "task_requirements",
  ],
  3: [
    "project",
    "tasks",
    "profile",
    "office_manifests",
    "governance",
    "agent_definitions",
    "terminal_run_summaries",
    "task_requirements",
    "task_dependencies",
  ],
  4: [
    "project",
    "tasks",
    "profile",
    "office_manifests",
    "governance",
    "agent_definitions",
    "terminal_run_summaries",
    "task_requirements",
    "task_dependencies",
    "task_execution_history",
  ],
  5: [
    "project",
    "tasks",
    "profile",
    "office_manifests",
    "governance",
    "agent_definitions",
    "terminal_run_summaries",
    "task_requirements",
    "task_dependencies",
    "task_execution_history",
    "project_pack_binding",
  ],
  6: [
    "project",
    "tasks",
    "profile",
    "office_manifests",
    "governance",
    "agent_definitions",
    "terminal_run_summaries",
    "task_requirements",
    "task_dependencies",
    "task_execution_history",
    "project_pack_binding",
    "project_definitions",
  ],
  7: [
    "project",
    "tasks",
    "profile",
    "office_manifests",
    "governance",
    "agent_definitions",
    "terminal_run_summaries",
    "task_requirements",
    "task_dependencies",
    "task_execution_history",
    "project_pack_binding",
    "project_definitions",
  ],
  8: [
    "project",
    "tasks",
    "profile",
    "office_manifests",
    "governance",
    "agent_definitions",
    "terminal_run_summaries",
    "task_requirements",
    "task_dependencies",
    "task_execution_history",
    "project_pack_binding",
    "project_definitions",
  ],
} as const;

const portableProjectManifestBase = {
  format: z.literal(portableProjectFormat),
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
} as const;

export const portableProjectManifestSchemaV1 = z.strictObject({
  ...portableProjectManifestBase,
  formatVersion: z.literal(portableProjectBaseFormatVersion),
  contents: z.tuple([...manifestContentsV1]),
});

export const portableProjectManifestSchemaV2 = z.strictObject({
  ...portableProjectManifestBase,
  formatVersion: z.literal(portableProjectLinkedFormatVersion),
  contents: z.tuple([...manifestContentsV1, z.literal("task_requirements")]),
});
export const portableProjectManifestSchemaV3 = z.strictObject({
  ...portableProjectManifestBase,
  formatVersion: z.literal(portableProjectDependencyFormatVersion),
  contents: z.tuple([
    ...manifestContentsV1,
    z.literal("task_requirements"),
    z.literal("task_dependencies"),
  ]),
});
export const portableProjectManifestSchemaV4 = z.strictObject({
  ...portableProjectManifestBase,
  formatVersion: z.literal(portableProjectExecutionHistoryFormatVersion),
  contents: z.tuple([
    ...manifestContentsV1,
    z.literal("task_requirements"),
    z.literal("task_dependencies"),
    z.literal("task_execution_history"),
  ]),
});
export const portableProjectManifestSchemaV5 = z.strictObject({
  ...portableProjectManifestBase,
  formatVersion: z.literal(portableProjectPackBindingFormatVersion),
  contents: z.tuple([
    ...manifestContentsV1,
    z.literal("task_requirements"),
    z.literal("task_dependencies"),
    z.literal("task_execution_history"),
    z.literal("project_pack_binding"),
  ]),
});
export const portableProjectManifestSchemaV6 = z.strictObject({
  ...portableProjectManifestBase,
  formatVersion: z.literal(portableProjectDefinitionFormatVersion),
  contents: z.tuple([
    ...manifestContentsV1,
    z.literal("task_requirements"),
    z.literal("task_dependencies"),
    z.literal("task_execution_history"),
    z.literal("project_pack_binding"),
    z.literal("project_definitions"),
  ]),
});
export const portableProjectManifestSchemaV7 = z.strictObject({
  ...portableProjectManifestBase,
  formatVersion: z.literal(portableProjectRoleOmissionFormatVersion),
  contents: z.tuple([
    ...manifestContentsV1,
    z.literal("task_requirements"),
    z.literal("task_dependencies"),
    z.literal("task_execution_history"),
    z.literal("project_pack_binding"),
    z.literal("project_definitions"),
  ]),
});
export const portableProjectManifestSchemaV8 = z.strictObject({
  ...portableProjectManifestBase,
  formatVersion: z.literal(portableProjectAgentArchetypeFormatVersion),
  contents: z.tuple([
    ...manifestContentsV1,
    z.literal("task_requirements"),
    z.literal("task_dependencies"),
    z.literal("task_execution_history"),
    z.literal("project_pack_binding"),
    z.literal("project_definitions"),
  ]),
});

/** Accepts either version. Which one is decided before the state is parsed. */
export const portableProjectManifestSchema = z.union([
  portableProjectManifestSchemaV1,
  portableProjectManifestSchemaV2,
  portableProjectManifestSchemaV3,
  portableProjectManifestSchemaV4,
  portableProjectManifestSchemaV5,
  portableProjectManifestSchemaV6,
  portableProjectManifestSchemaV7,
  portableProjectManifestSchemaV8,
]);

export type PortableProjectManifest = z.infer<
  typeof portableProjectManifestSchema
>;

/**
 * Builds the manifest for one version, keeping `formatVersion` and `contents`
 * correlated in the one place that knows they must be.
 */
export function portableProjectManifestFor(input: {
  formatVersion: PortableProjectFormatVersion;
  projectIdentity: string;
  createdAt: string;
  revision: PortableProjectManifest["revision"];
  source?: PortableProjectManifest["source"];
}): PortableProjectManifest {
  const envelope = {
    format: portableProjectFormat,
    projectIdentity: input.projectIdentity,
    createdAt: input.createdAt,
    revision: input.revision,
    ...(input.source === undefined ? {} : { source: input.source }),
  };
  if (input.formatVersion === portableProjectAgentArchetypeFormatVersion)
    return {
      ...envelope,
      formatVersion: portableProjectAgentArchetypeFormatVersion,
      contents: [...portableProjectContents[8]],
    };
  return input.formatVersion === portableProjectRoleOmissionFormatVersion
    ? {
        ...envelope,
        formatVersion: portableProjectRoleOmissionFormatVersion,
        contents: [...portableProjectContents[7]],
      }
    : input.formatVersion === portableProjectDefinitionFormatVersion
      ? {
          ...envelope,
          formatVersion: portableProjectDefinitionFormatVersion,
          contents: [...portableProjectContents[6]],
        }
      : input.formatVersion === portableProjectPackBindingFormatVersion
        ? {
            ...envelope,
            formatVersion: portableProjectPackBindingFormatVersion,
            contents: [...portableProjectContents[5]],
          }
        : input.formatVersion === portableProjectExecutionHistoryFormatVersion
          ? {
              ...envelope,
              formatVersion: portableProjectExecutionHistoryFormatVersion,
              contents: [...portableProjectContents[4]],
            }
          : input.formatVersion === portableProjectDependencyFormatVersion
            ? {
                ...envelope,
                formatVersion: portableProjectDependencyFormatVersion,
                contents: [...portableProjectContents[3]],
              }
            : input.formatVersion === portableProjectLinkedFormatVersion
              ? {
                  ...envelope,
                  formatVersion: portableProjectLinkedFormatVersion,
                  contents: [...portableProjectContents[2]],
                }
              : {
                  ...envelope,
                  formatVersion: portableProjectBaseFormatVersion,
                  contents: [...portableProjectContents[1]],
                };
}

const integrityShape = z.strictObject({
  algorithm: z.literal("sha256"),
  checksum,
});

export const portableProjectArchiveSchemaV1 = z.strictObject({
  manifest: portableProjectManifestSchemaV1,
  state: portableProjectStateSchemaV1,
  integrity: integrityShape,
});

export const portableProjectArchiveSchemaV2 = z.strictObject({
  manifest: portableProjectManifestSchemaV2,
  state: portableProjectStateSchemaV2,
  integrity: integrityShape,
});
export const portableProjectArchiveSchemaV3 = z.strictObject({
  manifest: portableProjectManifestSchemaV3,
  state: portableProjectStateSchemaV3,
  integrity: integrityShape,
});
export const portableProjectArchiveSchemaV4 = z.strictObject({
  manifest: portableProjectManifestSchemaV4,
  state: portableProjectStateSchemaV4,
  integrity: integrityShape,
});
export const portableProjectArchiveSchemaV5 = z.strictObject({
  manifest: portableProjectManifestSchemaV5,
  state: portableProjectStateSchemaV5,
  integrity: integrityShape,
});
export const portableProjectArchiveSchemaV6 = z.strictObject({
  manifest: portableProjectManifestSchemaV6,
  state: portableProjectStateSchemaV6,
  integrity: integrityShape,
});
export const portableProjectArchiveSchemaV7 = z.strictObject({
  manifest: portableProjectManifestSchemaV7,
  state: portableProjectStateSchemaV7,
  integrity: integrityShape,
});
export const portableProjectArchiveSchemaV8 = z.strictObject({
  manifest: portableProjectManifestSchemaV8,
  state: portableProjectStateSchemaV8,
  integrity: integrityShape,
});

export interface PortableProjectArchive {
  manifest: PortableProjectManifest;
  state: PortableProjectState;
  integrity: { algorithm: "sha256"; checksum: string };
}

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
    (suffix) =>
      normalized.length > suffix.length && normalized.endsWith(suffix),
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

/**
 * Builds an archive at the version its manifest declares, and refuses any
 * combination where the version and the content disagree.
 *
 * The refusal matters in one direction especially: a state carrying links can
 * never be written as version 1. Silently dropping them there would produce an
 * archive that restores a project missing relationships it had, with a valid
 * checksum over the loss.
 */
export function createPortableProjectArchive(input: {
  manifest: PortableProjectManifest;
  state: PortableProjectState;
}): PortableProjectArchive {
  const declared = input.manifest.formatVersion;
  const required = portableProjectFormatVersionFor(input.state);
  if (declared < required)
    throw new PortableProjectArchiveError(
      `Portable project archive format version ${declared} cannot carry ${required === 8 ? "an agent disable or agent references" : required === 7 ? "a role omission" : required === 6 ? "project definitions" : required === 5 ? "project pack binding" : required === 4 ? "lifetime task execution history" : "Task/Requirement links"}; write format version ${required}`,
    );
  const state =
    declared === portableProjectAgentArchetypeFormatVersion
      ? portableProjectStateSchemaV8.parse(input.state)
      : declared === portableProjectRoleOmissionFormatVersion
        ? portableProjectStateSchemaV7.parse(input.state)
        : declared === portableProjectDefinitionFormatVersion
          ? portableProjectStateSchemaV6.parse(input.state)
          : declared === portableProjectPackBindingFormatVersion
            ? portableProjectStateSchemaV5.parse(input.state)
            : declared === portableProjectExecutionHistoryFormatVersion
              ? portableProjectStateSchemaV4.parse(input.state)
              : declared === portableProjectDependencyFormatVersion
                ? portableProjectStateSchemaV3.parse(input.state)
                : declared === portableProjectLinkedFormatVersion
                  ? portableProjectStateSchemaV2.parse(input.state)
                  : portableProjectStateSchemaV1.parse(input.state);
  assertPortableProjectStateSafe(state);
  const stateChecksum = portableStateChecksum(state);
  if (input.manifest.revision.stateChecksum !== stateChecksum)
    throw new PortableProjectArchiveError(
      "Snapshot revision checksum does not match portable state",
    );
  const manifest =
    declared === portableProjectAgentArchetypeFormatVersion
      ? portableProjectManifestSchemaV8.parse(input.manifest)
      : declared === portableProjectRoleOmissionFormatVersion
        ? portableProjectManifestSchemaV7.parse(input.manifest)
        : declared === portableProjectDefinitionFormatVersion
          ? portableProjectManifestSchemaV6.parse(input.manifest)
          : declared === portableProjectPackBindingFormatVersion
            ? portableProjectManifestSchemaV5.parse(input.manifest)
            : declared === portableProjectExecutionHistoryFormatVersion
              ? portableProjectManifestSchemaV4.parse(input.manifest)
              : declared === portableProjectDependencyFormatVersion
                ? portableProjectManifestSchemaV3.parse(input.manifest)
                : declared === portableProjectLinkedFormatVersion
                  ? portableProjectManifestSchemaV2.parse(input.manifest)
                  : portableProjectManifestSchemaV1.parse(input.manifest);
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

/**
 * Reads the declared format version before choosing a schema.
 *
 * Returns null for anything this build does not read, so the caller can say so
 * rather than reporting a pile of shape errors from the wrong schema.
 */
function declaredFormatVersion(
  value: unknown,
): PortableProjectFormatVersion | null {
  if (typeof value !== "object" || value === null) return null;
  const manifest = (value as { manifest?: unknown }).manifest;
  if (typeof manifest !== "object" || manifest === null) return null;
  const version = (manifest as { formatVersion?: unknown }).formatVersion;
  return (
    portableProjectFormatVersions.find((known) => known === version) ?? null
  );
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
  const version = declaredFormatVersion(value);
  if (version === null)
    throw new PortableProjectArchiveError(
      `Portable project archive does not declare a supported format version (supported: ${portableProjectFormatVersions.join(", ")})`,
    );
  const parsed = (
    version === portableProjectAgentArchetypeFormatVersion
      ? portableProjectArchiveSchemaV8
      : version === portableProjectRoleOmissionFormatVersion
        ? portableProjectArchiveSchemaV7
        : version === portableProjectDefinitionFormatVersion
          ? portableProjectArchiveSchemaV6
          : version === portableProjectPackBindingFormatVersion
            ? portableProjectArchiveSchemaV5
            : version === portableProjectExecutionHistoryFormatVersion
              ? portableProjectArchiveSchemaV4
              : version === portableProjectDependencyFormatVersion
                ? portableProjectArchiveSchemaV3
                : version === portableProjectLinkedFormatVersion
                  ? portableProjectArchiveSchemaV2
                  : portableProjectArchiveSchemaV1
  ).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PortableProjectArchiveError(
      issue === undefined
        ? `Portable project archive does not match format version ${version}`
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

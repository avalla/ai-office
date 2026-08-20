import * as z from "zod";
import {
  officeTaskKinds,
  type OfficeManifest,
} from "@ai-office/domain/office/office-manifest.ts";
import { agentOperations } from "@ai-office/domain/project/project-profile.ts";
import { InvalidOfficeManifestError } from "../errors.ts";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "must be a lowercase kebab-case identifier",
  );

const shortTextSchema = z.string().trim().min(1).max(240);
const longTextSchema = z.string().trim().min(1).max(2_000);

function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const officeManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    provenance: z.strictObject({
      host: identifierSchema,
      skill: z.literal("ai-office"),
      skillVersion: z.string().trim().min(1).max(32),
    }),
    project: z.strictObject({
      mission: longTextSchema,
      goals: z.array(shortTextSchema).min(1).max(16),
      constraints: z.array(shortTextSchema).max(32),
      preferences: z.array(shortTextSchema).max(32),
      permissionPreferences: z.array(z.enum(agentOperations)).max(8),
    }),
    office: z.strictObject({
      name: shortTextSchema,
      roles: z
        .array(
          z.strictObject({
            id: identifierSchema,
            title: shortTextSchema,
            purpose: longTextSchema,
            responsibilities: z.array(shortTextSchema).min(1).max(16),
          }),
        )
        .min(1)
        .max(24),
    }),
    pipelines: z
      .array(
        z.strictObject({
          id: identifierSchema,
          name: shortTextSchema,
          description: longTextSchema,
          defaultFor: z.array(z.enum(officeTaskKinds)).min(1).max(5),
          stages: z
            .array(
              z.strictObject({
                id: identifierSchema,
                name: shortTextSchema,
                roleId: identifierSchema,
                objective: longTextSchema,
                checks: z.array(shortTextSchema).max(16),
                requiresApproval: z.boolean(),
              }),
            )
            .min(1)
            .max(24),
        }),
      )
      .min(1)
      .max(16),
  })
  .superRefine((manifest, context) => {
    const roleIds = manifest.office.roles.map((role) => role.id);
    if (!uniqueValues(roleIds)) {
      context.addIssue({
        code: "custom",
        path: ["office", "roles"],
        message: "Role identifiers must be unique",
      });
    }

    const pipelineIds = manifest.pipelines.map((pipeline) => pipeline.id);
    if (!uniqueValues(pipelineIds)) {
      context.addIssue({
        code: "custom",
        path: ["pipelines"],
        message: "Pipeline identifiers must be unique",
      });
    }

    const assignedKinds = new Set<string>();
    for (const [pipelineIndex, pipeline] of manifest.pipelines.entries()) {
      if (!uniqueValues(pipeline.defaultFor)) {
        context.addIssue({
          code: "custom",
          path: ["pipelines", pipelineIndex, "defaultFor"],
          message: "Task kinds must be unique within a pipeline",
        });
      }
      for (const kind of pipeline.defaultFor) {
        if (assignedKinds.has(kind)) {
          context.addIssue({
            code: "custom",
            path: ["pipelines", pipelineIndex, "defaultFor"],
            message: `Task kind ${kind} can have only one default pipeline`,
          });
        }
        assignedKinds.add(kind);
      }

      const stageIds = pipeline.stages.map((stage) => stage.id);
      if (!uniqueValues(stageIds)) {
        context.addIssue({
          code: "custom",
          path: ["pipelines", pipelineIndex, "stages"],
          message: "Stage identifiers must be unique within a pipeline",
        });
      }
      for (const [stageIndex, stage] of pipeline.stages.entries()) {
        if (!roleIds.includes(stage.roleId)) {
          context.addIssue({
            code: "custom",
            path: ["pipelines", pipelineIndex, "stages", stageIndex, "roleId"],
            message: `Unknown office role ${stage.roleId}`,
          });
        }
      }
    }

    if (!uniqueValues(manifest.project.goals)) {
      context.addIssue({
        code: "custom",
        path: ["project", "goals"],
        message: "Goals must be unique",
      });
    }
    if (!uniqueValues(manifest.project.permissionPreferences)) {
      context.addIssue({
        code: "custom",
        path: ["project", "permissionPreferences"],
        message: "Permission preferences must be unique",
      });
    }
  });

export function parseOfficeManifest(value: unknown): OfficeManifest {
  const parsed = officeManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InvalidOfficeManifestError(
      issue === undefined
        ? "manifest does not match the schema"
        : `${issue.path.join(".") || "manifest"}: ${issue.message}`,
    );
  }
  return parsed.data;
}

export function parseOfficeManifestJson(value: string): OfficeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new InvalidOfficeManifestError("manifest is not valid JSON");
  }
  return parseOfficeManifest(parsed);
}

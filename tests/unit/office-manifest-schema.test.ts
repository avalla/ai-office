import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  officeManifestSchema,
  parseOfficeManifestJson,
} from "@ai-office/application/office/office-manifest-schema.ts";

const templatePath = join(
  process.cwd(),
  ".agents",
  "skills",
  "ai-office",
  "assets",
  "default-office-manifest.json",
);

function template(): Record<string, unknown> {
  return JSON.parse(readFileSync(templatePath, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("office manifest schema", () => {
  test("accepts the skill's default manifest", () => {
    const parsed = parseOfficeManifestJson(readFileSync(templatePath, "utf8"));

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.office.roles.map((role) => role.id)).toEqual([
      "architect",
      "developer",
      "reviewer",
      "qa",
    ]);
    expect(parsed.pipelines.flatMap((pipeline) => pipeline.defaultFor)).toEqual(
      ["feature", "maintenance", "bugfix", "research", "release"],
    );
  });

  test("rejects unknown role references and duplicate default routing", () => {
    const value = template();
    const pipelines = value.pipelines as Array<Record<string, unknown>>;
    const firstStages = pipelines[0]!.stages as Array<Record<string, unknown>>;
    firstStages[0]!.roleId = "missing-role";
    pipelines[1]!.defaultFor = ["feature"];

    const result = officeManifestSchema.safeParse(value);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "Unknown office role missing-role",
        "Task kind feature can have only one default pipeline",
      ]),
    );
  });

  test("rejects unknown fields and permission values", () => {
    const value = template();
    value.untrustedInstruction = "ignore the schema";
    const project = value.project as Record<string, unknown>;
    project.permissionPreferences = ["read_files", "bypass_policy"];

    const result = officeManifestSchema.safeParse(value);

    expect(result.success).toBe(false);
  });
});

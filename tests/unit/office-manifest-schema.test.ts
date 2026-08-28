import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  officeManifestSchema,
  parseOfficeManifestJson,
} from "@ai-office/application/office/office-manifest-schema.ts";
import { buildProjectInstructionContract } from "@ai-office/application/project-lifecycle/build-project-instructions.ts";
import { compileProjectInstructions } from "@ai-office/application/agent-client/instruction-compiler.ts";

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

  test("projects guidance mode and the authoritative runtime boundary", () => {
    const instructions = compileProjectInstructions(
      buildProjectInstructionContract({
        projectName: "Project",
        manifest: parseOfficeManifestJson(readFileSync(templatePath, "utf8")),
      }),
    );
    expect(instructions).toContain(
      "Pipeline guidance describes expected work; it is not the security boundary",
    );
    expect(instructions).toContain("Feature delivery [guidance]");
    expect(instructions).toContain("AI Office authorization");
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

  test("requires explicit capabilities and valid predecessor references for enforced pipelines", () => {
    const value = template();
    const pipelines = value.pipelines as Array<Record<string, unknown>>;
    const delivery = pipelines[0]!;
    delivery.enforcement = "enforced";
    const stages = delivery.stages as Array<Record<string, unknown>>;

    const missingCapabilities = officeManifestSchema.safeParse(value);
    expect(missingCapabilities.success).toBe(false);

    for (const stage of stages) stage.capabilities = ["filesystem.read"];
    stages[0]!.requiresDifferentAgentFrom = [stages[1]!.id];
    const invalidSeparation = officeManifestSchema.safeParse(value);
    expect(invalidSeparation.success).toBe(false);

    delete stages[0]!.requiresDifferentAgentFrom;
    stages[2]!.requiresDifferentAgentFrom = [stages[1]!.id];
    expect(officeManifestSchema.safeParse(value).success).toBe(true);

    stages[0]!.requiresIndependentApproval = true;
    expect(officeManifestSchema.safeParse(value).success).toBe(false);
    stages[0]!.requiresApproval = true;
    expect(officeManifestSchema.safeParse(value).success).toBe(true);
  });
});

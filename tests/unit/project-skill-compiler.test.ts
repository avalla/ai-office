import { describe, expect, test } from "vitest";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { officeTaskKinds } from "@ai-office/domain/office/office-manifest.ts";
import { compileProjectSkill } from "@ai-office/application/agent-client/project-skill-compiler.ts";
import { buildProjectInstructionContract } from "@ai-office/application/project-lifecycle/build-project-instructions.ts";

/**
 * A manifest declaring task kinds outside the shipped five (M16.5), mirrors
 * the fixture used by tests/integration/office-task-kind-open.test.ts.
 */
function manifestWithOpenTaskKinds(): OfficeManifest {
  return {
    schemaVersion: 1,
    provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
    project: {
      mission: "Legal intake",
      goals: ["Ship"],
      constraints: [],
      preferences: [],
      permissionPreferences: [],
    },
    office: {
      name: "Legal office",
      roles: [
        {
          id: "intake-clerk",
          title: "Intake clerk",
          purpose: "Intake",
          responsibilities: ["Intake"],
        },
        {
          id: "developer",
          title: "Developer",
          purpose: "Build",
          responsibilities: ["Build"],
        },
      ],
    },
    pipelines: [
      {
        id: "matter-intake",
        name: "Matter intake",
        description: "Routes non-software task kinds",
        defaultFor: ["matter", "civil-matter"],
        stages: [
          {
            id: "intake",
            name: "Intake",
            roleId: "intake-clerk",
            objective: "Intake",
            checks: [],
            requiresApproval: false,
          },
        ],
      },
      {
        id: "delivery",
        name: "Delivery",
        description: "Routes the usual software kinds",
        defaultFor: ["feature"],
        stages: [
          {
            id: "build",
            name: "Build",
            roleId: "developer",
            objective: "Build",
            checks: [],
            requiresApproval: false,
          },
        ],
      },
    ],
  };
}

const legacyPhrase =
  "Classify tasks as feature, bugfix, maintenance, research, or release";

describe("compileProjectSkill task-kind guidance (M16.5)", () => {
  test("defaults to the shipped legacy kinds when no project task kinds are given", () => {
    expect(compileProjectSkill()).toContain(legacyPhrase);
    expect(compileProjectSkill([])).toContain(legacyPhrase);
  });

  test("uses the project's manifest-declared task kinds instead of the legacy list", () => {
    const skill = compileProjectSkill(["matter", "civil-matter"]);
    expect(skill).toContain("Classify tasks as matter or civil-matter");
    expect(skill).not.toContain(legacyPhrase);
  });

  test("renders three or more declared kinds with a serial comma", () => {
    const skill = compileProjectSkill(["matter", "civil-matter", "criminal-matter"]);
    expect(skill).toContain(
      "Classify tasks as matter, civil-matter, or criminal-matter",
    );
  });
});

describe("buildProjectInstructionContract.project.taskKinds (M16.5)", () => {
  test("derives the contract's task kinds from the manifest's own pipelines", () => {
    const contract = buildProjectInstructionContract({
      projectName: "legal-office",
      manifest: manifestWithOpenTaskKinds(),
    });
    expect(contract.project.taskKinds).toEqual([
      "matter",
      "civil-matter",
      "feature",
    ]);
  });

  test("a legacy manifest's contract carries exactly the shipped default kinds", () => {
    const legacyManifest: OfficeManifest = {
      ...manifestWithOpenTaskKinds(),
      pipelines: [
        {
          id: "delivery",
          name: "Delivery",
          description: "Software delivery",
          defaultFor: [...officeTaskKinds],
          stages: [
            {
              id: "build",
              name: "Build",
              roleId: "developer",
              objective: "Build",
              checks: [],
              requiresApproval: false,
            },
          ],
        },
      ],
    };
    const contract = buildProjectInstructionContract({
      projectName: "legacy",
      manifest: legacyManifest,
    });
    expect(contract.project.taskKinds).toEqual(officeTaskKinds);
  });

  test("the generated skill for a legal manifest's contract no longer contradicts its own pipelines", () => {
    const contract = buildProjectInstructionContract({
      projectName: "legal-office",
      manifest: manifestWithOpenTaskKinds(),
    });
    const skill = compileProjectSkill(contract.project.taskKinds);
    expect(skill).toContain("matter");
    expect(skill).toContain("civil-matter");
    expect(skill).not.toContain(legacyPhrase);
  });
});

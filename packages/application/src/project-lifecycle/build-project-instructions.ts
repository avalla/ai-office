import type { ProjectInstructionContract } from "@ai-office/domain/agent/project-instruction-contract.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";

function configuredWorkflow(manifest: OfficeManifest): string[] {
  return manifest.pipelines.map((pipeline) => {
    const stages = pipeline.stages.map((stage) => stage.name).join(" -> ");
    return `${pipeline.name}: ${stages}`;
  });
}

export function buildProjectInstructionContract(input: {
  projectName: string;
  manifest: OfficeManifest;
}): ProjectInstructionContract {
  const constraints = input.manifest.project.constraints;
  return Object.freeze({
    schemaVersion: 1,
    policy: Object.freeze({
      reasoning: "architecture_first",
      autonomy: "high",
      codeChanges: "autonomous",
      architectureChanges: "approval_required",
      adrCreation: "allowed",
      inspectBeforeNonTrivialWork: true,
      planBeforeNonTrivialWork: true,
      implementationReview: true,
      preserveInvariants: true,
    }),
    project: Object.freeze({
      name: input.projectName,
      mission: input.manifest.project.mission,
      repositoryMap: Object.freeze([
        "Inspect the bound repository and its current documentation before changing it",
      ]),
      invariants: Object.freeze(
        constraints.length > 0
          ? [...constraints]
          : [
              "Preserve the repository's existing architecture and user-owned files",
            ],
      ),
      workflow: Object.freeze(configuredWorkflow(input.manifest)),
      testing: Object.freeze([
        "Run the narrowest relevant tests, then the repository's complete check suite",
      ]),
      documentation: Object.freeze([
        "Follow the repository's documented hierarchy of current guidance",
      ]),
      definitionOfDone: Object.freeze([
        "Acceptance criteria, tests, typecheck, documentation, and implementation review pass",
      ]),
    }),
  });
}

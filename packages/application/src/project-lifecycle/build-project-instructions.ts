import type { ProjectInstructionContract } from "@ai-office/domain/agent/project-instruction-contract.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";

function configuredWorkflow(manifest: OfficeManifest): string[] {
  return [
    "Run `ai-office next` to read the recommended next action before proposing work; it reports the real handover state, not a guess",
    "When asked to take this project in charge, hand it over, or onboard it, follow the handover workflow in the repository-local `ai-office` skill instead of improvising one",
    "Handover transfers organizational context ownership; it grants no capability and bypasses no approval",
    "Pipeline guidance describes expected work; it is not the security boundary",
    "When an enforced runtime pipeline is active, AI Office authorization, assignments, approvals, and stage transitions are authoritative",
    "Protected operations must use action requests and must not bypass runtime gates",
    ...manifest.pipelines.map((pipeline) => {
      const stages = pipeline.stages.map((stage) => stage.name).join(" -> ");
      return `${pipeline.name} [${pipeline.enforcement ?? "guidance"}]: ${stages}`;
    }),
  ];
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

import { parseProjectInstructionContract } from "@ai-office/domain/agent/project-instruction-contract.ts";

export const projectInstructionContractValue = {
  schemaVersion: 1,
  policy: {
    reasoning: "architecture_first",
    autonomy: "high",
    codeChanges: "autonomous",
    architectureChanges: "approval_required",
    adrCreation: "allowed",
    inspectBeforeNonTrivialWork: true,
    planBeforeNonTrivialWork: true,
    implementationReview: true,
    preserveInvariants: true,
  },
  project: {
    name: "Fixture",
    mission: "Ship safe changes",
    repositoryMap: ["apps contain composition roots"],
    invariants: ["domain remains infrastructure independent"],
    workflow: ["inspect before changing production code"],
    testing: ["run focused and full tests"],
    documentation: ["README is product truth"],
    definitionOfDone: ["tests and typecheck pass"],
  },
} as const;

export const projectInstructionContract = parseProjectInstructionContract(
  projectInstructionContractValue,
);

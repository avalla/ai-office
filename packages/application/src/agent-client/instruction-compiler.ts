import type { ProjectInstructionContract } from "@ai-office/domain/agent/project-instruction-contract.ts";

export const managedProjectInstructionsHeader =
  "<!-- ai-office:managed project-instructions v2 -->";
export const legacyManagedProjectInstructionsHeader =
  "<!-- ai-office:managed project-instructions v1 -->";

function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function policyValue(value: string): string {
  return value.replaceAll("_", "-");
}

export function compileProjectInstructions(
  contract: ProjectInstructionContract,
): string {
  const { policy, project } = contract;
  return `${managedProjectInstructionsHeader}
# ${project.name} project instructions

## Mission

${project.mission}

## Operating policy

- Reasoning: ${policyValue(policy.reasoning)}
- Autonomy: ${policyValue(policy.autonomy)}
- Code changes: ${policyValue(policy.codeChanges)}
- Architecture changes: ${policyValue(policy.architectureChanges)}
- ADR creation: ${policyValue(policy.adrCreation)}
- Inspect before non-trivial work: ${policy.inspectBeforeNonTrivialWork}
- Plan before non-trivial work: ${policy.planBeforeNonTrivialWork}
- Review implementation after execution: ${policy.implementationReview}
- Preserve architectural invariants: ${policy.preserveInvariants}

## Repository map

${list(project.repositoryMap)}

## Architectural invariants

${list(project.invariants)}

## Development workflow

${list(project.workflow)}

## Testing requirements

${list(project.testing)}

## Documentation hierarchy

${list(project.documentation)}

## Definition of done

${list(project.definitionOfDone)}
`;
}

import type { ProjectInstructionContract } from "@ai-office/domain/agent/project-instruction-contract.ts";
import type {
  SharedProjectArtifactAdapter,
  SharedProjectArtifactDraft,
} from "../ports/shared-project-artifact-adapter.port.ts";
import { compileProjectInstructions } from "./instruction-compiler.ts";
import { compileProjectSkill } from "./project-skill-compiler.ts";

export class ManageSharedProjectArtifacts {
  constructor(private readonly adapter: SharedProjectArtifactAdapter) {}

  plan(input: {
    rootPath: string;
    contract: ProjectInstructionContract;
  }) {
    return this.adapter.plan({
      rootPath: input.rootPath,
      canonicalInstructions: compileProjectInstructions(input.contract),
      projectSkill: compileProjectSkill(),
    });
  }

  apply(draft: SharedProjectArtifactDraft) {
    return this.adapter.apply(draft);
  }
}

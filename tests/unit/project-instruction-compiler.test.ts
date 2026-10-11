import { describe, expect, test } from "vitest";
import {
  InvalidProjectInstructionContractError,
  parseProjectInstructionContract,
} from "@ai-office/domain/agent/project-instruction-contract.ts";
import {
  compileProjectInstructions,
  managedProjectInstructionsHeader,
} from "@ai-office/application/agent-client/instruction-compiler.ts";
import {
  projectInstructionContract,
  projectInstructionContractValue,
} from "../helpers/project-instruction-contract.ts";

describe("project instruction contract and compiler", () => {
  test("compiles a deterministic tool-independent project contract", () => {
    const first = compileProjectInstructions(projectInstructionContract);
    const second = compileProjectInstructions(
      parseProjectInstructionContract(projectInstructionContractValue),
    );

    expect(first).toBe(second);
    expect(first).toContain(managedProjectInstructionsHeader);
    expect(first).toContain("Reasoning: architecture-first");
    expect(first).toContain("Architecture changes: approval-required");
    expect(first).toContain("domain remains infrastructure independent");
    expect(first).not.toContain("Codex");
    expect(first).not.toContain("Claude");
  });

  test("rejects unknown fields and unsupported policy values", () => {
    expect(() =>
      parseProjectInstructionContract({
        ...projectInstructionContractValue,
        client: "codex",
      }),
    ).toThrow(InvalidProjectInstructionContractError);
    expect(() =>
      parseProjectInstructionContract({
        ...projectInstructionContractValue,
        policy: {
          ...projectInstructionContractValue.policy,
          architectureChanges: "autonomous",
        },
      }),
    ).toThrow("expected one of: approval_required");
  });

  test("project.taskKinds is optional (M16.5): absent means the shipped default kinds", () => {
    const parsed = parseProjectInstructionContract(
      projectInstructionContractValue,
    );
    expect(parsed.project.taskKinds).toEqual([]);
  });

  test("project.taskKinds accepts a manifest-declared custom list and still rejects unexpected project fields", () => {
    const parsed = parseProjectInstructionContract({
      ...projectInstructionContractValue,
      project: {
        ...projectInstructionContractValue.project,
        taskKinds: ["matter", "civil-matter"],
      },
    });
    expect(parsed.project.taskKinds).toEqual(["matter", "civil-matter"]);

    expect(() =>
      parseProjectInstructionContract({
        ...projectInstructionContractValue,
        project: {
          ...projectInstructionContractValue.project,
          unexpectedField: "nope",
        },
      }),
    ).toThrow(InvalidProjectInstructionContractError);
  });
});

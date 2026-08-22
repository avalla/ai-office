import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManageAgentClientIntegration } from "@ai-office/application/agent-client/manage-agent-client-integration.ts";
import {
  AgentClientPlanApprovalError,
  AgentClientPlanConflictError,
} from "@ai-office/application/agent-client/errors.ts";
import {
  claudeManagedEnd,
  claudeManagedStart,
} from "@ai-office/agent-client-integrations/adapters.ts";
import { DefaultAgentClientCatalog } from "@ai-office/agent-client-integrations/registry.ts";
import { projectInstructionContract } from "../helpers/project-instruction-contract.ts";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function service(
  input: {
    pathValue?: string;
    beforeCommit?: (path: string) => void;
  } = {},
) {
  return new ManageAgentClientIntegration(
    new DefaultAgentClientCatalog({
      ...(input.pathValue === undefined ? {} : { pathValue: input.pathValue }),
      ...(input.beforeCommit === undefined
        ? {}
        : { fileHooks: { beforeCommit: input.beforeCommit } }),
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("agent client integrations", () => {
  test("detects present and absent clients without launching them", async () => {
    const bin = temporaryRoot("ai-office-client-bin-");
    const codex = join(bin, "codex");
    const malformedClaude = join(bin, "claude");
    writeFileSync(codex, "#!/bin/sh\nexit 99\n");
    writeFileSync(malformedClaude, "#!/bin/sh\nexit 99\n");
    chmodSync(codex, 0o755);

    expect(await service({ pathValue: bin }).detect()).toEqual([
      expect.objectContaining({
        clientId: "codex",
        status: "detected",
        executablePath: realpathSync(codex),
      }),
      expect.objectContaining({ clientId: "claude", status: "not_detected" }),
    ]);
  });

  test("inspection and planning are passive and deterministic", async () => {
    const root = temporaryRoot("ai-office-client-passive-");
    const integration = service({ pathValue: "" });
    const before = readdirSync(root);

    const inspection = await integration.inspect("codex", root);
    const first = await integration.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });
    const second = await integration.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });

    expect(inspection.canonicalInstructions.integrationStatus).toBe("missing");
    expect(first).toEqual(second);
    expect(first.changes).toEqual([
      expect.objectContaining({
        kind: "create",
        relativePath: "AGENTS.md",
        expectedSha256: null,
      }),
    ]);
    expect(readdirSync(root)).toEqual(before);
  });

  test("creates canonical Codex instructions and is idempotent", async () => {
    const root = temporaryRoot("ai-office-client-codex-");
    const integration = service();
    const plan = await integration.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });

    const validation = await integration.apply({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: plan.planHash,
    });
    expect(validation.valid).toBe(true);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(
      "<!-- ai-office:managed project-instructions v1 -->",
    );
    expect(
      await integration.plan({
        clientId: "codex",
        rootPath: root,
        contract: projectInstructionContract,
      }),
    ).toMatchObject({ changes: [] });
  });

  test("keeps user-owned Codex instructions operational but unmanaged", async () => {
    const root = temporaryRoot("ai-office-client-codex-user-");
    writeFileSync(join(root, "AGENTS.md"), "# User instructions\n");
    const integration = service();

    const inspection = await integration.inspect("codex", root);
    expect(inspection.canonicalInstructions).toMatchObject({
      ownership: "user_owned",
      integrationStatus: "unmanaged",
    });
    expect(inspection.issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "canonical_instructions_unmanaged",
      }),
    );

    const plan = await integration.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });
    expect(plan.changes).toEqual([]);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ code: "canonical_instructions_unmanaged" }),
    );

    const validation = await integration.apply({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: plan.planHash,
    });
    expect(validation).toMatchObject({ valid: true });
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: "canonical_instructions_unmanaged" }),
    );
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      "# User instructions\n",
    );
  });

  test("preserves user AGENTS and merges only the Claude managed bridge", async () => {
    const root = temporaryRoot("ai-office-client-claude-");
    writeFileSync(join(root, "AGENTS.md"), "# User canonical contract\n");
    writeFileSync(join(root, "CODEX.md"), "# Legacy user notes\n");
    writeFileSync(
      join(root, "CLAUDE.md"),
      "# User Claude notes\n\nKeep this.\n",
    );
    const integration = service();
    const before = await integration.inspect("claude", root);
    expect(before.canonicalInstructions).toMatchObject({
      ownership: "user_owned",
      integrationStatus: "unmanaged",
    });
    expect(before.clientInstructions).toMatchObject({
      ownership: "user_owned",
      integrationStatus: "unmanaged",
    });
    const plan = await integration.plan({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
    });
    expect(plan.changes).toEqual([
      expect.objectContaining({
        relativePath: "CLAUDE.md",
        ownershipAfter: "merged",
      }),
    ]);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ code: "canonical_instructions_unmanaged" }),
    );

    const validation = await integration.apply({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: plan.planHash,
    });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      "# User canonical contract\n",
    );
    expect(readFileSync(join(root, "CODEX.md"), "utf8")).toBe(
      "# Legacy user notes\n",
    );
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Keep this.");
    expect(claude).toContain(claudeManagedStart);
    expect(claude).toContain("@AGENTS.md");
    expect(validation.valid).toBe(true);
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: "canonical_instructions_unmanaged" }),
    );
    const after = await integration.inspect("claude", root);
    expect(after.canonicalInstructions).toMatchObject({
      ownership: "user_owned",
      integrationStatus: "unmanaged",
    });
    expect(after.clientInstructions?.integrationStatus).toBe("integrated");
    writeFileSync(
      join(root, "CLAUDE.md"),
      claude.replace("@AGENTS.md", "@OBSOLETE.md"),
    );
    const refresh = await integration.plan({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
    });
    expect(refresh.changes).toEqual([
      expect.objectContaining({ relativePath: "CLAUDE.md", kind: "update" }),
    ]);
    await integration.apply({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: refresh.planHash,
    });
    const refreshedClaude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(refreshedClaude).toContain("Keep this.");
    expect(refreshedClaude).toContain("@AGENTS.md");
    expect(refreshedClaude).not.toContain("@OBSOLETE.md");
    expect(
      await integration.plan({
        clientId: "claude",
        rootPath: root,
        contract: projectInstructionContract,
      }),
    ).toMatchObject({ changes: [] });
  });

  test("accepts an existing direct Claude import without duplicating it", async () => {
    const root = temporaryRoot("ai-office-client-claude-import-");
    writeFileSync(join(root, "AGENTS.md"), "# User canonical contract\n");
    writeFileSync(join(root, "CLAUDE.md"), "# Claude notes\n\n@AGENTS.md\n");
    const integration = service();

    const inspection = await integration.inspect("claude", root);
    expect(inspection.canonicalInstructions).toMatchObject({
      ownership: "user_owned",
      integrationStatus: "unmanaged",
    });
    expect(inspection.clientInstructions).toMatchObject({
      ownership: "user_owned",
      integrationStatus: "integrated",
    });

    expect(
      await integration.plan({
        clientId: "claude",
        rootPath: root,
        contract: projectInstructionContract,
      }),
    ).toMatchObject({ changes: [] });
    const validation = await integration.validate("claude", root);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: "canonical_instructions_unmanaged" }),
    );
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(
      "# Claude notes\n\n@AGENTS.md\n",
    );
  });

  test("rejects stale approvals without overwriting concurrent edits", async () => {
    const root = temporaryRoot("ai-office-client-stale-");
    const integration = service();
    const plan = await integration.plan({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
    });
    writeFileSync(join(root, "AGENTS.md"), "# Concurrent user contract\n");

    await expect(
      integration.apply({
        clientId: "claude",
        rootPath: root,
        contract: projectInstructionContract,
        approvedPlanHash: plan.planHash,
      }),
    ).rejects.toBeInstanceOf(AgentClientPlanApprovalError);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      "# Concurrent user contract\n",
    );
    expect(() => readFileSync(join(root, "CLAUDE.md"), "utf8")).toThrow();
  });

  test("fails closed on malformed managed sections", async () => {
    const root = temporaryRoot("ai-office-client-conflict-");
    writeFileSync(join(root, "AGENTS.md"), "# User contract\n");
    writeFileSync(
      join(root, "CLAUDE.md"),
      `${claudeManagedStart}\n@OTHER.md\n${claudeManagedEnd}\n${claudeManagedEnd}\n`,
    );
    const integration = service();
    const plan = await integration.plan({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
    });
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ severity: "conflict" }),
    );
    await expect(
      integration.apply({
        clientId: "claude",
        rootPath: root,
        contract: projectInstructionContract,
        approvedPlanHash: plan.planHash,
      }),
    ).rejects.toBeInstanceOf(AgentClientPlanConflictError);
  });

  test("cleans temporary files when atomic apply fails", async () => {
    const root = temporaryRoot("ai-office-client-atomic-");
    const integration = service({
      beforeCommit: () => {
        throw new Error("injected apply failure");
      },
    });
    const plan = await integration.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });

    await expect(
      integration.apply({
        clientId: "codex",
        rootPath: root,
        contract: projectInstructionContract,
        approvedPlanHash: plan.planHash,
      }),
    ).rejects.toThrow("injected apply failure");
    expect(readdirSync(root)).toEqual([]);
  });

  test("uninstalls AI Office-owned Codex instructions with an exact approval", async () => {
    const root = temporaryRoot("ai-office-client-codex-uninstall-");
    const integration = service();
    const installPlan = await integration.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });
    await integration.apply({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: installPlan.planHash,
    });

    const uninstallPlan = await integration.planUninstall({
      clientId: "codex",
      rootPath: root,
    });
    expect(uninstallPlan).toMatchObject({
      action: "uninstall",
      changes: [{ kind: "delete", relativePath: "AGENTS.md" }],
    });
    await integration.uninstall({
      clientId: "codex",
      rootPath: root,
      approvedPlanHash: uninstallPlan.planHash,
    });
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  });

  test("preserves user-owned Codex instructions during uninstall", async () => {
    const root = temporaryRoot("ai-office-client-codex-preserve-");
    writeFileSync(join(root, "AGENTS.md"), "# User instructions\n");
    const integration = service();
    const plan = await integration.planUninstall({
      clientId: "codex",
      rootPath: root,
    });

    expect(plan.changes).toEqual([]);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        code: "canonical_instructions_user_owned_preserved",
      }),
    );
    await integration.uninstall({
      clientId: "codex",
      rootPath: root,
      approvedPlanHash: plan.planHash,
    });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      "# User instructions\n",
    );
  });

  test("removes only the managed Claude bridge and preserves shared instructions", async () => {
    const root = temporaryRoot("ai-office-client-claude-uninstall-");
    writeFileSync(join(root, "AGENTS.md"), "# User canonical contract\n");
    writeFileSync(join(root, "CLAUDE.md"), "# User Claude notes\n");
    const integration = service();
    const installPlan = await integration.plan({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
    });
    await integration.apply({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: installPlan.planHash,
    });

    const uninstallPlan = await integration.planUninstall({
      clientId: "claude",
      rootPath: root,
    });
    expect(uninstallPlan.changes).toEqual([
      expect.objectContaining({
        kind: "update",
        relativePath: "CLAUDE.md",
        ownershipAfter: "user_owned",
      }),
    ]);
    await integration.uninstall({
      clientId: "claude",
      rootPath: root,
      approvedPlanHash: uninstallPlan.planHash,
    });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      "# User canonical contract\n",
    );
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(
      "# User Claude notes\n",
    );
    expect(
      (await integration.inspect("claude", root)).clientInstructions?.ownership,
    ).toBe("user_owned");
  });

  test("Codex uninstall preserves managed canonical instructions required by a managed Claude bridge", async () => {
    const root = temporaryRoot("ai-office-client-codex-claude-managed-");
    const integration = service();
    const installPlan = await integration.plan({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
    });
    await integration.apply({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: installPlan.planHash,
    });
    const canonicalBefore = readFileSync(join(root, "AGENTS.md"), "utf8");
    const claudeBefore = readFileSync(join(root, "CLAUDE.md"), "utf8");

    const uninstallPlan = await integration.planUninstall({
      clientId: "codex",
      rootPath: root,
    });
    expect(uninstallPlan.changes).toEqual([]);
    expect(uninstallPlan.issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "claude_canonical_dependency_preserved",
        message: expect.stringContaining(
          "remains required and will be preserved",
        ),
      }),
    );
    await integration.uninstall({
      clientId: "codex",
      rootPath: root,
      approvedPlanHash: uninstallPlan.planHash,
    });

    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(canonicalBefore);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(claudeBefore);
    expect(await integration.validate("claude", root)).toMatchObject({
      valid: true,
    });
  });

  test("Codex uninstall preserves managed canonical instructions required by a user-owned Claude import", async () => {
    const root = temporaryRoot("ai-office-client-codex-claude-user-");
    const integration = service();
    const installPlan = await integration.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });
    await integration.apply({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: installPlan.planHash,
    });
    const userClaude = "# User Claude instructions\n\n@AGENTS.md\n";
    writeFileSync(join(root, "CLAUDE.md"), userClaude);

    const uninstallPlan = await integration.planUninstall({
      clientId: "codex",
      rootPath: root,
    });
    expect(uninstallPlan.changes).toEqual([]);
    expect(uninstallPlan.issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "claude_canonical_dependency_preserved",
      }),
    );
    await integration.uninstall({
      clientId: "codex",
      rootPath: root,
      approvedPlanHash: uninstallPlan.planHash,
    });

    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(
      "<!-- ai-office:managed project-instructions v1 -->",
    );
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(userClaude);
  });

  test("deletes an AI Office-owned Claude bridge but leaves canonical instructions", async () => {
    const root = temporaryRoot("ai-office-client-claude-owned-uninstall-");
    const integration = service();
    const installPlan = await integration.plan({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
    });
    await integration.apply({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: installPlan.planHash,
    });
    expect(
      (await integration.inspect("claude", root)).clientInstructions?.ownership,
    ).toBe("ai_office_owned");

    const uninstallPlan = await integration.planUninstall({
      clientId: "claude",
      rootPath: root,
    });
    expect(uninstallPlan.changes).toEqual([
      expect.objectContaining({ kind: "delete", relativePath: "CLAUDE.md" }),
    ]);
    await integration.uninstall({
      clientId: "claude",
      rootPath: root,
      approvedPlanHash: uninstallPlan.planHash,
    });
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
  });

  test("rejects a stale uninstall approval without deleting concurrent edits", async () => {
    const root = temporaryRoot("ai-office-client-uninstall-stale-");
    const integration = service();
    const installPlan = await integration.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });
    await integration.apply({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: installPlan.planHash,
    });
    const uninstallPlan = await integration.planUninstall({
      clientId: "codex",
      rootPath: root,
    });
    writeFileSync(join(root, "AGENTS.md"), "# Concurrent user edit\n");

    await expect(
      integration.uninstall({
        clientId: "codex",
        rootPath: root,
        approvedPlanHash: uninstallPlan.planHash,
      }),
    ).rejects.toBeInstanceOf(AgentClientPlanApprovalError);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      "# Concurrent user edit\n",
    );
  });

  test("revalidates immediately before deleting managed client instructions", async () => {
    const root = temporaryRoot("ai-office-client-uninstall-race-");
    const installing = service();
    const installPlan = await installing.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });
    await installing.apply({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: installPlan.planHash,
    });

    const uninstalling = service({
      beforeCommit: () =>
        writeFileSync(join(root, "AGENTS.md"), "# Last-moment user edit\n"),
    });
    const uninstallPlan = await uninstalling.planUninstall({
      clientId: "codex",
      rootPath: root,
    });
    await expect(
      uninstalling.uninstall({
        clientId: "codex",
        rootPath: root,
        approvedPlanHash: uninstallPlan.planHash,
      }),
    ).rejects.toThrow("changed during apply");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      "# Last-moment user edit\n",
    );
  });

  test("stops Codex uninstall when a Claude dependency appears immediately before delete", async () => {
    const root = temporaryRoot("ai-office-client-uninstall-dependency-race-");
    const installing = service();
    const installPlan = await installing.plan({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
    });
    await installing.apply({
      clientId: "codex",
      rootPath: root,
      contract: projectInstructionContract,
      approvedPlanHash: installPlan.planHash,
    });
    const userClaude = "# Concurrent Claude instructions\n\n@AGENTS.md\n";
    const uninstalling = service({
      beforeCommit: (path) => {
        if (path === "AGENTS.md")
          writeFileSync(join(root, "CLAUDE.md"), userClaude);
      },
    });
    const uninstallPlan = await uninstalling.planUninstall({
      clientId: "codex",
      rootPath: root,
    });

    await expect(
      uninstalling.uninstall({
        clientId: "codex",
        rootPath: root,
        approvedPlanHash: uninstallPlan.planHash,
      }),
    ).rejects.toThrow("still requires AGENTS.md");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(
      "<!-- ai-office:managed project-instructions v1 -->",
    );
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(userClaude);
  });

  test("leaves a multi-file failure valid and repairable", async () => {
    const root = temporaryRoot("ai-office-client-partial-");
    const failing = service({
      beforeCommit: (path) => {
        if (path === "CLAUDE.md") throw new Error("injected bridge failure");
      },
    });
    const plan = await failing.plan({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
    });

    await expect(
      failing.apply({
        clientId: "claude",
        rootPath: root,
        contract: projectInstructionContract,
        approvedPlanHash: plan.planHash,
      }),
    ).rejects.toThrow("injected bridge failure");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(
      "<!-- ai-office:managed project-instructions v1 -->",
    );
    expect(() => readFileSync(join(root, "CLAUDE.md"), "utf8")).toThrow();
    expect(readdirSync(root).some((path) => path.endsWith(".tmp"))).toBe(false);
    expect((await failing.validate("claude", root)).valid).toBe(false);

    const repairing = service();
    const repairPlan = await repairing.plan({
      clientId: "claude",
      rootPath: root,
      contract: projectInstructionContract,
    });
    expect(repairPlan.changes.map((change) => change.relativePath)).toEqual([
      "CLAUDE.md",
    ]);
    expect(
      await repairing.apply({
        clientId: "claude",
        rootPath: root,
        contract: projectInstructionContract,
        approvedPlanHash: repairPlan.planHash,
      }),
    ).toMatchObject({ valid: true });
  });
});

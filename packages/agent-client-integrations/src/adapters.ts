import type {
  AgentClientAdapter,
  AgentClientDetection,
  AgentClientFileOperation,
  AgentClientFileState,
  AgentClientId,
  AgentClientInspection,
  AgentClientIntegrationDraft,
  AgentClientIntegrationIssue,
  AgentClientValidation,
} from "@ai-office/application/ports/agent-client-adapter.port.ts";
import {
  legacyManagedProjectInstructionsHeader,
  managedProjectInstructionsHeader,
} from "@ai-office/application/agent-client/instruction-compiler.ts";
import {
  compileProjectSkill,
  managedProjectSkillMarker,
} from "@ai-office/application/agent-client/project-skill-compiler.ts";
import { AgentClientIntegrationError } from "@ai-office/application/agent-client/errors.ts";
import {
  LocalAgentClientFiles,
  PathExecutableLocator,
  type LocalInstructionFile,
} from "./local-agent-client-files.ts";

export const canonicalProjectInstructionsPath = "AI-OFFICE.md";
export const codexProjectInstructionsPath = "AGENTS.md";
export const codexProjectSkillPath = ".agents/skills/ai-office/SKILL.md";
export const claudeProjectSkillPath = ".claude/skills/ai-office/SKILL.md";
export const codexManagedInstructionsHeader =
  "<!-- ai-office:managed codex-project-instructions v1 -->";
export const claudeManagedStart =
  "<!-- >>> ai-office managed: canonical-project-instructions -->";
export const claudeManagedEnd =
  "<!-- <<< ai-office managed: canonical-project-instructions -->";

const claudeImport = `@${canonicalProjectInstructionsPath}`;
const claudeManagedBlock = `${claudeManagedStart}\n${claudeImport}\n${claudeManagedEnd}`;
const claudeManagedFileContent = `# Claude Code compatibility\n\n${claudeManagedBlock}\n`;
const codexManagedFileContent = `${codexManagedInstructionsHeader}
# AI Office project guidance

Read and follow [${canonicalProjectInstructionsPath}](${canonicalProjectInstructionsPath}) before doing any work in this repository. Use the repository-local \`$ai-office\` skill for lifecycle, onboarding, status, task, and controlled-action workflows.
`;
const claudeSkillMarker =
  "<!-- ai-office:managed claude-repository-skill v1 -->";
const claudeSkillContent = `---
name: ai-office
description: Install, inspect, onboard, configure, operate, troubleshoot, and safely remove AI Office for this repository.
---

${claudeSkillMarker}

Read and follow \`\${CLAUDE_PROJECT_DIR}/.agents/skills/ai-office/SKILL.md\`. That file is the shared repository-local AI Office skill. Read \`\${CLAUDE_PROJECT_DIR}/${canonicalProjectInstructionsPath}\` for this project's managed operating guidance.
`;

function normalizeEol(content: string): string {
  return content.replace(/\r\n?/gu, "\n");
}

function equivalentText(actual: string | undefined, expected: string): boolean {
  return (
    actual !== undefined && normalizeEol(actual) === normalizeEol(expected)
  );
}

function fileState(
  file: LocalInstructionFile,
  ownership: AgentClientFileState["ownership"],
  integrationStatus: AgentClientFileState["integrationStatus"],
): AgentClientFileState {
  return {
    relativePath: file.relativePath,
    exists: file.exists,
    ownership,
    ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
    integrationStatus,
  };
}

function isCanonicalManaged(file: LocalInstructionFile): boolean {
  return file.content?.startsWith(managedProjectInstructionsHeader) === true;
}

function isLegacyCanonicalManaged(file: LocalInstructionFile): boolean {
  return (
    file.content?.startsWith(legacyManagedProjectInstructionsHeader) === true
  );
}

function isCodexPointerManaged(file: LocalInstructionFile): boolean {
  return file.content?.startsWith(codexManagedInstructionsHeader) === true;
}

function hasManagedSkillMarker(
  file: LocalInstructionFile,
  marker: string,
): boolean {
  const content =
    file.content === undefined ? undefined : normalizeEol(file.content);
  if (content === undefined || !content.startsWith("---\nname: ai-office\n"))
    return false;
  const frontmatterEnd = content.indexOf("\n---\n", 4);
  return (
    frontmatterEnd >= 0 &&
    content.slice(frontmatterEnd + 5).startsWith(`\n${marker}\n`)
  );
}

function isProjectSkillManaged(file: LocalInstructionFile): boolean {
  return hasManagedSkillMarker(file, managedProjectSkillMarker);
}

function isClaudeSkillManaged(file: LocalInstructionFile): boolean {
  return hasManagedSkillMarker(file, claudeSkillMarker);
}

function managedState(
  file: LocalInstructionFile,
  managed: (file: LocalInstructionFile) => boolean,
  expectedContent?: string,
): AgentClientFileState {
  if (!file.exists) return fileState(file, "absent", "missing");
  const owned = managed(file);
  return fileState(
    file,
    owned ? "ai_office_owned" : "user_owned",
    owned
      ? expectedContent === undefined ||
        equivalentText(file.content, expectedContent)
        ? "integrated"
        : "drifted"
      : "unmanaged",
  );
}

function canonicalState(file: LocalInstructionFile): AgentClientFileState {
  return managedState(file, isCanonicalManaged);
}

function codexPointerState(file: LocalInstructionFile): AgentClientFileState {
  if (isLegacyCanonicalManaged(file))
    return fileState(file, "ai_office_owned", "unmanaged");
  return managedState(file, isCodexPointerManaged, codexManagedFileContent);
}

function legacyState(file: LocalInstructionFile): AgentClientFileState {
  return file.exists
    ? fileState(file, "user_owned", "unmanaged")
    : fileState(file, "absent", "missing");
}

interface ClaudeBridgeAnalysis {
  state: AgentClientFileState;
  kind: "absent" | "direct_import" | "managed" | "unmanaged" | "conflict";
  start?: number;
  end?: number;
}

function analyzeClaudeBridge(file: LocalInstructionFile): ClaudeBridgeAnalysis {
  if (!file.exists)
    return { state: fileState(file, "absent", "missing"), kind: "absent" };
  const content = file.content ?? "";
  const starts = [...content.matchAll(new RegExp(claudeManagedStart, "gu"))];
  const ends = [...content.matchAll(new RegExp(claudeManagedEnd, "gu"))];
  if (starts.length === 0 && ends.length === 0) {
    if (/^@AI-OFFICE\.md\s*$/mu.test(content))
      return {
        state: fileState(file, "user_owned", "integrated"),
        kind: "direct_import",
      };
    return {
      state: fileState(file, "user_owned", "unmanaged"),
      kind: "unmanaged",
    };
  }
  if (starts.length !== 1 || ends.length !== 1)
    return {
      state: fileState(file, "merged", "conflict"),
      kind: "conflict",
    };
  const start = starts[0]!.index;
  const end = ends[0]!.index + claudeManagedEnd.length;
  if (end <= start)
    return {
      state: fileState(file, "merged", "conflict"),
      kind: "conflict",
    };
  const managed = content.slice(start, end);
  const normalizedContent = normalizeEol(content);
  const normalizedManaged = normalizeEol(managed);
  const aiOfficeOwned =
    normalizedContent === normalizeEol(claudeManagedFileContent) ||
    normalizedContent.trim() === normalizedManaged.trim();
  return {
    state: fileState(
      file,
      aiOfficeOwned ? "ai_office_owned" : "merged",
      normalizedManaged === normalizeEol(claudeManagedBlock)
        ? "integrated"
        : "drifted",
    ),
    kind: "managed",
    start,
    end,
  };
}

function preservedIssue(
  code: string,
  message: string,
): AgentClientIntegrationIssue {
  return { severity: "warning", code, message };
}

function deleteIfManaged(
  file: LocalInstructionFile,
  managed: (file: LocalInstructionFile) => boolean,
  summary: string,
): AgentClientFileOperation[] {
  if (!managed(file)) return [];
  return [
    {
      kind: "delete",
      relativePath: file.relativePath,
      expectedSha256: file.sha256!,
      ownershipAfter: "absent",
      summary,
    },
  ];
}

function reconcileManagedFile(input: {
  file: LocalInstructionFile;
  nextContent: string;
  managed: (file: LocalInstructionFile) => boolean;
  createSummary: string;
  updateSummary: string;
}): AgentClientFileOperation[] {
  if (!input.file.exists)
    return [
      {
        kind: "create",
        relativePath: input.file.relativePath,
        expectedSha256: null,
        nextContent: input.nextContent,
        ownershipAfter: "ai_office_owned",
        summary: input.createSummary,
      },
    ];
  if (
    input.managed(input.file) &&
    !equivalentText(input.file.content, input.nextContent)
  )
    return [
      {
        kind: "update",
        relativePath: input.file.relativePath,
        expectedSha256: input.file.sha256!,
        nextContent: input.nextContent,
        ownershipAfter: "ai_office_owned",
        summary: input.updateSummary,
      },
    ];
  return [];
}

function canonicalOperations(
  canonical: LocalInstructionFile,
  nextContent: string,
): AgentClientFileOperation[] {
  return reconcileManagedFile({
    file: canonical,
    nextContent,
    managed: isCanonicalManaged,
    createSummary: "Create canonical AI Office project guidance",
    updateSummary: "Update canonical AI Office project guidance",
  });
}

function projectSkillOperations(
  skill: LocalInstructionFile,
  nextContent: string,
): AgentClientFileOperation[] {
  return reconcileManagedFile({
    file: skill,
    nextContent,
    managed: isProjectSkillManaged,
    createSummary: "Install the repository-local AI Office skill",
    updateSummary: "Update the repository-local AI Office skill",
  });
}

function codexPointerOperations(
  pointer: LocalInstructionFile,
): AgentClientFileOperation[] {
  return reconcileManagedFile({
    file: pointer,
    nextContent: codexManagedFileContent,
    managed: (file) =>
      isCodexPointerManaged(file) || isLegacyCanonicalManaged(file),
    createSummary: "Create the minimal Codex pointer to AI-OFFICE.md",
    updateSummary: "Migrate the managed Codex instructions to AI-OFFICE.md",
  });
}

function withoutClaudeManagedBlock(
  content: string,
  start: number,
  end: number,
): string {
  let before = content.slice(0, start);
  let after = content.slice(end);
  if (before.endsWith("\r\n\r\n")) before = before.slice(0, -2);
  else if (before.endsWith("\n\n")) before = before.slice(0, -1);
  if (after.startsWith("\r\n")) after = after.slice(2);
  else if (after.startsWith("\n")) after = after.slice(1);
  return `${before}${after}`;
}

function baseIssues(
  canonical: LocalInstructionFile,
  projectSkill: LocalInstructionFile,
  legacy: LocalInstructionFile,
): AgentClientIntegrationIssue[] {
  const issues: AgentClientIntegrationIssue[] = [];
  if (!canonical.exists)
    issues.push({
      severity: "warning",
      code: "canonical_instructions_missing",
      message:
        "AI-OFFICE.md is missing and can be created from the approved contract",
    });
  else if (!isCanonicalManaged(canonical))
    issues.push({
      severity: "warning",
      code: "canonical_instructions_unmanaged",
      message:
        "AI-OFFICE.md is user-owned and will not be overwritten; reconcile the project guidance manually",
    });
  if (!projectSkill.exists)
    issues.push({
      severity: "warning",
      code: "project_skill_missing",
      message: "The repository-local AI Office skill is missing",
    });
  else if (!isProjectSkillManaged(projectSkill))
    issues.push({
      severity: "warning",
      code: "project_skill_unmanaged",
      message:
        "The repository-local ai-office skill is user-owned and will be preserved",
    });
  if (legacy.exists)
    issues.push({
      severity: "warning",
      code: "legacy_codex_instructions_detected",
      message:
        "CODEX.md is user-owned and requires manual migration or a compatibility pointer",
    });
  return issues;
}

abstract class BaseAgentClientAdapter implements AgentClientAdapter {
  abstract readonly id: AgentClientId;
  abstract readonly displayName: string;
  abstract readonly executableName: string;

  constructor(
    protected readonly files: LocalAgentClientFiles,
    private readonly executables: PathExecutableLocator,
  ) {}

  async detect(): Promise<AgentClientDetection> {
    const executablePath = this.executables.find(this.executableName);
    return {
      clientId: this.id,
      displayName: this.displayName,
      status: executablePath === null ? "not_detected" : "detected",
      ...(executablePath === null ? {} : { executablePath }),
    };
  }

  protected inspectBase(rootPath: string) {
    const root = this.files.resolveRoot(rootPath);
    const canonical = this.files.read(root, canonicalProjectInstructionsPath);
    const projectSkill = this.files.read(root, codexProjectSkillPath);
    const legacy = this.files.read(root, "CODEX.md");
    return {
      root,
      canonical,
      projectSkill,
      legacy,
      issues: baseIssues(canonical, projectSkill, legacy),
    };
  }

  abstract inspect(rootPath: string): Promise<AgentClientInspection>;
  abstract plan(input: {
    rootPath: string;
    canonicalInstructions: string;
    projectSkill: string;
  }): Promise<AgentClientIntegrationDraft>;
  abstract planUninstall(
    rootPath: string,
  ): Promise<AgentClientIntegrationDraft>;

  async apply(plan: AgentClientIntegrationDraft): Promise<void> {
    this.files.apply(this.files.resolveRoot(plan.rootPath), plan.operations);
  }

  abstract validate(rootPath: string): Promise<AgentClientValidation>;
}

export class CodexAgentClientAdapter extends BaseAgentClientAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex CLI";
  readonly executableName = "codex";

  async inspect(rootPath: string): Promise<AgentClientInspection> {
    const { root, canonical, projectSkill, legacy, issues } =
      this.inspectBase(rootPath);
    const pointer = this.files.read(root, codexProjectInstructionsPath);
    if (!pointer.exists)
      issues.push({
        severity: "warning",
        code: "codex_pointer_missing",
        message: "AGENTS.md does not point Codex to AI-OFFICE.md",
      });
    else if (
      !isCodexPointerManaged(pointer) &&
      !isLegacyCanonicalManaged(pointer)
    )
      issues.push({
        severity: "warning",
        code: "codex_pointer_unmanaged",
        message:
          "AGENTS.md is user-owned and will be preserved; add a reference to AI-OFFICE.md manually",
      });
    return {
      clientId: this.id,
      rootPath: root,
      canonicalInstructions: canonicalState(canonical),
      clientInstructions: codexPointerState(pointer),
      skillInstructions: managedState(
        projectSkill,
        isProjectSkillManaged,
        compileProjectSkill(),
      ),
      legacyInstructions: legacyState(legacy),
      issues,
    };
  }

  async plan(input: {
    rootPath: string;
    canonicalInstructions: string;
    projectSkill: string;
  }): Promise<AgentClientIntegrationDraft> {
    const { root, canonical, projectSkill, issues } = this.inspectBase(
      input.rootPath,
    );
    const pointer = this.files.read(root, codexProjectInstructionsPath);
    const operations = [
      ...canonicalOperations(canonical, input.canonicalInstructions),
      ...projectSkillOperations(projectSkill, input.projectSkill),
      ...codexPointerOperations(pointer),
    ];
    if (
      pointer.exists &&
      !isCodexPointerManaged(pointer) &&
      !isLegacyCanonicalManaged(pointer)
    )
      issues.push(
        preservedIssue(
          "codex_pointer_user_owned_preserved",
          "AGENTS.md is user-owned and will be preserved; add a reference to AI-OFFICE.md manually",
        ),
      );
    return {
      contractVersion: 1,
      action: "install",
      clientId: this.id,
      rootPath: root,
      operations,
      issues,
    };
  }

  async planUninstall(rootPath: string): Promise<AgentClientIntegrationDraft> {
    const { root, canonical, projectSkill } = this.inspectBase(rootPath);
    const pointer = this.files.read(root, codexProjectInstructionsPath);
    const issues: AgentClientIntegrationIssue[] = [];
    const operations = [
      ...deleteIfManaged(
        pointer,
        (file) => isCodexPointerManaged(file) || isLegacyCanonicalManaged(file),
        "Delete the AI Office-managed Codex pointer",
      ),
    ];
    if (projectSkill.exists && !isProjectSkillManaged(projectSkill))
      issues.push(
        preservedIssue(
          "project_skill_user_owned_preserved",
          "The repository-local ai-office skill is user-owned and will be preserved",
        ),
      );
    if (
      pointer.exists &&
      !isCodexPointerManaged(pointer) &&
      !isLegacyCanonicalManaged(pointer)
    )
      issues.push(
        preservedIssue(
          "codex_pointer_user_owned_preserved",
          "AGENTS.md is user-owned and will be preserved",
        ),
      );

    const bridge = analyzeClaudeBridge(this.files.read(root, "CLAUDE.md"));
    const sharedRequiredByClaude =
      bridge.kind === "managed" ||
      bridge.kind === "direct_import" ||
      bridge.kind === "conflict";
    if (bridge.kind === "managed" || bridge.kind === "direct_import")
      issues.push(
        preservedIssue(
          "claude_canonical_dependency_preserved",
          "CLAUDE.md imports AI-OFFICE.md, so shared AI Office artifacts will be preserved until the Claude integration is removed",
        ),
      );
    else if (bridge.kind === "conflict")
      issues.push({
        severity: "conflict",
        code: "claude_managed_section_malformed",
        message: "CLAUDE.md contains malformed or duplicated AI Office markers",
      });
    if (canonical.exists && !isCanonicalManaged(canonical))
      issues.push(
        preservedIssue(
          "canonical_instructions_user_owned_preserved",
          "AI-OFFICE.md is user-owned and will be preserved",
        ),
      );

    if (!sharedRequiredByClaude)
      operations.push(
        ...deleteIfManaged(
          projectSkill,
          isProjectSkillManaged,
          "Delete the repository-local AI Office skill",
        ),
        ...deleteIfManaged(
          canonical,
          isCanonicalManaged,
          "Delete AI Office-managed project guidance",
        ),
      );
    return {
      contractVersion: 1,
      action: "uninstall",
      clientId: this.id,
      rootPath: root,
      operations,
      issues,
    };
  }

  override async apply(plan: AgentClientIntegrationDraft): Promise<void> {
    const root = this.files.resolveRoot(plan.rootPath);
    this.files.apply(root, plan.operations, (operation) => {
      if (
        plan.action !== "uninstall" ||
        operation.kind !== "delete" ||
        (operation.relativePath !== canonicalProjectInstructionsPath &&
          operation.relativePath !== codexProjectSkillPath)
      )
        return;
      const bridge = analyzeClaudeBridge(this.files.read(root, "CLAUDE.md"));
      if (
        bridge.kind === "managed" ||
        bridge.kind === "direct_import" ||
        bridge.kind === "conflict"
      )
        throw new AgentClientIntegrationError(
          "CLAUDE.md changed during apply and still requires shared AI Office artifacts; removal was stopped",
        );
    });
  }

  async validate(rootPath: string): Promise<AgentClientValidation> {
    const inspection = await this.inspect(rootPath);
    const issues = [...inspection.issues];
    if (!inspection.canonicalInstructions.exists)
      issues.push({
        severity: "conflict",
        code: "codex_canonical_instructions_unavailable",
        message:
          "Codex cannot load project guidance because AI-OFFICE.md is missing",
      });
    if (!inspection.clientInstructions?.exists)
      issues.push({
        severity: "conflict",
        code: "codex_pointer_unavailable",
        message:
          "Codex cannot discover project guidance because AGENTS.md is missing",
      });
    if (!inspection.skillInstructions?.exists)
      issues.push({
        severity: "conflict",
        code: "codex_skill_unavailable",
        message: "Codex cannot discover the repository-local AI Office skill",
      });
    return {
      clientId: this.id,
      rootPath: inspection.rootPath,
      valid: !issues.some((issue) => issue.severity === "conflict"),
      issues,
    };
  }
}

export class ClaudeAgentClientAdapter extends BaseAgentClientAdapter {
  readonly id = "claude" as const;
  readonly displayName = "Claude Code";
  readonly executableName = "claude";

  async inspect(rootPath: string): Promise<AgentClientInspection> {
    const { root, canonical, projectSkill, legacy, issues } =
      this.inspectBase(rootPath);
    const bridge = analyzeClaudeBridge(this.files.read(root, "CLAUDE.md"));
    const claudeSkill = this.files.read(root, claudeProjectSkillPath);
    if (bridge.kind === "conflict")
      issues.push({
        severity: "conflict",
        code: "claude_managed_section_malformed",
        message: "CLAUDE.md contains malformed or duplicated AI Office markers",
      });
    if (!claudeSkill.exists)
      issues.push({
        severity: "warning",
        code: "claude_skill_missing",
        message:
          "The Claude repository-local AI Office skill bridge is missing",
      });
    else if (!isClaudeSkillManaged(claudeSkill))
      issues.push({
        severity: "warning",
        code: "claude_skill_unmanaged",
        message:
          "The Claude ai-office skill is user-owned and will be preserved",
      });
    return {
      clientId: this.id,
      rootPath: root,
      canonicalInstructions: canonicalState(canonical),
      clientInstructions: bridge.state,
      sharedSkillInstructions: managedState(
        projectSkill,
        isProjectSkillManaged,
        compileProjectSkill(),
      ),
      skillInstructions: managedState(
        claudeSkill,
        isClaudeSkillManaged,
        claudeSkillContent,
      ),
      legacyInstructions: legacyState(legacy),
      issues,
    };
  }

  async plan(input: {
    rootPath: string;
    canonicalInstructions: string;
    projectSkill: string;
  }): Promise<AgentClientIntegrationDraft> {
    const { root, canonical, projectSkill, issues } = this.inspectBase(
      input.rootPath,
    );
    const operations = [
      ...canonicalOperations(canonical, input.canonicalInstructions),
      ...projectSkillOperations(projectSkill, input.projectSkill),
    ];
    const file = this.files.read(root, "CLAUDE.md");
    const bridge = analyzeClaudeBridge(file);
    if (bridge.kind === "absent")
      operations.push({
        kind: "create",
        relativePath: "CLAUDE.md",
        expectedSha256: null,
        nextContent: claudeManagedFileContent,
        ownershipAfter: "ai_office_owned",
        summary: "Create a Claude bridge to AI-OFFICE.md",
      });
    else if (bridge.kind === "unmanaged")
      operations.push({
        kind: "update",
        relativePath: "CLAUDE.md",
        expectedSha256: file.sha256!,
        nextContent: `${file.content!.trimEnd()}\n\n${claudeManagedBlock}\n`,
        ownershipAfter: "merged",
        summary: "Append an AI Office-managed project guidance bridge",
      });
    else if (
      bridge.kind === "managed" &&
      bridge.state.integrationStatus !== "integrated"
    )
      operations.push({
        kind: "update",
        relativePath: "CLAUDE.md",
        expectedSha256: file.sha256!,
        nextContent: `${file.content!.slice(0, bridge.start!)}${claudeManagedBlock}${file.content!.slice(bridge.end!)}`,
        ownershipAfter:
          bridge.state.ownership === "merged" ? "merged" : "ai_office_owned",
        summary: "Migrate the Claude bridge to AI-OFFICE.md",
      });
    else if (bridge.kind === "conflict")
      issues.push({
        severity: "conflict",
        code: "claude_managed_section_malformed",
        message: "CLAUDE.md contains malformed or duplicated AI Office markers",
      });

    const claudeSkill = this.files.read(root, claudeProjectSkillPath);
    operations.push(
      ...reconcileManagedFile({
        file: claudeSkill,
        nextContent: claudeSkillContent,
        managed: isClaudeSkillManaged,
        createSummary: "Install the Claude repository-local AI Office skill",
        updateSummary: "Update the Claude repository-local AI Office skill",
      }),
    );
    if (claudeSkill.exists && !isClaudeSkillManaged(claudeSkill))
      issues.push(
        preservedIssue(
          "claude_skill_user_owned_preserved",
          "The Claude ai-office skill is user-owned and will be preserved",
        ),
      );
    return {
      contractVersion: 1,
      action: "install",
      clientId: this.id,
      rootPath: root,
      operations,
      issues,
    };
  }

  async planUninstall(rootPath: string): Promise<AgentClientIntegrationDraft> {
    const { root, canonical, projectSkill } = this.inspectBase(rootPath);
    const file = this.files.read(root, "CLAUDE.md");
    const bridge = analyzeClaudeBridge(file);
    const claudeSkill = this.files.read(root, claudeProjectSkillPath);
    const operations: AgentClientFileOperation[] = [
      ...deleteIfManaged(
        claudeSkill,
        isClaudeSkillManaged,
        "Delete the Claude repository-local AI Office skill",
      ),
    ];
    const issues: AgentClientIntegrationIssue[] = [];

    if (bridge.kind === "managed") {
      if (bridge.state.ownership === "ai_office_owned")
        operations.push({
          kind: "delete",
          relativePath: "CLAUDE.md",
          expectedSha256: file.sha256!,
          ownershipAfter: "absent",
          summary: "Delete the AI Office-owned Claude instruction bridge",
        });
      else
        operations.push({
          kind: "update",
          relativePath: "CLAUDE.md",
          expectedSha256: file.sha256!,
          nextContent: withoutClaudeManagedBlock(
            file.content!,
            bridge.start!,
            bridge.end!,
          ),
          ownershipAfter: "user_owned",
          summary: "Remove only the AI Office-managed bridge from CLAUDE.md",
        });
    } else if (bridge.kind === "direct_import" || bridge.kind === "unmanaged")
      issues.push(
        preservedIssue(
          "claude_instructions_user_owned_preserved",
          "CLAUDE.md is user-owned and will be preserved",
        ),
      );
    else if (bridge.kind === "conflict")
      issues.push({
        severity: "conflict",
        code: "claude_managed_section_malformed",
        message: "CLAUDE.md contains malformed or duplicated AI Office markers",
      });

    if (claudeSkill.exists && !isClaudeSkillManaged(claudeSkill))
      issues.push(
        preservedIssue(
          "claude_skill_user_owned_preserved",
          "The Claude ai-office skill is user-owned and will be preserved",
        ),
      );
    const codexInstructions = this.files.read(
      root,
      codexProjectInstructionsPath,
    );
    const sharedRequired =
      codexInstructions.exists ||
      bridge.kind === "direct_import" ||
      bridge.kind === "conflict";
    if (
      sharedRequired &&
      (isCanonicalManaged(canonical) || isProjectSkillManaged(projectSkill))
    )
      issues.push(
        preservedIssue(
          "canonical_instructions_shared_preserved",
          "Shared AI-OFFICE.md guidance and the primary repository skill are still referenced by repository host instructions and will be preserved",
        ),
      );
    else if (!sharedRequired)
      operations.push(
        ...deleteIfManaged(
          projectSkill,
          isProjectSkillManaged,
          "Delete the repository-local AI Office skill",
        ),
        ...deleteIfManaged(
          canonical,
          isCanonicalManaged,
          "Delete AI Office-managed project guidance",
        ),
      );

    return {
      contractVersion: 1,
      action: "uninstall",
      clientId: this.id,
      rootPath: root,
      operations,
      issues,
    };
  }

  override async apply(plan: AgentClientIntegrationDraft): Promise<void> {
    const root = this.files.resolveRoot(plan.rootPath);
    this.files.apply(root, plan.operations, (operation) => {
      if (
        plan.action !== "uninstall" ||
        operation.kind !== "delete" ||
        (operation.relativePath !== canonicalProjectInstructionsPath &&
          operation.relativePath !== codexProjectSkillPath)
      )
        return;
      const codexInstructions = this.files.read(
        root,
        codexProjectInstructionsPath,
      );
      const bridge = analyzeClaudeBridge(this.files.read(root, "CLAUDE.md"));
      if (
        codexInstructions.exists ||
        bridge.kind === "managed" ||
        bridge.kind === "direct_import" ||
        bridge.kind === "conflict"
      )
        throw new AgentClientIntegrationError(
          "Repository host instructions changed during apply and still require shared AI Office artifacts; removal was stopped",
        );
    });
  }

  async validate(rootPath: string): Promise<AgentClientValidation> {
    const inspection = await this.inspect(rootPath);
    const issues = [...inspection.issues];
    if (!inspection.canonicalInstructions.exists)
      issues.push({
        severity: "conflict",
        code: "claude_canonical_instructions_unavailable",
        message:
          "Claude cannot import canonical guidance because AI-OFFICE.md is missing",
      });
    if (
      inspection.clientInstructions?.integrationStatus !== "integrated" &&
      inspection.clientInstructions?.integrationStatus !== "conflict"
    )
      issues.push({
        severity: "conflict",
        code: "claude_bridge_unavailable",
        message: "CLAUDE.md does not import AI-OFFICE.md",
      });
    if (!inspection.skillInstructions?.exists)
      issues.push({
        severity: "conflict",
        code: "claude_skill_unavailable",
        message: "Claude cannot discover its repository-local AI Office skill",
      });
    return {
      clientId: this.id,
      rootPath: inspection.rootPath,
      valid: !issues.some((issue) => issue.severity === "conflict"),
      issues,
    };
  }
}

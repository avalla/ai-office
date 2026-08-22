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
import { managedProjectInstructionsHeader } from "@ai-office/application/agent-client/instruction-compiler.ts";
import { AgentClientIntegrationError } from "@ai-office/application/agent-client/errors.ts";
import {
  LocalAgentClientFiles,
  PathExecutableLocator,
  type LocalInstructionFile,
} from "./local-agent-client-files.ts";

export const claudeManagedStart =
  "<!-- >>> ai-office managed: canonical-project-instructions -->";
export const claudeManagedEnd =
  "<!-- <<< ai-office managed: canonical-project-instructions -->";
const claudeImport = "@AGENTS.md";
const claudeManagedBlock = `${claudeManagedStart}\n${claudeImport}\n${claudeManagedEnd}`;
const claudeManagedFileContent = `# Claude Code compatibility\n\n${claudeManagedBlock}\n`;

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

function canonicalState(file: LocalInstructionFile): AgentClientFileState {
  if (!file.exists) return fileState(file, "absent", "missing");
  const owned = isCanonicalManaged(file);
  return fileState(
    file,
    owned ? "ai_office_owned" : "user_owned",
    owned ? "integrated" : "unmanaged",
  );
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
    if (/^@AGENTS\.md\s*$/mu.test(content))
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
  const aiOfficeOwned =
    content === claudeManagedFileContent || content.trim() === managed.trim();
  return {
    state: fileState(
      file,
      aiOfficeOwned ? "ai_office_owned" : "merged",
      managed === claudeManagedBlock ? "integrated" : "unmanaged",
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

function canonicalUninstallOperations(
  canonical: LocalInstructionFile,
): AgentClientFileOperation[] {
  if (!isCanonicalManaged(canonical)) return [];
  return [
    {
      kind: "delete",
      relativePath: "AGENTS.md",
      expectedSha256: canonical.sha256!,
      ownershipAfter: "absent",
      summary: "Delete AI Office-managed canonical project instructions",
    },
  ];
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
  legacy: LocalInstructionFile,
): AgentClientIntegrationIssue[] {
  const issues: AgentClientIntegrationIssue[] = [];
  if (!canonical.exists)
    issues.push({
      severity: "warning",
      code: "canonical_instructions_missing",
      message:
        "AGENTS.md is missing and can be created from the approved contract",
    });
  else if (!isCanonicalManaged(canonical))
    issues.push({
      severity: "warning",
      code: "canonical_instructions_unmanaged",
      message:
        "AGENTS.md is user-owned: the client can consume it, but AI Office will not overwrite it or attest that its instruction contract is installed; reconcile it manually if needed",
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

function canonicalOperations(
  canonical: LocalInstructionFile,
  nextContent: string,
): AgentClientFileOperation[] {
  if (!canonical.exists)
    return [
      {
        kind: "create",
        relativePath: "AGENTS.md",
        expectedSha256: null,
        nextContent,
        ownershipAfter: "ai_office_owned",
        summary: "Create canonical AI Office-managed project instructions",
      },
    ];
  if (isCanonicalManaged(canonical) && canonical.content !== nextContent)
    return [
      {
        kind: "update",
        relativePath: "AGENTS.md",
        expectedSha256: canonical.sha256!,
        nextContent,
        ownershipAfter: "ai_office_owned",
        summary: "Update canonical AI Office-managed project instructions",
      },
    ];
  return [];
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
    const canonical = this.files.read(root, "AGENTS.md");
    const legacy = this.files.read(root, "CODEX.md");
    return { root, canonical, legacy, issues: baseIssues(canonical, legacy) };
  }

  abstract inspect(rootPath: string): Promise<AgentClientInspection>;
  abstract plan(input: {
    rootPath: string;
    canonicalInstructions: string;
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
    const { root, canonical, legacy, issues } = this.inspectBase(rootPath);
    return {
      clientId: this.id,
      rootPath: root,
      canonicalInstructions: canonicalState(canonical),
      legacyInstructions: legacyState(legacy),
      issues,
    };
  }

  async plan(input: {
    rootPath: string;
    canonicalInstructions: string;
  }): Promise<AgentClientIntegrationDraft> {
    const { root, canonical, issues } = this.inspectBase(input.rootPath);
    return {
      contractVersion: 1,
      action: "install",
      clientId: this.id,
      rootPath: root,
      operations: canonicalOperations(canonical, input.canonicalInstructions),
      issues,
    };
  }

  async planUninstall(rootPath: string): Promise<AgentClientIntegrationDraft> {
    const { root, canonical } = this.inspectBase(rootPath);
    const issues: AgentClientIntegrationIssue[] = [];
    let canonicalRequiredByClaude = false;
    if (canonical.exists && !isCanonicalManaged(canonical))
      issues.push(
        preservedIssue(
          "canonical_instructions_user_owned_preserved",
          "AGENTS.md is user-owned and will be preserved",
        ),
      );

    if (isCanonicalManaged(canonical)) {
      const claude = this.files.read(root, "CLAUDE.md");
      const bridge = analyzeClaudeBridge(claude);
      if (bridge.kind === "managed" || bridge.kind === "direct_import") {
        canonicalRequiredByClaude = true;
        issues.push(
          preservedIssue(
            "claude_canonical_dependency_preserved",
            "CLAUDE.md imports AGENTS.md, so the managed canonical file remains required and will be preserved; remove the Claude dependency before retrying Codex uninstall",
          ),
        );
      } else if (bridge.kind === "conflict") {
        canonicalRequiredByClaude = true;
        issues.push({
          severity: "conflict",
          code: "claude_managed_section_malformed",
          message:
            "CLAUDE.md contains malformed or duplicated AI Office markers",
        });
      }
    }

    return {
      contractVersion: 1,
      action: "uninstall",
      clientId: this.id,
      rootPath: root,
      operations: canonicalRequiredByClaude
        ? []
        : canonicalUninstallOperations(canonical),
      issues,
    };
  }

  override async apply(plan: AgentClientIntegrationDraft): Promise<void> {
    const root = this.files.resolveRoot(plan.rootPath);
    this.files.apply(root, plan.operations, (operation) => {
      if (
        plan.action !== "uninstall" ||
        operation.kind !== "delete" ||
        operation.relativePath !== "AGENTS.md"
      )
        return;
      const bridge = analyzeClaudeBridge(this.files.read(root, "CLAUDE.md"));
      if (
        bridge.kind === "managed" ||
        bridge.kind === "direct_import" ||
        bridge.kind === "conflict"
      )
        throw new AgentClientIntegrationError(
          "CLAUDE.md changed during apply and still requires AGENTS.md; canonical removal was stopped",
        );
    });
  }

  async validate(rootPath: string): Promise<AgentClientValidation> {
    const inspection = await this.inspect(rootPath);
    const issues = inspection.canonicalInstructions.exists
      ? inspection.issues
      : [
          ...inspection.issues.filter(
            (issue) => issue.code !== "canonical_instructions_missing",
          ),
          {
            severity: "conflict" as const,
            code: "codex_canonical_instructions_unavailable",
            message:
              "Codex cannot load project instructions because AGENTS.md is missing",
          },
        ];
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
    const { root, canonical, legacy, issues } = this.inspectBase(rootPath);
    const bridge = analyzeClaudeBridge(this.files.read(root, "CLAUDE.md"));
    if (bridge.kind === "conflict")
      issues.push({
        severity: "conflict",
        code: "claude_managed_section_malformed",
        message: "CLAUDE.md contains malformed or duplicated AI Office markers",
      });
    return {
      clientId: this.id,
      rootPath: root,
      canonicalInstructions: canonicalState(canonical),
      clientInstructions: bridge.state,
      legacyInstructions: legacyState(legacy),
      issues,
    };
  }

  async plan(input: {
    rootPath: string;
    canonicalInstructions: string;
  }): Promise<AgentClientIntegrationDraft> {
    const { root, canonical, issues } = this.inspectBase(input.rootPath);
    const operations = canonicalOperations(
      canonical,
      input.canonicalInstructions,
    );
    const file = this.files.read(root, "CLAUDE.md");
    const bridge = analyzeClaudeBridge(file);
    if (bridge.kind === "absent")
      operations.push({
        kind: "create",
        relativePath: "CLAUDE.md",
        expectedSha256: null,
        nextContent: `# Claude Code compatibility\n\n${claudeManagedBlock}\n`,
        ownershipAfter: "ai_office_owned",
        summary: "Create a Claude bridge to canonical AGENTS.md instructions",
      });
    else if (bridge.kind === "unmanaged")
      operations.push({
        kind: "update",
        relativePath: "CLAUDE.md",
        expectedSha256: file.sha256!,
        nextContent: `${file.content!.trimEnd()}\n\n${claudeManagedBlock}\n`,
        ownershipAfter: "merged",
        summary: "Append an AI Office-managed canonical instruction bridge",
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
        summary: "Refresh the AI Office-managed canonical instruction bridge",
      });
    else if (bridge.kind === "conflict")
      issues.push({
        severity: "conflict",
        code: "claude_managed_section_malformed",
        message: "CLAUDE.md contains malformed or duplicated AI Office markers",
      });
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
    const { root, canonical } = this.inspectBase(rootPath);
    const file = this.files.read(root, "CLAUDE.md");
    const bridge = analyzeClaudeBridge(file);
    const operations: AgentClientFileOperation[] = [];
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

    if (isCanonicalManaged(canonical))
      issues.push(
        preservedIssue(
          "canonical_instructions_shared_preserved",
          "AI Office-managed AGENTS.md is shared with Codex and will be preserved; uninstall the Codex integration separately to remove it",
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

  async validate(rootPath: string): Promise<AgentClientValidation> {
    const inspection = await this.inspect(rootPath);
    const issues = inspection.canonicalInstructions.exists
      ? [...inspection.issues]
      : inspection.issues.filter(
          (issue) => issue.code !== "canonical_instructions_missing",
        );
    if (!inspection.canonicalInstructions.exists)
      issues.push({
        severity: "conflict",
        code: "claude_canonical_instructions_unavailable",
        message:
          "Claude cannot import canonical instructions because AGENTS.md is missing",
      });
    if (
      inspection.clientInstructions?.integrationStatus !== "integrated" &&
      inspection.clientInstructions?.integrationStatus !== "conflict"
    )
      issues.push({
        severity: "conflict",
        code: "claude_bridge_unavailable",
        message: "CLAUDE.md does not import canonical AGENTS.md instructions",
      });
    return {
      clientId: this.id,
      rootPath: inspection.rootPath,
      valid: !issues.some((issue) => issue.severity === "conflict"),
      issues,
    };
  }
}

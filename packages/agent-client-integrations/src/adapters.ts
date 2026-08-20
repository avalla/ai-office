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

function canonicalState(file: LocalInstructionFile): AgentClientFileState {
  if (!file.exists) return fileState(file, "absent", "missing");
  const owned =
    file.content?.startsWith(managedProjectInstructionsHeader) === true;
  return fileState(
    file,
    owned ? "ai_office_owned" : "user_owned",
    "integrated",
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
  if (/^@AGENTS\.md\s*$/mu.test(content))
    return {
      state: fileState(file, "user_owned", "integrated"),
      kind: "direct_import",
    };
  const starts = [...content.matchAll(new RegExp(claudeManagedStart, "gu"))];
  const ends = [...content.matchAll(new RegExp(claudeManagedEnd, "gu"))];
  if (starts.length === 0 && ends.length === 0)
    return {
      state: fileState(file, "user_owned", "unmanaged"),
      kind: "unmanaged",
    };
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
  return {
    state: fileState(
      file,
      content.trim() === managed.trim() ? "ai_office_owned" : "merged",
      managed === claudeManagedBlock ? "integrated" : "unmanaged",
    ),
    kind: "managed",
    start,
    end,
  };
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
  if (
    canonical.content?.startsWith(managedProjectInstructionsHeader) === true &&
    canonical.content !== nextContent
  )
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
      clientId: this.id,
      rootPath: root,
      operations: canonicalOperations(canonical, input.canonicalInstructions),
      issues,
    };
  }

  async validate(rootPath: string): Promise<AgentClientValidation> {
    const inspection = await this.inspect(rootPath);
    const issues = inspection.canonicalInstructions.exists
      ? inspection.issues
      : [
          ...inspection.issues,
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
      clientId: this.id,
      rootPath: root,
      operations,
      issues,
    };
  }

  async validate(rootPath: string): Promise<AgentClientValidation> {
    const inspection = await this.inspect(rootPath);
    const issues = [...inspection.issues];
    if (!inspection.canonicalInstructions.exists)
      issues.push({
        severity: "conflict",
        code: "claude_canonical_instructions_unavailable",
        message:
          "Claude cannot import canonical instructions because AGENTS.md is missing",
      });
    if (inspection.clientInstructions?.integrationStatus !== "integrated")
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

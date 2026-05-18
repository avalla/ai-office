import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, relative } from "path";

export type InstructionMergeMode = "section" | "sidecar" | "append" | "skip" | "overwrite-explicit";
export type InstructionConflictPolicy = "ask" | "keep-existing" | "prefer-ai-office" | "sidecar";

export interface InstructionMergeOptions {
  mode?: InstructionMergeMode;
  backup?: boolean;
  conflictPolicy?: InstructionConflictPolicy;
  sidecarDir?: string;
}

export interface InstructionFileEntry {
  file: string;
  tool: string;
  status: "existing" | "generated" | "missing";
  action: string;
}

const START_MARKER = "<!-- AI-OFFICE:START -->";
const END_MARKER = "<!-- AI-OFFICE:END -->";

const KNOWN_PATHS: Array<{ path: string; tool: string }> = [
  { path: "AGENTS.md", tool: "generic/codex" },
  { path: "agents.md", tool: "generic-agent-instructions" },
  { path: ".agent.md", tool: "generic-agent-instructions" },
  { path: ".ai/AGENTS.md", tool: "generic-agent-instructions" },
  { path: ".github/copilot-instructions.md", tool: "GitHub Copilot" },
  { path: "CLAUDE.md", tool: "Claude Code" },
  { path: "GEMINI.md", tool: "Gemini" },
  { path: ".cursorrules", tool: "Cursor" },
  { path: "opencode.json", tool: "OpenCode" },
];

const KNOWN_DIRS: Array<{ path: string; tool: string }> = [
  { path: ".claude", tool: "Claude Code" },
  { path: ".codex", tool: "Codex" },
  { path: ".windsurf", tool: "Windsurf" },
  { path: ".cursor", tool: "Cursor" },
  { path: ".opencode", tool: "OpenCode" },
  { path: ".gemini", tool: "Gemini" },
];

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".ai-office",
  // Framework internals should not be treated as target-project agent prompts
  // when AI Office is developed inside its own repository.
  "skeleton",
]);

export function aiOfficeManagedBlock(): string {
  return [
    START_MARKER,
    "## AI Office",
    "",
    "This repository uses AI Office as a repo-native workflow and memory layer for AI coding agents.",
    "",
    "Before implementation:",
    "1. Read `AI-OFFICE.md`.",
    "2. Read `.ai-office/project.config.md`.",
    "3. Read `.ai-office/office-profile.md`.",
    "4. Read `.ai-office/pipeline.md`.",
    "5. Read `.ai-office/agent-operating-model.md`.",
    "6. Follow `.ai-office/collaboration-gates.md`.",
    "",
    "Prefer deterministic `ai-office` CLI commands for state changes.",
    "",
    "For non-trivial work, run the intent-check / plan / task / commit traceability flow.",
    "",
    END_MARKER,
  ].join("\n");
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function classifyPath(path: string): string {
  if (path === "CLAUDE.md" || path === ".claude" || path.startsWith(".claude/")) return "Claude Code";
  if (path === "AGENTS.md") return "generic/codex";
  if (path === ".codex" || path.startsWith(".codex/")) return "Codex";
  if (path === ".github/copilot-instructions.md") return "GitHub Copilot";
  if (path === ".cursor" || path.startsWith(".cursor/") || path === ".cursorrules") return "Cursor";
  if (path === ".windsurf" || path.startsWith(".windsurf/")) return "Windsurf";
  if (path === "opencode.json" || path === ".opencode" || path.startsWith(".opencode/")) return "OpenCode";
  if (path === "GEMINI.md" || path === ".gemini" || path.startsWith(".gemini/")) return "Gemini";
  if (/(ruflo|gsd)/i.test(path)) return "unknown-agent-tool";
  if (/(agent|claude|codex|ai|prompt)/i.test(basename(path)) && path.endsWith(".md")) return "unknown-agent-instructions";
  return "unknown-agent-tool";
}

function walkInstructionCandidates(root: string, current: string, out: Set<string>): void {
  for (const name of readdirSync(current)) {
    const full = join(current, name);
    const rel = toPosix(relative(root, full));
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!EXCLUDED_DIRS.has(name) && !rel.split("/").some((part) => EXCLUDED_DIRS.has(part))) {
        walkInstructionCandidates(root, full, out);
      }
      continue;
    }
    if (/(agent|claude|codex|ai|prompt)/i.test(name) && name.endsWith(".md")) {
      out.add(rel);
    }
  }
}

export function scanAgentInstructions(projectRoot: string): InstructionFileEntry[] {
  const files = new Set<string>();
  for (const item of KNOWN_PATHS) {
    if (existsSync(join(projectRoot, item.path))) files.add(item.path);
  }
  for (const item of KNOWN_DIRS) {
    const dir = join(projectRoot, item.path);
    if (!existsSync(dir)) continue;
    files.add(item.path);
    if (existsSync(join(dir, "skills"))) files.add(`${item.path}/skills`);
    if (existsSync(join(dir, "commands"))) files.add(`${item.path}/commands`);
    if (existsSync(join(dir, "rules"))) files.add(`${item.path}/rules`);
    if (existsSync(join(dir, "workflows"))) files.add(`${item.path}/workflows`);
  }
  if (existsSync(projectRoot)) {
    walkInstructionCandidates(projectRoot, projectRoot, files);
  }

  return [...files]
    .sort()
    .map((file) => ({
      file,
      tool: classifyPath(file),
      status: "existing",
      action: "detected",
    }));
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
}

function backupFile(projectRoot: string, relPath: string, backupRoot?: string): string {
  const root = backupRoot ?? join(projectRoot, ".ai-office/backups/instructions", timestamp());
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(projectRoot, relPath), target);
  return toPosix(relative(projectRoot, root));
}

function replaceManagedBlock(existing: string, block: string): string {
  const pattern = new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}`);
  if (pattern.test(existing)) {
    return `${existing.replace(pattern, block).trimEnd()}\n`;
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}

function ensureManagedMarkdown(content: string): string {
  if (content.includes(START_MARKER) && content.includes(END_MARKER)) {
    return `${content.trimEnd()}\n`;
  }
  return `${content.trimEnd()}\n\n${aiOfficeManagedBlock()}\n`;
}

function sidecarPath(relPath: string): string {
  const clean = relPath.replace(/[/.]/g, "-").replace(/^-+|-+$/g, "");
  return `${clean || "instructions"}.ai-office.md`;
}

function mergeJsonInstruction(existing: string, generated: string): string {
  let current: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    current = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON instruction file; refusing to merge");
  }
  try {
    next = JSON.parse(generated) as Record<string, unknown>;
  } catch {
    next = { instructions: ["AI-OFFICE.md"] };
  }

  const currentInstructions = Array.isArray(current.instructions) ? current.instructions : [];
  const nextInstructions = Array.isArray(next.instructions) ? next.instructions : ["AI-OFFICE.md"];
  const instructions = [...currentInstructions];
  for (const item of nextInstructions) {
    if (typeof item === "string" && !instructions.includes(item)) {
      instructions.push(item);
    }
  }

  // Generated defaults should fill gaps, not replace user-owned configuration.
  // Keep current keys authoritative and update only AI Office owned metadata.
  return `${JSON.stringify({ ...next, ...current, instructions, aiOfficeManaged: true }, null, 2)}\n`;
}

export function mergeInstructionFile(
  projectRoot: string,
  relPath: string,
  generatedContent: string,
  options: InstructionMergeOptions = {},
): InstructionFileEntry {
  const mode = options.mode ?? "section";
  const backup = options.backup ?? true;
  const sidecarDir = options.sidecarDir ?? ".ai-office/instructions";
  const fullPath = join(projectRoot, relPath);

  if (mode === "skip") {
    return { file: relPath, tool: classifyPath(relPath), status: existsSync(fullPath) ? "existing" : "missing", action: "skipped" };
  }

  if (mode === "sidecar" && existsSync(fullPath)) {
    const sidecarRel = toPosix(join(sidecarDir, sidecarPath(relPath)));
    mkdirSync(dirname(join(projectRoot, sidecarRel)), { recursive: true });
    writeFileSync(join(projectRoot, sidecarRel), `${aiOfficeManagedBlock()}\n`, "utf8");
    return { file: relPath, tool: classifyPath(relPath), status: "existing", action: `sidecar ${sidecarRel}` };
  }

  if (!existsSync(fullPath)) {
    mkdirSync(dirname(fullPath), { recursive: true });
    const content = relPath.endsWith(".json")
      ? mergeJsonInstruction("{}", generatedContent)
      : ensureManagedMarkdown(generatedContent);
    writeFileSync(fullPath, content, "utf8");
    return { file: relPath, tool: classifyPath(relPath), status: "generated", action: "created" };
  }

  const backupRel = backup ? backupFile(projectRoot, relPath) : "";
  const existing = readFileSync(fullPath, "utf8");
  let merged: string;
  if (mode === "overwrite-explicit") {
    merged = generatedContent;
  } else if (relPath.endsWith(".json")) {
    merged = mergeJsonInstruction(existing, generatedContent);
  } else {
    merged = replaceManagedBlock(existing, aiOfficeManagedBlock());
  }
  writeFileSync(fullPath, merged, "utf8");
  return {
    file: relPath,
    tool: classifyPath(relPath),
    status: "existing",
    action: `${mode === "overwrite-explicit" ? "overwrote explicitly" : "merged managed section"}${backupRel ? `; backup ${backupRel}` : ""}`,
  };
}

export function writeInstructionDiscoveryReport(
  projectRoot: string,
  entries: InstructionFileEntry[],
  options: InstructionMergeOptions = {},
): void {
  const lines = [
    "# Agent Instruction Discovery",
    "",
    "## Detected Files",
    "",
    "| File | Tool | Status | Action |",
    "|------|------|--------|--------|",
    ...entries.map((entry) => `| ${entry.file} | ${entry.tool} | ${entry.status} | ${entry.action} |`),
    "",
    "## Merge Mode",
    "",
    options.mode ?? "section",
    "",
    "## Conflict Policy",
    "",
    options.conflictPolicy ?? "keep-existing",
    "",
    "## Backups",
    "",
    options.backup === false ? "disabled" : ".ai-office/backups/instructions/",
    "",
    "## Notes",
    "",
    "User-owned content outside `AI-OFFICE:START/END` blocks was preserved.",
    "Unknown tool configs are reported and left untouched unless explicitly targeted.",
    "",
  ];
  const target = join(projectRoot, ".ai-office/instruction-discovery.md");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lines.join("\n"), "utf8");
}

export function writeInstructionMergePolicy(projectRoot: string): void {
  const target = join(projectRoot, ".ai-office/instruction-merge-policy.md");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, [
    "# Instruction Merge Policy",
    "",
    "AI Office preserves existing AI agent instructions.",
    "",
    "## Rules",
    "",
    "- User-owned content is never overwritten by default.",
    "- AI Office writes only inside managed blocks.",
    "- Existing files are backed up before modification.",
    "- Unknown tool configs are reported but not modified unless explicitly targeted.",
    "- JSON configs are merged conservatively.",
    "- Sidecar mode is available when you do not want AI Office to touch existing files.",
    "",
    "## Managed Block",
    "",
    "AI Office uses this marker:",
    "",
    "```markdown",
    START_MARKER,
    "...",
    END_MARKER,
    "```",
    "",
    "Only content inside this block is managed by AI Office.",
    "",
  ].join("\n"), "utf8");
}

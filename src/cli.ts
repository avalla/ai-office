#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "path";
import { ADAPTER_PROFILES, type AdapterHost } from "./adapter-manifest";

const COLUMNS = ["BACKLOG", "TODO", "WIP", "REVIEW", "BLOCKED", "DONE", "ARCHIVED"] as const;
const VALID_STATES = [
  "router",
  "create_project",
  "prd",
  "adr",
  "plan",
  "tasks",
  "ux_research",
  "design_ui",
  "dev",
  "security",
  "qa",
  "review",
  "user_acceptance",
  "release",
  "postmortem",
  "blocked",
] as const;
const VALID_VALIDATE_STAGES = ["prd", "adr", "plan", "tasks", "dev", "security", "qa", "review", "user_acceptance", "release"] as const;

type Column = (typeof COLUMNS)[number];
type StatusState = (typeof VALID_STATES)[number];
type ValidateStage = (typeof VALID_VALIDATE_STAGES)[number];
type InstalledAdapter = AdapterHost;

type ProjectConfig = {
  agency: string;
  projectName: string;
  uiFramework: string;
  advanceMode: string;
  typecheckCmd: string;
  lintCmd: string;
  testCmd: string;
  coverageMin: number;
  lighthouseMin: number;
  taskIsolationMode: string;
  taskBaseBranch: string;
  taskMergeTarget: string;
  taskWorktreeRoot: string;
};

type TaskCreateInput = {
  title: string;
  milestone: string;
  priority: string;
  column: Column;
  assignee: string;
  deps: string;
  estimate: string;
  labels: string;
  slug: string;
};

type MilestoneInfo = {
  id: string;
  name: string;
  target: string;
  status: string;
  created: string;
  path: string;
};

type ValidationItem = {
  level: "pass" | "warn" | "fail";
  message: string;
  detail?: string;
};

type InstallMetadata = {
  version?: string;
  adapter?: string;
  installedAt?: string;
};

const cwd = process.cwd();
const aiOfficeDir = join(cwd, ".ai-office");
const tasksDir = join(aiOfficeDir, "tasks");
const docsDir = join(aiOfficeDir, "docs");
const runbooksDir = join(docsDir, "runbooks");
const prdDir = join(docsDir, "prd");
const adrDir = join(docsDir, "adr");
const milestonesDir = join(aiOfficeDir, "milestones");
const tasksReadmePath = join(tasksDir, "README.md");
const milestonesReadmePath = join(milestonesDir, "README.md");
const installMetaPath = join(aiOfficeDir, "install.json");
const ADAPTER_PROFILE_BY_HOST = new Map(ADAPTER_PROFILES.map((profile) => [profile.host, profile]));
const ADAPTER_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".ai-office",
  "dist",
  "build",
  "coverage",
  "tmp",
  ...ADAPTER_PROFILES.flatMap((profile) => [
    profile.installedSkillRoot?.split("/")[0],
    profile.installedRulesRoot?.split("/")[0],
    profile.installedWorkflowRoot?.split("/")[0],
  ]).filter((value): value is string => Boolean(value)),
]);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function ensureAiOffice(): void {
  if (!existsSync(aiOfficeDir)) {
    fail("❌ .ai-office/ not found. Run ./install.sh first.");
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function writeText(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

function getInstallMetadata(): InstallMetadata | null {
  if (!existsSync(installMetaPath)) {
    return null;
  }

  try {
    return JSON.parse(readText(installMetaPath)) as InstallMetadata;
  } catch {
    return null;
  }
}

function getAdapterProfile(host: InstalledAdapter) {
  const profile = ADAPTER_PROFILE_BY_HOST.get(host);
  if (!profile) {
    throw new Error(`Unknown adapter profile: ${host}`);
  }
  return profile;
}

function projectPathExists(relativePath?: string): boolean {
  return Boolean(relativePath) && existsSync(join(cwd, relativePath));
}

function adapterInstructionExists(host: InstalledAdapter): boolean {
  const profile = getAdapterProfile(host);
  if (!profile.instructionFileName) {
    return false;
  }
  if (host === "claude-code") {
    return existsSync(join(cwd, profile.instructionFileName)) || existsSync(join(cwd, ".claude", profile.instructionFileName));
  }
  return existsSync(join(cwd, profile.instructionFileName));
}

function detectAdapter(): InstalledAdapter {
  const metadata = getInstallMetadata();
  if (
    metadata?.adapter === "codex" ||
    metadata?.adapter === "windsurf" ||
    metadata?.adapter === "claude-code" ||
    metadata?.adapter === "base"
  ) {
    return metadata.adapter;
  }

  if (
    projectPathExists(getAdapterProfile("windsurf").installedWorkflowRoot) ||
    projectPathExists(getAdapterProfile("windsurf").installedRulesRoot)
  ) {
    return "windsurf";
  }
  if (projectPathExists(getAdapterProfile("codex").installedSkillRoot) || adapterInstructionExists("codex")) {
    return "codex";
  }
  if (projectPathExists(getAdapterProfile("claude-code").installedSkillRoot) || adapterInstructionExists("claude-code")) {
    return "claude-code";
  }
  return "base";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function kebabCase(value: string, maxLength = 40): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, maxLength) || "task";
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyValue) {
      continue;
    }
    const [, key, rawValue] = keyValue;
    result[key] = rawValue.replace(/^["']|["']$/g, "").trim();
  }
  return result;
}

function getProjectConfig(): ProjectConfig {
  const defaults: ProjectConfig = {
    agency: "software-studio",
    projectName: basename(cwd),
    uiFramework: "",
    advanceMode: "manual",
    typecheckCmd: "npm run typecheck",
    lintCmd: "npm run lint",
    testCmd: "npm run test",
    coverageMin: 80,
    lighthouseMin: 90,
    taskIsolationMode: "none",
    taskBaseBranch: "dev",
    taskMergeTarget: "dev",
    taskWorktreeRoot: ".ai-office/worktrees",
  };

  const configPath = join(aiOfficeDir, "project.config.md");
  if (!existsSync(configPath)) {
    return defaults;
  }

  const frontmatter = parseFrontmatter(readText(configPath));
  return {
    agency: frontmatter.agency || defaults.agency,
    projectName: frontmatter.project_name || defaults.projectName,
    uiFramework: frontmatter.ui_framework || defaults.uiFramework,
    advanceMode: frontmatter.advance_mode || defaults.advanceMode,
    typecheckCmd: frontmatter.typecheck_cmd || defaults.typecheckCmd,
    lintCmd: frontmatter.lint_cmd || defaults.lintCmd,
    testCmd: frontmatter.test_cmd || defaults.testCmd,
    coverageMin: Number(frontmatter.coverage_min || defaults.coverageMin),
    lighthouseMin: Number(frontmatter.lighthouse_min || defaults.lighthouseMin),
    taskIsolationMode: frontmatter.task_isolation_mode || defaults.taskIsolationMode,
    taskBaseBranch: frontmatter.task_base_branch || defaults.taskBaseBranch,
    taskMergeTarget: frontmatter.task_merge_target || defaults.taskMergeTarget,
    taskWorktreeRoot: frontmatter.task_worktree_root || defaults.taskWorktreeRoot,
  };
}

function extractField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`^\\*\\*${escapeRegExp(field)}:\\*\\* (.*)$`, "m"));
  return match ? match[1].trim() : null;
}

function setField(content: string, field: string, value: string, afterField?: string): string {
  const line = `**${field}:** ${value}`;
  const pattern = new RegExp(`^\\*\\*${escapeRegExp(field)}:\\*\\* .*?$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }

  if (afterField) {
    const afterPattern = new RegExp(`(^\\*\\*${escapeRegExp(afterField)}:\\*\\* .*?$)`, "m");
    if (afterPattern.test(content)) {
      return content.replace(afterPattern, `$1\n${line}`);
    }
  }

  return `${content.trimEnd()}\n${line}\n`;
}

function extractHeading(content: string): string {
  const match = content.match(/^#\s+(.*)$/m);
  return match ? match[1].trim() : "Untitled";
}

function appendHistory(content: string, entry: string): string {
  if (!content.includes("## History")) {
    return `${content.trimEnd()}\n\n## History\n\n- ${entry}\n`;
  }
  if (content.includes("## Time Log")) {
    return content.replace("## Time Log", `- ${entry}\n\n## Time Log`);
  }
  if (content.includes("## Notes")) {
    return content.replace("## Notes", `- ${entry}\n\n## Notes`);
  }
  return `${content.trimEnd()}\n- ${entry}\n`;
}

function appendNote(content: string, note: string): string {
  if (!content.includes("## Notes")) {
    return `${content.trimEnd()}\n\n## Notes\n${note}\n`;
  }
  return content.replace("## Notes\n", `## Notes\n${note}\n`);
}

function deriveBranchName(taskId: string, titleSlug: string): string {
  const [milestone, rawTask] = taskId.split("_");
  return `task/${milestone}/${rawTask}-${titleSlug}`;
}

function parseKeywordFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (const arg of args) {
    const match = arg.match(/^([a-z-]+):(.*)$/i);
    if (!match) {
      fail(`❌ Expected keyword flag, received: ${arg}`);
    }
    flags.set(match[1].toLowerCase(), match[2]);
  }
  return flags;
}

function parseFlagArgs(args: string[]): { title: string; flags: Map<string, string> } {
  const titleParts: string[] = [];
  const flags = new Map<string, string>();
  let sawFlag = false;

  for (const arg of args) {
    const match = arg.match(/^([a-z-]+):(.*)$/i);
    if (match) {
      sawFlag = true;
      flags.set(match[1].toLowerCase(), match[2]);
      continue;
    }

    if (sawFlag) {
      fail(`❌ Unexpected argument after flags: ${arg}`);
    }
    titleParts.push(arg);
  }

  const title = titleParts.join(" ").trim();
  if (!title) {
    fail("❌ Task title is required.");
  }
  return { title, flags };
}

function deriveTaskDescription(title: string): string {
  return `Implement ${title.toLowerCase()}.\nRefine this description with scope, constraints, and dependencies before starting work.`;
}

function getTaskColumn(taskPath: string): Column {
  return basename(dirname(taskPath)) as Column;
}

function listTaskFiles(): string[] {
  const files: string[] = [];
  for (const column of COLUMNS) {
    const columnDir = join(tasksDir, column);
    if (!existsSync(columnDir)) {
      continue;
    }
    for (const entry of readdirSync(columnDir)) {
      if (entry.endsWith(".md")) {
        files.push(join(columnDir, entry));
      }
    }
  }
  return files;
}

function getTaskFilesForMilestone(id: string): string[] {
  return listTaskFiles().filter((taskPath) => {
    const content = readText(taskPath);
    return extractField(content, "Milestone") === id || basename(taskPath).startsWith(`${id}_`);
  });
}

function getTaskFilesForSlug(slug: string): string[] {
  const needle = slug.toLowerCase();
  return listTaskFiles().filter((taskPath) => {
    const content = readText(taskPath);
    const taskSlug = extractField(content, "Slug")?.toLowerCase();
    const name = basename(taskPath).toLowerCase();
    return taskSlug === needle || name.includes(needle) || content.toLowerCase().includes(needle);
  });
}

function updateTaskReadme(): void {
  const counts = new Map<Column, number>(COLUMNS.map((column) => [column, 0]));
  for (const filePath of listTaskFiles()) {
    const column = getTaskColumn(filePath);
    counts.set(column, (counts.get(column) ?? 0) + 1);
  }

  const content = `${COLUMNS.map((column) => `${column}: ${counts.get(column) ?? 0}`).join("\n")}\n\nUpdated: ${todayIso()}\n`;
  writeText(tasksReadmePath, content);
}

function validateMilestoneReference(ms: string): void {
  if (ms === "M0") {
    return;
  }

  const milestonePath = join(milestonesDir, `${ms}.md`);
  if (!existsSync(milestonePath)) {
    fail(`❌ Milestone ${ms} does not exist.\nCreate it first: ai-office milestone create ${ms} "<name>"\nOr use ms:M0 for unscheduled tasks.`);
  }

  const frontmatter = parseFrontmatter(readText(milestonePath));
  if ((frontmatter.status || "").toLowerCase() === "archived") {
    fail(`⚠️  Milestone ${ms} is archived. Choose an active milestone or ms:M0.`);
  }
}

function nextTaskNumber(ms: string): number {
  let max = 0;
  for (const filePath of listTaskFiles()) {
    const name = basename(filePath);
    const match = name.match(new RegExp(`^${escapeRegExp(ms)}_T(\\d{3})`));
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

function buildTaskFileContent(input: TaskCreateInput, taskId: string): string {
  return `# ${input.title}

**ID:** ${taskId}
**Milestone:** ${input.milestone}
**Slug:** ${input.slug}
**Branch:** —
**Worktree:** —
**Priority:** ${input.priority}
**Status:** ${input.column}
**Assignee:** ${input.assignee}
**Dependencies:** ${input.deps}
**Labels:** ${input.labels}
**Created:** ${todayIso()}
**Started:** —
**Completed:** —
**Estimate:** ${input.estimate}

## Description

${deriveTaskDescription(input.title)}

## Acceptance Criteria

- [ ]

## History

- ${todayIso()}: Created in ${input.column}

## Time Log

| Agent | Hours | Date | Notes |
|-------|-------|------|-------|

**Total Time:** 0h

## Notes
`;
}

function createTask(input: TaskCreateInput): { taskId: string; fileName: string; outputPath: string } {
  const taskNumber = String(nextTaskNumber(input.milestone)).padStart(3, "0");
  const taskId = `${input.milestone}_T${taskNumber}`;
  const titleSlug = kebabCase(input.title);
  const assigneeSlug = kebabCase(input.assignee, 60);
  const fileName = `${taskId}-${titleSlug}-${assigneeSlug}.md`;
  const outputPath = join(tasksDir, input.column, fileName);

  ensureDirectory(join(tasksDir, input.column));
  writeText(outputPath, buildTaskFileContent(input, taskId));
  updateTaskReadme();

  return { taskId, fileName, outputPath };
}

function findTaskFile(query: string): string {
  const needle = query.toLowerCase();
  const matches = listTaskFiles().filter((filePath) => {
    const name = basename(filePath).toLowerCase();
    if (name.startsWith(needle) || name.includes(needle)) {
      return true;
    }
    const content = readText(filePath);
    return extractField(content, "ID")?.toLowerCase() === needle;
  });

  if (matches.length === 0) {
    fail(`❌ No task found for: ${query}`);
  }
  if (matches.length > 1) {
    fail(`❌ Multiple tasks matched "${query}":\n${matches.map((match) => `- ${match}`).join("\n")}`);
  }
  return matches[0];
}

function findSectionContent(content: string, heading: string): string {
  const lines = content.split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (startIndex === -1) {
    return "";
  }

  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      break;
    }
    sectionLines.push(lines[index]);
  }
  return sectionLines.join("\n").trim();
}

function hasNonEmptySection(content: string, heading: string): boolean {
  return findSectionContent(content, heading).length > 0;
}

function sectionHasList(content: string, heading: string): boolean {
  return /(^[-*]\s+|^\d+\.\s+)/m.test(findSectionContent(content, heading));
}

function parseLabels(value: string | null): string[] {
  if (!value || value === "—") {
    return [];
  }
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function progressBar(done: number, total: number, size = 10): string {
  if (total === 0) {
    return "░".repeat(size);
  }
  const filled = Math.round((done / total) * size);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(size - filled, 0))}`;
}

function parseMilestoneFile(path: string): MilestoneInfo {
  const content = readText(path);
  const frontmatter = parseFrontmatter(content);
  return {
    id: frontmatter.id || basename(path, ".md"),
    name: frontmatter.name || extractHeading(content).replace(/^[^:]+:\s*/, ""),
    target: frontmatter.target || "—",
    status: frontmatter.status || "active",
    created: frontmatter.created || "—",
    path,
  };
}

function listMilestoneInfos(): MilestoneInfo[] {
  if (!existsSync(milestonesDir)) {
    return [];
  }
  return readdirSync(milestonesDir)
    .filter((entry) => entry.endsWith(".md") && entry !== "README.md")
    .map((entry) => parseMilestoneFile(join(milestonesDir, entry)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function updateMilestonesReadme(): void {
  ensureDirectory(milestonesDir);
  const milestones = listMilestoneInfos();
  const lines = [
    "# Milestones",
    "",
    "| ID | Name | Target | Status | Tasks |",
    "|----|------|--------|--------|-------|",
  ];

  for (const milestone of milestones) {
    const tasks = getTaskFilesForMilestone(milestone.id);
    const done = tasks.filter((taskPath) => getTaskColumn(taskPath) === "DONE").length;
    lines.push(`| ${milestone.id} | ${milestone.name} | ${milestone.target || "—"} | ${milestone.status} | ${tasks.length} (${done} done) |`);
  }

  if (milestones.length === 0) {
    lines.push("| — | — | — | — | 0 |");
  }

  lines.push("", `Updated: ${todayIso()}`, "");
  writeText(milestonesReadmePath, lines.join("\n"));
}

function buildMilestoneFile(id: string, name: string, target: string, suggestedTasks: Array<{ title: string }>): string {
  const today = todayIso();
  const definitionOfDone = suggestedTasks.length > 0
    ? suggestedTasks.map((task) => `- [ ] ${task.title}`).join("\n")
    : "- [ ] Define the scope for this milestone";

  return `---
id: ${id}
name: "${name}"
target: ${target || ""}
status: active
created: ${today}
---

# ${id}: ${name}

**Target:** ${target || "—"}
**Status:** active
**Created:** ${today}

## Goals

> Deliver ${name.toLowerCase()} with the expected quality gates and documentation.

## Definition of Done

${definitionOfDone}

## Notes
`;
}

function suggestMilestoneTasks(name: string, config: ProjectConfig): Array<{ title: string; assignee: string; priority: string; estimate: string; labels: string }> {
  const slugLabel = kebabCase(name, 30);
  const tasks = [
    { title: `Implement core ${name}`, assignee: "Developer", priority: "HIGH", estimate: "4h", labels: `feature,${slugLabel}` },
    { title: `Test ${name}`, assignee: "QA", priority: "MEDIUM", estimate: "2h", labels: `qa,${slugLabel}` },
    { title: `Document ${name} rollout`, assignee: "Ops", priority: "LOW", estimate: "1h", labels: `docs,${slugLabel}` },
  ];

  if (config.uiFramework && config.uiFramework !== "—") {
    tasks.splice(1, 0, {
      title: `Build ${name} UI`,
      assignee: "Developer",
      priority: "MEDIUM",
      estimate: "3h",
      labels: `ui,${slugLabel}`,
    });
  }

  return tasks;
}

function runCommand(command: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bash", "-lc", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function runProcess(command: string[], workdir = cwd): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(command, {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function runGit(args: string[], workdir = cwd): { exitCode: number; stdout: string; stderr: string } {
  return runProcess(["git", ...args], workdir);
}

function normalizeTaskIsolationMode(mode: string): "none" | "branch" | "worktree" {
  const normalized = mode.trim().toLowerCase();
  if (normalized === "branch" || normalized === "worktree") {
    return normalized;
  }
  return "none";
}

function getGitTopLevel(workdir = cwd): string {
  const result = runGit(["rev-parse", "--show-toplevel"], workdir);
  if (result.exitCode !== 0) {
    fail("❌ Git task isolation requires a git repository. Run `git init` first or set task_isolation_mode: none.");
  }
  return result.stdout.trim();
}

function getCurrentGitBranch(workdir = cwd): string {
  const result = runGit(["branch", "--show-current"], workdir);
  if (result.exitCode !== 0) {
    fail("❌ Unable to determine the current git branch.");
  }
  return result.stdout.trim();
}

function ensureGitBranchExists(branchName: string, label: string, workdir = cwd): void {
  const result = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], workdir);
  if (result.exitCode !== 0) {
    fail(`❌ ${label} branch \`${branchName}\` does not exist locally.`);
  }
}

function resolveWorktreePath(value: string): string {
  return isAbsolute(value) ? value : join(cwd, value);
}

function displayPath(path: string): string {
  const relativePath = relative(cwd, path);
  if (!relativePath || relativePath.startsWith("..")) {
    return path;
  }
  return relativePath;
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function getGitDir(workdir = cwd): string {
  const result = runGit(["rev-parse", "--git-dir"], workdir);
  if (result.exitCode !== 0) {
    fail("❌ Unable to resolve .git metadata for this repository.");
  }
  const gitDir = result.stdout.trim();
  return isAbsolute(gitDir) ? gitDir : join(workdir, gitDir);
}

function ensureGitExcludePattern(topLevel: string, pattern: string): void {
  const gitDir = getGitDir(topLevel);
  const excludePath = join(gitDir, "info", "exclude");
  const existing = existsSync(excludePath) ? readText(excludePath) : "";
  const lines = existing.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.includes(pattern)) {
    return;
  }
  const next = existing.trimEnd();
  writeText(excludePath, `${next ? `${next}\n` : ""}${pattern}\n`);
}

function listGitWorktrees(workdir = cwd): Array<{ path: string; branch: string | null }> {
  const result = runGit(["worktree", "list", "--porcelain"], workdir);
  if (result.exitCode !== 0) {
    fail("❌ Unable to inspect git worktrees.");
  }

  const entries: Array<{ path: string; branch: string | null }> = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      if (currentPath) {
        entries.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = null;
      currentBranch = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }

  if (currentPath) {
    entries.push({ path: currentPath, branch: currentBranch });
  }

  return entries;
}

function listGitStatusPaths(workdir = cwd): string[] {
  const result = runGit(["status", "--porcelain"], workdir);
  if (result.exitCode !== 0) {
    fail("❌ Unable to inspect git working tree status.");
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const pathText = line.slice(3);
      return pathText.includes(" -> ") ? pathText.split(" -> ").pop() ?? pathText : pathText;
    });
}

function ensureNoCodeChangesOutsideAiOffice(workdir = cwd): void {
  const dirtyPaths = listGitStatusPaths(workdir).filter((path) => !path.startsWith(".ai-office/"));
  if (dirtyPaths.length > 0) {
    fail(`❌ Integration requires a clean code workspace. Commit or stash these paths first:\n${dirtyPaths.map((path) => `- ${path}`).join("\n")}`);
  }
}

function taskHasAheadCommits(taskBranch: string, targetBranch: string, workdir = cwd): boolean {
  const result = runGit(["rev-list", "--count", `${targetBranch}..${taskBranch}`], workdir);
  if (result.exitCode !== 0) {
    fail(`❌ Unable to compare ${taskBranch} against ${targetBranch}.`);
  }
  return Number(result.stdout.trim() || "0") > 0;
}

function ensureTaskWorkspace(config: ProjectConfig, branchName: string, taskId: string, titleSlug: string, existingWorktree: string | null): string | null {
  const mode = normalizeTaskIsolationMode(config.taskIsolationMode);
  if (mode === "none") {
    return null;
  }

  const topLevel = getGitTopLevel();
  const baseBranch = config.taskBaseBranch.trim();
  if (!baseBranch) {
    fail("❌ task_base_branch must be configured when task isolation is enabled.");
  }

  const branchExists = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], topLevel).exitCode === 0;
  if (!branchExists) {
    ensureGitBranchExists(baseBranch, "Base", topLevel);
    const createBranch = runGit(["branch", branchName, baseBranch], topLevel);
    if (createBranch.exitCode !== 0) {
      fail(`❌ Unable to create task branch ${branchName} from ${baseBranch}.\n${(createBranch.stderr || createBranch.stdout).trim()}`);
    }
  }

  if (mode === "branch") {
    return null;
  }

  const configuredRoot = resolveWorktreePath(config.taskWorktreeRoot.trim() || ".ai-office/worktrees");
  const worktreePath = existingWorktree && existingWorktree !== "—"
    ? resolveWorktreePath(existingWorktree)
    : join(configuredRoot, `${taskId}-${titleSlug}`);

  if (isSubpath(topLevel, configuredRoot)) {
    const relativeRoot = displayPath(configuredRoot).replace(/\\/g, "/").replace(/\/+$/, "");
    ensureGitExcludePattern(topLevel, `${relativeRoot}/`);
  }

  const worktrees = listGitWorktrees(topLevel);
  const alreadyAttached = worktrees.find((entry) => entry.path === worktreePath);
  if (alreadyAttached) {
    if (alreadyAttached.branch && alreadyAttached.branch !== branchName) {
      fail(`❌ Worktree path ${displayPath(worktreePath)} is already attached to ${alreadyAttached.branch}.`);
    }
    return displayPath(worktreePath);
  }

  if (existsSync(worktreePath)) {
    fail(`❌ Worktree path already exists and is not registered: ${displayPath(worktreePath)}`);
  }

  ensureDirectory(dirname(worktreePath));
  const attach = runGit(["worktree", "add", worktreePath, branchName], topLevel);
  if (attach.exitCode !== 0) {
    fail(`❌ Unable to create worktree at ${displayPath(worktreePath)}.\n${(attach.stderr || attach.stdout).trim()}`);
  }

  return displayPath(worktreePath);
}

function buildSquashCommitMessage(taskId: string, title: string): string {
  const [milestone] = taskId.split("_");
  return `squash(${milestone}): ${title} (${taskId})`;
}

function walkFiles(root: string, options?: { excludeDirs?: Set<string>; includeExtensions?: Set<string> }): string[] {
  const excludeDirs = options?.excludeDirs ?? new Set<string>();
  const includeExtensions = options?.includeExtensions;
  const results: string[] = [];

  if (!existsSync(root)) {
    return results;
  }

  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || excludeDirs.has(entry.name)) {
        continue;
      }
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (includeExtensions && !includeExtensions.has(extname(entry.name))) {
        continue;
      }
      results.push(fullPath);
    }
  };

  visit(root);
  return results;
}

function findPatternMatches(pattern: RegExp, options?: { includeExtensions?: Set<string>; excludeDirs?: Set<string> }): Array<{ file: string; line: number; text: string }> {
  const matches: Array<{ file: string; line: number; text: string }> = [];
  const files = walkFiles(cwd, {
    includeExtensions: options?.includeExtensions,
    excludeDirs: options?.excludeDirs ?? ADAPTER_EXCLUDE_DIRS,
  });

  for (const file of files) {
    const content = readText(file);
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) {
        matches.push({ file, line: index + 1, text: lines[index].trim() });
      }
    }
    pattern.lastIndex = 0;
  }

  return matches;
}

function extractCoverage(output: string): number | null {
  const labeledMatch = output.match(/coverage[^0-9]*([0-9]+(?:\.[0-9]+)?)%/i);
  if (labeledMatch) {
    return Number(labeledMatch[1]);
  }
  const percentages = [...output.matchAll(/([0-9]+(?:\.[0-9]+)?)%/g)].map((match) => Number(match[1]));
  return percentages.length > 0 ? Math.max(...percentages) : null;
}

function addValidation(items: ValidationItem[], level: ValidationItem["level"], message: string, detail?: string): void {
  items.push({ level, message, detail });
}

function printValidation(slug: string, stage: ValidateStage, items: ValidationItem[]): void {
  console.log(`Validation: ${slug} @ ${stage}`);
  console.log("");

  for (const item of items) {
    const marker = item.level === "pass" ? "PASS" : item.level === "warn" ? "WARN" : "FAIL";
    const suffix = item.detail ? ` (${item.detail})` : "";
    console.log(`${marker} ${item.message}${suffix}`);
  }

  const failCount = items.filter((item) => item.level === "fail").length;
  const warnCount = items.filter((item) => item.level === "warn").length;
  const result = failCount > 0 ? "FAIL" : "PASS";
  const blocking = items.filter((item) => item.level === "fail").map((item) => item.message);

  console.log("");
  console.log(`Result: ${result} (${failCount} errors, ${warnCount} warnings)`);
  if (blocking.length > 0) {
    console.log(`Blocking issues: ${blocking.join("; ")}`);
  }
}

function commandTaskCreate(args: string[]): void {
  ensureAiOffice();
  const { title, flags } = parseFlagArgs(args);
  const milestone = flags.get("ms") ?? "M0";
  const priority = (flags.get("priority") ?? "MEDIUM").toUpperCase();
  const column = (flags.get("column") ?? "BACKLOG").toUpperCase() as Column;
  const assignee = flags.get("assignee") ?? "Unassigned";
  const deps = flags.get("deps") ?? "—";
  const estimate = flags.get("estimate") ?? "—";
  const labels = flags.get("labels") ?? "—";
  const slug = flags.get("slug") ?? "—";

  if (!COLUMNS.includes(column) || (column !== "BACKLOG" && column !== "TODO")) {
    fail("❌ task create only supports column:BACKLOG or column:TODO");
  }

  validateMilestoneReference(milestone);

  const { taskId, fileName } = createTask({
    title,
    milestone,
    priority,
    column,
    assignee,
    deps,
    estimate,
    labels,
    slug,
  });

  console.log(`Created ${taskId}: ${title} -> ${column} (${fileName})`);
}

function commandTaskMove(args: string[]): void {
  ensureAiOffice();
  const config = getProjectConfig();
  const [query, rawColumn, ...reasonParts] = args;
  if (!query || !rawColumn) {
    fail("❌ Usage: ai-office task move <task-id> <column> [reason]");
  }

  const targetColumn = rawColumn.toUpperCase() as Column;
  if (!COLUMNS.includes(targetColumn)) {
    fail(`❌ Invalid column: ${rawColumn}`);
  }

  const taskPath = findTaskFile(query);
  const currentColumn = getTaskColumn(taskPath);
  const reason = reasonParts.join(" ").trim();
  const today = todayIso();
  const originalName = basename(taskPath);
  let content = readText(taskPath);
  const messages: string[] = [];

  if (currentColumn === targetColumn) {
    fail(`⚠️  Task is already in ${targetColumn}`);
  }

  const taskId = extractField(content, "ID") ?? originalName.replace(/\.md$/, "");
  const titleSlug = originalName.replace(/\.md$/, "").replace(new RegExp(`^${escapeRegExp(taskId)}-`), "").replace(/-[^-]+$/, "");

  content = setField(content, "Status", targetColumn);

  if (targetColumn === "WIP") {
    if (extractField(content, "Started") === "—") {
      content = setField(content, "Started", today);
    }
    const branchName = extractField(content, "Branch") === "—"
      ? deriveBranchName(taskId, titleSlug)
      : extractField(content, "Branch") ?? deriveBranchName(taskId, titleSlug);
    content = setField(content, "Branch", branchName);

    const worktreeValue = ensureTaskWorkspace(config, branchName, taskId, titleSlug, extractField(content, "Worktree"));
    if (worktreeValue) {
      content = setField(content, "Worktree", worktreeValue, "Branch");
      messages.push(`Worktree: ${worktreeValue}`);
    }
    messages.push(`Branch: ${branchName}`);
  }

  if (targetColumn === "DONE" && extractField(content, "Completed") === "—") {
    content = setField(content, "Completed", today);
  }

  if (targetColumn === "ARCHIVED") {
    if (extractField(content, "Completed") === "—") {
      content = setField(content, "Completed", today);
    }
    if (!content.startsWith("# [ARCHIVED] ")) {
      content = content.replace(/^# /, "# [ARCHIVED] ");
    }
  }

  content = appendHistory(content, `${today}: ${currentColumn} → ${targetColumn}${reason ? ` — ${reason}` : ""}`);
  if (reason) {
    content = appendNote(content, `- ${today}: moved to ${targetColumn} — ${reason}`);
  } else if (targetColumn === "BLOCKED") {
    content = appendNote(content, `- ${today}: moved to BLOCKED — no reason given; add unblock criteria`);
  }

  const destination = join(tasksDir, targetColumn, originalName);
  ensureDirectory(join(tasksDir, targetColumn));
  writeText(taskPath, content);
  renameSync(taskPath, destination);
  updateTaskReadme();

  console.log(`Moved ${taskId}: ${currentColumn} -> ${targetColumn}`);
  for (const message of messages) {
    console.log(message);
  }
}

function commandTaskIntegrate(args: string[]): void {
  ensureAiOffice();
  const config = getProjectConfig();
  const [query, ...reasonParts] = args;
  if (!query) {
    fail("❌ Usage: ai-office task integrate <task-id> [reason]");
  }

  const mergeTarget = config.taskMergeTarget.trim();
  if (!mergeTarget) {
    fail("❌ task_merge_target must be configured before integrating a task.");
  }

  const taskPath = findTaskFile(query);
  const column = getTaskColumn(taskPath);
  if (column !== "REVIEW" && column !== "DONE") {
    fail(`❌ Task must be in REVIEW or DONE before integration. Current column: ${column}`);
  }

  let content = readText(taskPath);
  const taskId = extractField(content, "ID") ?? basename(taskPath, ".md");
  const branchName = extractField(content, "Branch");
  if (!branchName || branchName === "—") {
    fail(`❌ Task ${taskId} has no branch assigned. Move it to WIP first.`);
  }

  const title = extractHeading(content);
  const worktreeValue = extractField(content, "Worktree");
  const topLevel = getGitTopLevel();
  ensureGitBranchExists(mergeTarget, "Merge target", topLevel);
  ensureGitBranchExists(branchName, "Task", topLevel);

  const currentBranch = getCurrentGitBranch(topLevel);
  if (currentBranch !== mergeTarget) {
    fail(`❌ Current branch is \`${currentBranch}\`. Checkout \`${mergeTarget}\` in the main workspace before integrating ${taskId}.`);
  }

  ensureNoCodeChangesOutsideAiOffice(topLevel);

  if (worktreeValue && worktreeValue !== "—") {
    const worktreePath = resolveWorktreePath(worktreeValue);
    if (existsSync(worktreePath)) {
      const taskDirtyPaths = listGitStatusPaths(worktreePath).filter((path) => !path.startsWith(".ai-office/"));
      if (taskDirtyPaths.length > 0) {
        fail(`❌ Task worktree has uncommitted code changes at ${worktreeValue}.\n${taskDirtyPaths.map((path) => `- ${path}`).join("\n")}`);
      }
    }
  }

  if (!taskHasAheadCommits(branchName, mergeTarget, topLevel)) {
    fail(`❌ Task branch ${branchName} has no commits ahead of ${mergeTarget}.`);
  }

  const merge = runGit(["merge", "--squash", "--no-commit", branchName], topLevel);
  if (merge.exitCode !== 0) {
    runGit(["merge", "--abort"], topLevel);
    fail(`❌ Squash merge failed for ${branchName} -> ${mergeTarget}.\n${(merge.stderr || merge.stdout).trim()}`);
  }

  const today = todayIso();
  const reason = reasonParts.join(" ").trim();
  content = appendHistory(content, `${today}: integrated into ${mergeTarget} from ${branchName}${reason ? ` — ${reason}` : ""}`);
  content = appendNote(content, `- ${today}: integrated into ${mergeTarget}${reason ? ` — ${reason}` : ""}`);
  writeText(taskPath, content);

  const commitMessage = buildSquashCommitMessage(taskId, title);
  const addResult = runGit(["add", "-A"], topLevel);
  if (addResult.exitCode !== 0) {
    fail(`❌ Unable to stage the integration commit.\n${(addResult.stderr || addResult.stdout).trim()}`);
  }

  const commitResult = runGit(["commit", "-m", commitMessage], topLevel);
  if (commitResult.exitCode !== 0) {
    fail(`❌ Unable to create the squash commit.\n${(commitResult.stderr || commitResult.stdout).trim()}`);
  }

  console.log(`Integrated ${taskId} into ${mergeTarget}`);
  console.log(`Branch: ${branchName}`);
  if (worktreeValue && worktreeValue !== "—") {
    console.log(`Worktree: ${worktreeValue}`);
  }
  console.log(`Commit: ${commitMessage}`);
}

function commandTaskUpdate(args: string[]): void {
  ensureAiOffice();
  const [query, ...flagArgs] = args;
  if (!query || flagArgs.length === 0) {
    fail("❌ Usage: ai-office task update <task-id> [priority:HIGH] [assignee:name] [estimate:4h] [labels:tag1,tag2] [deps:id,...] [slug:feature-slug]");
  }

  const taskPath = findTaskFile(query);
  let content = readText(taskPath);
  const flags = parseKeywordFlags(flagArgs);
  const fieldMap: Array<{ flag: string; field: string; after?: string }> = [
    { flag: "priority", field: "Priority" },
    { flag: "assignee", field: "Assignee" },
    { flag: "estimate", field: "Estimate" },
    { flag: "labels", field: "Labels" },
    { flag: "deps", field: "Dependencies" },
    { flag: "slug", field: "Slug", after: "Milestone" },
  ];

  const changes: string[] = [];
  for (const item of fieldMap) {
    const nextValue = flags.get(item.flag);
    if (nextValue == null) {
      continue;
    }
    const previous = extractField(content, item.field) ?? "—";
    content = setField(content, item.field, nextValue, item.after);
    changes.push(`${item.field.toLowerCase()}: ${previous} → ${nextValue}`);
  }

  if (changes.length === 0) {
    fail("❌ No supported fields provided to update.");
  }

  content = appendHistory(content, `${todayIso()}: Updated — ${changes.join(", ")}`);
  writeText(taskPath, content);

  const taskId = extractField(content, "ID") ?? basename(taskPath, ".md");
  console.log(`Updated ${taskId}: ${changes.join("; ")}`);
}

function formatStatusTemplate(slug: string, state: StatusState, owner: string, notes: string): string {
  const today = todayIso();
  return `# ${slug} — Status

**State:** ${state}
**Owner:** ${owner}
**Updated:** ${today}

## Loop Guards

| Guard | Count | Max |
|-------|-------|-----|
| qa_iteration | 0 | 2 |
| review_iteration | 0 | 2 |
| uat_iteration | 0 | 1 |

## Notes
${notes || "—"}

## Review Log

| Date | Owner | State | Evidence |
|------|-------|-------|----------|
| ${today} | ${owner} | ${state} | Initial status set |
`;
}

function ensureLoopGuards(content: string): string {
  if (content.includes("## Loop Guards")) {
    return content;
  }

  const loopGuards = `## Loop Guards

| Guard | Count | Max |
|-------|-------|-----|
| qa_iteration | 0 | 2 |
| review_iteration | 0 | 2 |
| uat_iteration | 0 | 1 |

`;

  if (content.includes("## Notes")) {
    return content.replace("## Notes\n", `${loopGuards}## Notes\n`);
  }

  return `${content.trimEnd()}\n\n${loopGuards}`;
}

function commandStatusGet(slug: string): void {
  ensureAiOffice();
  const statusPath = join(runbooksDir, `${slug}-status.md`);
  if (!existsSync(statusPath)) {
    fail(`❌ No status file found for ${slug}.`);
  }

  const content = readText(statusPath);
  const state = extractField(content, "State") ?? "unknown";
  const owner = extractField(content, "Owner") ?? "unknown";
  const updated = extractField(content, "Updated") ?? "unknown";

  console.log(slug);
  console.log(`State: ${state}`);
  console.log(`Owner: ${owner}`);
  console.log(`Updated: ${updated}`);
}

function commandStatusSet(slug: string, rawState: string, owner = "Unassigned", notes = ""): void {
  ensureAiOffice();
  const state = rawState as StatusState;
  if (!VALID_STATES.includes(state)) {
    fail(`❌ Invalid state: ${rawState}`);
  }

  ensureDirectory(runbooksDir);
  const statusPath = join(runbooksDir, `${slug}-status.md`);
  const today = todayIso();

  if (!existsSync(statusPath)) {
    writeText(statusPath, formatStatusTemplate(slug, state, owner, notes));
    console.log(`Status updated: ${slug} -> ${state}`);
    return;
  }

  let content = ensureLoopGuards(readText(statusPath));
  content = setField(content, "State", state);
  content = setField(content, "Owner", owner);
  content = setField(content, "Updated", today);

  const evidence = notes || "Updated via ai-office status set";
  const reviewRow = `| ${today} | ${owner} | ${state} | ${evidence} |`;
  content = content.replace(/(\|------\|-------\|-------\|----------\|\n)/, `$1${reviewRow}\n`);
  if (notes) {
    content = content.replace(/## Notes\n/, `## Notes\n${notes}\n`);
  }

  writeText(statusPath, content);
  console.log(`Status updated: ${slug} -> ${state}`);
}

function commandMilestoneCreate(args: string[]): void {
  ensureAiOffice();
  const [id, ...rest] = args;
  if (!id || rest.length === 0) {
    fail("❌ Usage: ai-office milestone create <id> <name> [target:YYYY-MM-DD] [tasks:yes|no|ask]");
  }
  if (id === "M0") {
    fail("❌ M0 is reserved for unscheduled tasks.");
  }

  const { title: name, flags } = parseFlagArgs(rest);
  const target = flags.get("target") ?? "";
  const tasksMode = (flags.get("tasks") ?? "ask").toLowerCase();
  const milestonePath = join(milestonesDir, `${id}.md`);
  if (existsSync(milestonePath)) {
    fail(`⚠️  Milestone ${id} already exists.`);
  }

  const config = getProjectConfig();
  const suggestions = suggestMilestoneTasks(name, config);
  ensureDirectory(milestonesDir);
  writeText(milestonePath, buildMilestoneFile(id, name, target, suggestions));

  let created = 0;
  if (tasksMode === "yes") {
    const slug = kebabCase(name);
    for (const suggestion of suggestions) {
      createTask({
        title: suggestion.title,
        milestone: id,
        priority: suggestion.priority,
        column: "BACKLOG",
        assignee: suggestion.assignee,
        deps: "—",
        estimate: suggestion.estimate,
        labels: suggestion.labels,
        slug,
      });
      created += 1;
    }
  }

  updateMilestonesReadme();

  console.log(`Milestone ${id}: ${name}`);
  console.log(`Target: ${target || "—"} · Status: active`);
  console.log("");
  console.log("Suggested tasks:");
  for (const suggestion of suggestions) {
    console.log(`- ${suggestion.title} [${suggestion.assignee}, ${suggestion.priority}, ${suggestion.estimate}]`);
  }
  console.log("");
  console.log(`✅ Milestone ${id} created: ${name}`);
  console.log(`Tasks created: ${created === 0 ? "skipped" : created}`);
}

function commandMilestoneStatus(id: string): void {
  ensureAiOffice();
  const milestonePath = join(milestonesDir, `${id}.md`);
  if (!existsSync(milestonePath)) {
    fail(`❌ Milestone ${id} does not exist.`);
  }

  const milestone = parseMilestoneFile(milestonePath);
  const tasks = getTaskFilesForMilestone(id);
  const doneCount = tasks.filter((taskPath) => getTaskColumn(taskPath) === "DONE").length;
  const grouped = new Map<Column, string[]>(COLUMNS.map((column) => [column, []]));
  const labels = new Set<string>();
  const priorities = new Map<string, { total: number; done: number }>();

  for (const taskPath of tasks) {
    const content = readText(taskPath);
    const column = getTaskColumn(taskPath);
    const title = extractHeading(content);
    const taskId = extractField(content, "ID") ?? basename(taskPath, ".md");
    grouped.get(column)?.push(`${taskId} — ${title}`);

    const priority = (extractField(content, "Priority") ?? "MEDIUM").toUpperCase();
    const entry = priorities.get(priority) ?? { total: 0, done: 0 };
    entry.total += 1;
    if (column === "DONE") {
      entry.done += 1;
    }
    priorities.set(priority, entry);

    for (const label of parseLabels(extractField(content, "Labels"))) {
      labels.add(label);
    }
  }

  const overdue = milestone.target && milestone.target !== "—" && milestone.target < todayIso() && doneCount < tasks.length;

  console.log(`Milestone ${milestone.id}: ${milestone.name}`);
  console.log(`Target: ${milestone.target || "—"} · Status: ${milestone.status}`);
  console.log("");
  console.log(`Progress: ${progressBar(doneCount, tasks.length)} ${doneCount}/${tasks.length} tasks done (${tasks.length === 0 ? 0 : Math.round((doneCount / tasks.length) * 100)}%)`);
  console.log("");
  console.log("By priority:");
  for (const priority of ["HIGH", "MEDIUM", "LOW"]) {
    const entry = priorities.get(priority) ?? { total: 0, done: 0 };
    console.log(`  ${priority.padEnd(6, " ")} ${entry.done}/${entry.total} done  ${progressBar(entry.done, entry.total, 4)}`);
  }
  console.log("");
  console.log(`Labels in use: ${labels.size > 0 ? [...labels].sort().join(", ") : "none"}`);
  console.log(`Overdue: ${overdue ? "yes" : "—"}`);

  for (const column of COLUMNS) {
    const entries = grouped.get(column) ?? [];
    if (entries.length === 0) {
      continue;
    }
    console.log("");
    console.log(`${column} (${entries.length})`);
    for (const entry of entries) {
      console.log(`  - ${entry}`);
    }
  }
}

function commandMilestoneList(): void {
  ensureAiOffice();
  const milestones = listMilestoneInfos();
  if (milestones.length === 0) {
    console.log('No milestones defined. Run `ai-office milestone create M1 "My first milestone"` to get started.');
    return;
  }

  console.log("Milestones");
  console.log("");
  console.log("| ID | Name | Target | Status | Tasks |");
  console.log("|----|------|--------|--------|-------|");
  let active = 0;
  let complete = 0;

  for (const milestone of milestones) {
    const tasks = getTaskFilesForMilestone(milestone.id);
    const done = tasks.filter((taskPath) => getTaskColumn(taskPath) === "DONE").length;
    if (milestone.status === "active") {
      active += 1;
    }
    if (milestone.status === "complete") {
      complete += 1;
    }
    console.log(`| ${milestone.id} | ${milestone.name} | ${milestone.target || "—"} | ${milestone.status} | ${tasks.length} (${done} done) |`);
  }

  console.log("");
  console.log(`Active: ${active} · Complete: ${complete}`);
}

function validatePrd(slug: string, items: ValidationItem[]): void {
  const path = join(prdDir, `${slug}.md`);
  if (!existsSync(path)) {
    addValidation(items, "fail", `PRD missing at ${path}`);
    return;
  }
  const content = readText(path);
  addValidation(items, hasNonEmptySection(content, "Problem Statement") ? "pass" : "fail", "Problem statement defined");
  addValidation(items, sectionHasList(content, "Goals") ? "pass" : "fail", "Goals listed");
  addValidation(items, sectionHasList(content, "Acceptance Criteria") ? "pass" : "fail", "Acceptance criteria listed");
  addValidation(items, hasNonEmptySection(content, "Non-Goals") || hasNonEmptySection(content, "Non Goals") ? "pass" : "fail", "Non-goals section present");
  addValidation(items, content.includes("?") ? "warn" : "pass", "No unresolved open questions marked with ?");
}

function validateAdr(slug: string, items: ValidationItem[]): void {
  const path = join(adrDir, `${slug}.md`);
  if (!existsSync(path)) {
    addValidation(items, "fail", `ADR missing at ${path}`);
    return;
  }
  const content = readText(path);
  addValidation(items, hasNonEmptySection(content, "Context") ? "pass" : "fail", "Context section is non-empty");
  addValidation(items, hasNonEmptySection(content, "Decision") ? "pass" : "fail", "Decision section states a clear choice");
  const optionRows = [...findSectionContent(content, "Options Considered").matchAll(/^\|.*\|$/gm)].length;
  addValidation(items, optionRows >= 3 ? "pass" : "fail", "At least 2 options considered in the table");
  const consequences = findSectionContent(content, "Consequences");
  addValidation(items, /positive|negative|trade-off|risk/i.test(consequences) ? "pass" : "fail", "Consequences documented");
}

function validatePlan(slug: string, items: ValidationItem[]): void {
  const path = join(runbooksDir, `${slug}-plan.md`);
  if (!existsSync(path)) {
    addValidation(items, "fail", `Plan missing at ${path}`);
    return;
  }
  const content = readText(path);
  addValidation(items, /milestone/i.test(findSectionContent(content, "Milestones") || content) ? "pass" : "fail", "At least one milestone defined");
  addValidation(items, hasNonEmptySection(content, "Dependencies") ? "pass" : "fail", "Dependencies section present");
  addValidation(items, hasNonEmptySection(content, "Risks") ? "pass" : "fail", "Risks section present and non-empty");
}

function validateTasks(slug: string, items: ValidationItem[]): void {
  const matchingTasks = getTaskFilesForSlug(slug);
  addValidation(items, matchingTasks.length > 0 ? "pass" : "fail", "At least one task file exists for this slug or feature");

  const staleTasks = listTaskFiles().filter((taskPath) => {
    if (getTaskColumn(taskPath) !== "WIP") {
      return false;
    }
    const ageDays = (Date.now() - statSync(taskPath).mtimeMs) / (1000 * 60 * 60 * 24);
    return ageDays > 14;
  });
  addValidation(items, staleTasks.length === 0 ? "pass" : "warn", "No tasks stuck in WIP for more than 14 days", staleTasks[0] ? basename(staleTasks[0]) : undefined);

  updateTaskReadme();
  const expected = readText(tasksReadmePath).trim();
  const currentCounts = `${COLUMNS.map((column) => `${column}: ${listTaskFiles().filter((taskPath) => getTaskColumn(taskPath) === column).length}`).join("\n")}\n\nUpdated: ${todayIso()}`;
  addValidation(items, expected === currentCounts ? "pass" : "fail", "README.md counts are consistent with actual file counts");
}

function validateDev(config: ProjectConfig, items: ValidationItem[]): void {
  const commands: Array<{ label: string; command: string }> = [
    { label: "Run typecheck", command: config.typecheckCmd },
    { label: "Run lint", command: config.lintCmd },
    { label: "Run tests", command: config.testCmd },
  ];

  for (const item of commands) {
    const result = runCommand(item.command);
    addValidation(items, result.exitCode === 0 ? "pass" : "fail", `${item.label} — ${item.command}`, result.exitCode === 0 ? undefined : (result.stderr || result.stdout).split("\n")[0]);
  }

  const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb", ".php", ".sh"]);
  const todoMatches = findPatternMatches(/\b(TODO|FIXME)\b/, { includeExtensions: codeExtensions });
  addValidation(items, todoMatches.length === 0 ? "pass" : "warn", "No TODOs or FIXMEs introduced in code", todoMatches[0] ? `${basename(todoMatches[0].file)}:${todoMatches[0].line}` : undefined);

  const secretMatches = findPatternMatches(/\b(password|apiKey|secret|token)\b\s*[:=]\s*["'`][^"'`]+["'`]/i, { includeExtensions: codeExtensions });
  addValidation(items, secretMatches.length === 0 ? "pass" : "fail", "No hardcoded secrets detected", secretMatches[0] ? `${basename(secretMatches[0].file)}:${secretMatches[0].line}` : undefined);
}

function validateSecurity(items: ValidationItem[]): void {
  const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".sql"]);
  const dangerousEval = findPatternMatches(/\b(eval|Function)\s*\(/, { includeExtensions: codeExtensions });
  addValidation(items, dangerousEval.length === 0 ? "pass" : "fail", "No eval or dynamic Function usage", dangerousEval[0] ? basename(dangerousEval[0].file) : undefined);

  const xssMatches = findPatternMatches(/dangerouslySetInnerHTML|innerHTML\s*=/, { includeExtensions: new Set([".ts", ".tsx", ".js", ".jsx", ".html"]) });
  addValidation(items, xssMatches.length === 0 ? "pass" : "warn", "No obvious XSS sinks found", xssMatches[0] ? basename(xssMatches[0].file) : undefined);

  const authMentions = findPatternMatches(/\b(auth|authorize|permission|role|session)\b/i, { includeExtensions: codeExtensions });
  addValidation(items, authMentions.length > 0 ? "pass" : "warn", "Auth/authz checks appear present on protected code paths");

  const logSensitive = findPatternMatches(/console\.(log|error|warn).*(password|token|secret)/i, { includeExtensions: new Set([".ts", ".tsx", ".js", ".jsx"]) });
  addValidation(items, logSensitive.length === 0 ? "pass" : "fail", "No sensitive data in logs", logSensitive[0] ? basename(logSensitive[0].file) : undefined);
}

function validateQa(slug: string, config: ProjectConfig, items: ValidationItem[]): void {
  const prdPath = join(prdDir, `${slug}.md`);
  if (existsSync(prdPath)) {
    addValidation(items, sectionHasList(readText(prdPath), "Acceptance Criteria") ? "pass" : "fail", "Acceptance criteria present in PRD");
  } else {
    addValidation(items, "warn", "PRD missing for QA validation");
  }

  const result = runCommand(config.testCmd);
  addValidation(items, result.exitCode === 0 ? "pass" : "fail", `Test suite passes — ${config.testCmd}`);
  const coverage = extractCoverage(`${result.stdout}\n${result.stderr}`);
  if (coverage == null) {
    addValidation(items, "warn", `Coverage output not detected for threshold ${config.coverageMin}%`);
  } else {
    addValidation(items, coverage >= config.coverageMin ? "pass" : "fail", `Coverage ≥ ${config.coverageMin}%`, `${coverage}%`);
  }

  addValidation(items, "warn", "Edge cases tested: empty, null, and boundary inputs require manual confirmation");
  addValidation(items, "warn", "No regressions in existing features require reviewer confirmation");

  if (config.uiFramework) {
    addValidation(items, "warn", `Lighthouse ≥ ${config.lighthouseMin} requires a UI report or manual verification`);
  } else {
    addValidation(items, "pass", "Lighthouse check not required because no UI framework is configured");
  }
}

function validateReview(slug: string, items: ValidationItem[]): void {
  const reviewPath = join(runbooksDir, `${slug}-review.md`);
  if (!existsSync(reviewPath)) {
    addValidation(items, "fail", `Review artifact missing at ${reviewPath}`);
    return;
  }
  const content = readText(reviewPath);
  addValidation(items, hasNonEmptySection(content, "Technical Review") ? "pass" : "fail", "Technical review section completed");
  addValidation(items, hasNonEmptySection(content, "Security Review") ? "pass" : "fail", "Security review section completed");
  addValidation(items, hasNonEmptySection(content, "Business Review") ? "pass" : "fail", "Business review section completed");
  addValidation(items, /Approve|Request changes|Escalate/i.test(findSectionContent(content, "Decision") || content) ? "pass" : "fail", "Reviewer sign-off present");
}

function validateUserAcceptance(slug: string, items: ValidationItem[]): void {
  const statusPath = join(runbooksDir, `${slug}-status.md`);
  if (!existsSync(statusPath)) {
    addValidation(items, "warn", "Status file missing for UAT validation");
    return;
  }
  const content = readText(statusPath);
  addValidation(items, /uat|sign-off|acceptance/i.test(content) ? "pass" : "warn", "UAT sign-off documented");
  addValidation(items, !/blocking/i.test(content) ? "pass" : "warn", "No blocking issues open");
}

function validateRelease(items: ValidationItem[]): void {
  addValidation(items, existsSync(join(cwd, "CHANGELOG.md")) ? "pass" : "fail", "CHANGELOG updated");
  addValidation(items, existsSync(join(cwd, "VERSION")) || existsSync(join(cwd, "package.json")) ? "pass" : "warn", "Versioned release metadata present");

  const runbooks = existsSync(runbooksDir) ? readdirSync(runbooksDir).filter((entry) => entry.endsWith(".md")) : [];
  const rollbackMentioned = runbooks.some((entry) => /rollback/i.test(readText(join(runbooksDir, entry))));
  addValidation(items, rollbackMentioned ? "pass" : "warn", "Rollback plan documented");
  addValidation(items, "warn", "Deployment verified in staging requires manual confirmation");
}

function commandValidate(slug: string, rawStage: string): void {
  ensureAiOffice();
  const stage = rawStage as ValidateStage;
  if (!VALID_VALIDATE_STAGES.includes(stage)) {
    fail(`❌ Invalid validate stage: ${rawStage}`);
  }

  const items: ValidationItem[] = [];
  const config = getProjectConfig();

  if (!existsSync(join(aiOfficeDir, "project.config.md"))) {
    addValidation(items, "warn", "No project.config.md found — using defaults. Run ai-office setup to configure.");
  }

  switch (stage) {
    case "prd":
      validatePrd(slug, items);
      break;
    case "adr":
      validateAdr(slug, items);
      break;
    case "plan":
      validatePlan(slug, items);
      break;
    case "tasks":
      validateTasks(slug, items);
      break;
    case "dev":
      validateDev(config, items);
      break;
    case "security":
      validateSecurity(items);
      break;
    case "qa":
      validateQa(slug, config, items);
      break;
    case "review":
      validateReview(slug, items);
      break;
    case "user_acceptance":
      validateUserAcceptance(slug, items);
      break;
    case "release":
      validateRelease(items);
      break;
    default:
      fail(`❌ Unsupported validate stage: ${stage}`);
  }

  printValidation(slug, stage, items);
  process.exit(items.some((item) => item.level === "fail") ? 1 : 0);
}

function commandDoctor(): void {
  const adapter = detectAdapter();
  const checks: Array<{ ok: boolean; message: string }> = [
    { ok: existsSync(join(cwd, "AI-OFFICE.md")), message: "AI-OFFICE.md present" },
    { ok: existsSync(aiOfficeDir), message: ".ai-office present" },
    { ok: existsSync(installMetaPath), message: ".ai-office/install.json present" },
    { ok: existsSync(tasksReadmePath), message: ".ai-office/tasks/README.md present" },
    { ok: existsSync(join(aiOfficeDir, "office-config.md")), message: ".ai-office/office-config.md present" },
  ];

  if (adapter !== "base") {
    const profile = getAdapterProfile(adapter);
    const adapterChecks: Array<{ ok: boolean; message: string }> = [];
    if (profile.instructionFileName) {
      adapterChecks.push({ ok: adapterInstructionExists(adapter), message: `${profile.instructionFileName} present` });
    }
    if (profile.installedSkillRoot) {
      adapterChecks.push({ ok: projectPathExists(profile.installedSkillRoot), message: `${profile.installedSkillRoot} present` });
    }
    if (profile.installedRulesRoot) {
      adapterChecks.push({ ok: projectPathExists(profile.installedRulesRoot), message: `${profile.installedRulesRoot} present` });
    }
    if (profile.installedWorkflowRoot) {
      adapterChecks.push({ ok: projectPathExists(profile.installedWorkflowRoot), message: `${profile.installedWorkflowRoot} present` });
    }
    checks.unshift(...adapterChecks);
  }

  let failed = 0;
  console.log(`Adapter: ${adapter}`);
  for (const check of checks) {
    if (check.ok) {
      console.log(`PASS ${check.message}`);
    } else {
      console.log(`WARN ${check.message}`);
      failed += 1;
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

function main(): void {
  const [, , command, subcommand, ...rest] = process.argv;

  if (!command) {
    fail("❌ Usage: ai-office <doctor|task|status|milestone|validate> ...");
  }

  if (command === "doctor") {
    commandDoctor();
    return;
  }

  if (command === "task" && subcommand === "create") {
    commandTaskCreate(rest);
    return;
  }

  if (command === "task" && subcommand === "move") {
    commandTaskMove(rest);
    return;
  }

  if (command === "task" && subcommand === "integrate") {
    commandTaskIntegrate(rest);
    return;
  }

  if (command === "task" && subcommand === "update") {
    commandTaskUpdate(rest);
    return;
  }

  if (command === "status" && subcommand === "get") {
    const [slug] = rest;
    if (!slug) {
      fail("❌ Usage: ai-office status get <slug>");
    }
    commandStatusGet(slug);
    return;
  }

  if (command === "status" && subcommand === "set") {
    const [slug, state, owner, ...noteParts] = rest;
    if (!slug || !state) {
      fail("❌ Usage: ai-office status set <slug> <state> [owner] [notes]");
    }
    commandStatusSet(slug, state, owner, noteParts.join(" "));
    return;
  }

  if (command === "milestone" && subcommand === "create") {
    commandMilestoneCreate(rest);
    return;
  }

  if (command === "milestone" && subcommand === "status") {
    const [id] = rest;
    if (!id) {
      fail("❌ Usage: ai-office milestone status <id>");
    }
    commandMilestoneStatus(id);
    return;
  }

  if (command === "milestone" && subcommand === "list") {
    commandMilestoneList();
    return;
  }

  if (command === "validate") {
    const [slug, stage] = [subcommand, ...rest];
    if (!slug || !stage) {
      fail("❌ Usage: ai-office validate <slug> <stage>");
    }
    commandValidate(slug, stage);
    return;
  }

  fail(`❌ Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

main();

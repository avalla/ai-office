import { existsSync, readFileSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseOfficeManifestJson } from "@ai-office/application/office/office-manifest-schema.ts";
import { compileProjectSkill } from "@ai-office/application/agent-client/project-skill-compiler.ts";
import { compileProjectHandoverSection } from "@ai-office/application/agent-client/project-handover-workflow.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSkillRoot = resolve(
  repositoryRoot,
  ".agents",
  "skills",
  "ai-office",
);

const requiredPaths = [
  "agents/openai.yaml",
  "assets/default-office-manifest.json",
  "references/manifest-contract.md",
  "references/project-handover.md",
  "references/task-operation.md",
] as const;

const requiredSkillSnippets = [
  "## Help",
  "## Install or inspect",
  "## Hand the project over",
  "## Onboard",
  "## Revise the office",
  "## Operate a task",
  "## Integrate a coding client",
  "## Reusable memory",
  "## Uninstall safely",
  "ai-office install",
  "ai-office status",
  "ai-office next",
  "ai-office --help",
] as const;

const removedOnboardingSnippets = [
  "project:onboard",
  "AI_OFFICE_LLM_MODEL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

const requiredProjectedSkillSnippets = [
  "## Help",
  "## Install or inspect",
  "## Hand the project over",
  "## Onboard",
  "## Operate",
  "## Uninstall safely",
  "ai-office --help",
  "ai-office install",
  "ai-office status",
  "ai-office next",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function parseFrontmatter(
  source: string,
  errors: string[],
): Record<string, unknown> | null {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") {
    errors.push("SKILL.md must start with YAML frontmatter");
    return null;
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) {
    errors.push("SKILL.md frontmatter is not closed");
    return null;
  }

  try {
    const parsed = Bun.YAML.parse(lines.slice(1, closingIndex).join("\n"));
    if (!isRecord(parsed)) {
      errors.push("SKILL.md frontmatter must be a YAML object");
      return null;
    }
    return parsed;
  } catch (error) {
    errors.push(
      `SKILL.md frontmatter is invalid YAML: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  }
}

export function validateAiOfficeSkill(skillRoot = defaultSkillRoot): string[] {
  const errors: string[] = [];
  const skillPath = resolve(skillRoot, "SKILL.md");
  if (!existsSync(skillPath) || !statSync(skillPath).isFile())
    return ["SKILL.md is missing"];

  const source = readFileSync(skillPath, "utf8");
  const frontmatter = parseFrontmatter(source, errors);
  if (frontmatter !== null) {
    const name = frontmatter.name;
    const description = frontmatter.description;
    if (typeof name !== "string" || name.trim() === "")
      errors.push("SKILL.md frontmatter requires a non-empty name");
    else {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        errors.push("SKILL.md name must use lowercase kebab-case");
      if (name !== basename(skillRoot))
        errors.push("SKILL.md name must match its directory name");
    }
    if (typeof description !== "string" || description.trim() === "")
      errors.push("SKILL.md frontmatter requires a non-empty description");
    else if (description.length > 1024)
      errors.push("SKILL.md description must not exceed 1024 characters");
  }

  for (const snippet of requiredSkillSnippets) {
    if (!source.includes(snippet))
      errors.push(`SKILL.md is missing required workflow content: ${snippet}`);
  }
  for (const snippet of removedOnboardingSnippets) {
    if (source.includes(snippet))
      errors.push(
        `SKILL.md references removed provider onboarding: ${snippet}`,
      );
  }
  // The handover workflow has one canonical definition in the application
  // layer. Both skill surfaces must carry it verbatim so no client drifts.
  if (!source.includes(compileProjectHandoverSection()))
    errors.push(
      "SKILL.md does not embed the canonical project handover workflow verbatim",
    );

  for (const requiredPath of requiredPaths) {
    const absolutePath = resolve(skillRoot, requiredPath);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile())
      errors.push(`Required skill file is missing: ${requiredPath}`);
  }

  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of source.matchAll(linkPattern)) {
    const target = match[1]?.trim();
    if (
      target === undefined ||
      target === "" ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    )
      continue;
    const withoutFragment = target.split("#", 1)[0]!;
    const linkedPath = resolve(skillRoot, withoutFragment);
    if (!isInside(skillRoot, linkedPath))
      errors.push(`Skill link escapes its directory: ${target}`);
    else if (!existsSync(linkedPath))
      errors.push(`Skill link target is missing: ${target}`);
  }

  const openAiPath = resolve(skillRoot, "agents", "openai.yaml");
  if (existsSync(openAiPath)) {
    try {
      const metadata = Bun.YAML.parse(readFileSync(openAiPath, "utf8"));
      if (!isRecord(metadata) || !isRecord(metadata.interface))
        errors.push("agents/openai.yaml must define an interface object");
    } catch (error) {
      errors.push(
        `agents/openai.yaml is invalid YAML: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  const manifestPath = resolve(
    skillRoot,
    "assets",
    "default-office-manifest.json",
  );
  if (existsSync(manifestPath)) {
    try {
      parseOfficeManifestJson(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      errors.push(
        `Default office manifest is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  return errors;
}

export function validateProjectedAiOfficeSkill(source: string): string[] {
  const errors: string[] = [];
  const frontmatter = parseFrontmatter(source, errors);
  if (frontmatter !== null) {
    if (frontmatter.name !== "ai-office")
      errors.push("Projected SKILL.md name must be ai-office");
    if (
      typeof frontmatter.description !== "string" ||
      frontmatter.description.trim() === "" ||
      frontmatter.description.length > 1024
    )
      errors.push(
        "Projected SKILL.md requires a non-empty description of at most 1024 characters",
      );
  }
  for (const snippet of requiredProjectedSkillSnippets) {
    if (!source.includes(snippet))
      errors.push(`Projected SKILL.md is missing workflow content: ${snippet}`);
  }
  for (const snippet of removedOnboardingSnippets) {
    if (source.includes(snippet))
      errors.push(
        `Projected SKILL.md references removed provider onboarding: ${snippet}`,
      );
  }
  if (!source.includes(compileProjectHandoverSection()))
    errors.push(
      "Projected SKILL.md does not embed the canonical project handover workflow verbatim",
    );
  return errors;
}

if (import.meta.main) {
  const errors = [
    ...validateAiOfficeSkill(),
    ...validateProjectedAiOfficeSkill(compileProjectSkill()),
  ];
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log("AI Office source and projected skill contracts are valid");
  }
}

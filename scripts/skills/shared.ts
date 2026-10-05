import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Directory, relative to a repository root, holding the canonical skills. */
export const canonicalSkillsDirectory = "skills";

/** Ownership record the installer writes beside every installed copy. */
export const installManifestName = ".skill-install.json";

export interface InstallTarget {
  readonly id: string;
  /** POSIX path, relative to the installation root, that hosts discover. */
  readonly directory: string;
  readonly executors: string;
}

/**
 * Where an installed copy must live for each executor family. Adding an
 * executor that reads another location is one entry here.
 */
export const installTargets: readonly InstallTarget[] = [
  { id: "claude", directory: ".claude/skills", executors: "Claude Code" },
  {
    id: "agents",
    directory: ".agents/skills",
    executors: "Codex, Pi, and other Agent Skills hosts",
  },
];

/** Files operating systems drop into directories; never part of a skill. */
const ignoredFileNames = [".DS_Store", "Thumbs.db"];

export class SkillPackageError extends Error {
  override readonly name = "SkillPackageError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Content identity that is stable across LF and CRLF checkouts of text, so a
 * `core.autocrlf` clone does not report every installed copy as drifted.
 * Anything that is not plain UTF-8 text is hashed byte for byte: in a binary
 * asset the bytes 0D 0A are data, not a line ending.
 */
export function contentHash(content: Uint8Array): string {
  const bytes = Buffer.from(content);
  const text = bytes.toString("utf8");
  const isText =
    !text.includes("\0") && Buffer.from(text, "utf8").equals(bytes);
  return createHash("sha256")
    .update(isText ? Buffer.from(text.replace(/\r\n/gu, "\n"), "utf8") : bytes)
    .digest("hex");
}

/**
 * Lists regular files beneath `root` as sorted POSIX relative paths. Symbolic
 * links and special files are rejected instead of followed: a skill tree is
 * plain files, and following a link could read or write outside it.
 */
export function listFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    const absoluteDirectory = join(root, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory).sort()) {
      if (ignoredFileNames.includes(entry)) continue;
      const relativePath =
        relativeDirectory === "" ? entry : `${relativeDirectory}/${entry}`;
      const stats = lstatSync(join(root, relativePath));
      if (stats.isDirectory()) visit(relativePath);
      else if (stats.isFile()) files.push(relativePath);
      else
        throw new SkillPackageError(
          `${relativePath} is a symbolic link or special file; only regular files are supported`,
        );
    }
  };
  visit("");
  return files.sort();
}

/** Names of the canonical skills (directories) under a source root. */
export function listCanonicalSkills(sourceRoot: string): string[] {
  const skillsRoot = join(sourceRoot, canonicalSkillsDirectory);
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    throw new SkillPackageError(
      `Canonical skills directory is missing: ${skillsRoot}`,
    );
  }
  return entries
    .filter((entry) => lstatSync(join(skillsRoot, entry)).isDirectory())
    .sort();
}

export interface SkillFrontmatter {
  readonly data: Record<string, unknown>;
  /** The Markdown after the closing frontmatter fence. */
  readonly body: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses `SKILL.md` frontmatter; throws SkillPackageError when malformed. */
export function parseSkillFrontmatter(rawSource: string): SkillFrontmatter {
  const lines = rawSource.replace(/\r\n/gu, "\n").split("\n");
  if (lines[0] !== "---")
    throw new SkillPackageError("SKILL.md must start with YAML frontmatter");
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0)
    throw new SkillPackageError("SKILL.md frontmatter is not closed");
  let data: unknown;
  try {
    data = Bun.YAML.parse(lines.slice(1, closingIndex).join("\n"));
  } catch (error) {
    throw new SkillPackageError(
      `SKILL.md frontmatter is invalid YAML: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(data))
    throw new SkillPackageError("SKILL.md frontmatter must be a YAML object");
  return { data, body: lines.slice(closingIndex + 1).join("\n") };
}

/** The `metadata.version` of a canonical skill, or null when undeclared. */
export function readSkillVersion(skillRoot: string): string | null {
  const { data } = parseSkillFrontmatter(
    readFileSync(join(skillRoot, "SKILL.md"), "utf8"),
  );
  const metadata = data.metadata;
  return isRecord(metadata) && typeof metadata.version === "string"
    ? metadata.version
    : null;
}

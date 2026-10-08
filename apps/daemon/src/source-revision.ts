/**
 * Fail-soft Git HEAD resolution for the daemon's own source checkout.
 *
 * The CLI's `distribution-source-identity.ts` shells out to `git` and reports
 * dirty state; the daemon must not import the CLI and only needs the HEAD
 * revision, so it reads the well-known files directly. Any irregularity — no
 * repository, a malformed HEAD, a missing or unparseable ref — yields `null`,
 * never an error: this value is observability, not authority.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isGitRevision } from "@ai-office/command-support/version.ts";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A ref must stay inside the refs namespace and can never escape it. */
function isRefName(value: string): boolean {
  return /^refs\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..");
}

/** `.git` is a directory, or a `gitdir: <path>` file (worktrees, submodules). */
function gitDirectory(marker: string): string | null {
  try {
    if (statSync(marker).isDirectory()) return marker;
  } catch {
    return null;
  }
  const content = readText(marker);
  const match =
    content === null ? null : /^gitdir:[ \t]*(\S.*)$/m.exec(content);
  if (match === null || match[1] === undefined) return null;
  return resolve(dirname(marker), match[1].trim());
}

/** Worktrees keep per-worktree files beside HEAD and shared refs in the common dir. */
function commonDirectory(gitdir: string): string {
  const content = readText(join(gitdir, "commondir"));
  if (content === null) return gitdir;
  const relative = content.trim();
  return relative === "" ? gitdir : resolve(gitdir, relative);
}

/** Loose ref first (it wins over a packed entry), then `packed-refs`. */
function resolveRef(base: string, ref: string): string | null {
  const loose = readText(join(base, ref));
  if (loose !== null) {
    const value = loose.trim();
    if (isGitRevision(value)) return value;
  }
  const packed = readText(join(base, "packed-refs"));
  if (packed === null) return null;
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.trimEnd().split(" ");
    if (name === ref && sha !== undefined && isGitRevision(sha)) return sha;
  }
  return null;
}

/** The HEAD revision of the checkout containing `directory`, or `null`. */
export function readSourceRevision(directory: string): string | null {
  let current = resolve(directory);
  for (;;) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      const gitdir = gitDirectory(marker);
      if (gitdir === null) return null;
      const head = readText(join(gitdir, "HEAD"));
      if (head === null) return null;
      const value = head.trim();
      if (isGitRevision(value)) return value;
      const ref = value.startsWith("ref: ") ? value.slice(5).trim() : null;
      if (ref === null || !isRefName(ref)) return null;
      return (
        resolveRef(gitdir, ref) ?? resolveRef(commonDirectory(gitdir), ref)
      );
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readSourceRevision } from "../../apps/daemon/src/source-revision.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";
const other = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const directories: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ai-office-source-revision-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("readSourceRevision", () => {
  test("resolves a loose branch ref from a nested source directory", () => {
    const root = fixture();
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${sha}\n`);
    const nested = join(root, "apps", "daemon", "src");
    mkdirSync(nested, { recursive: true });
    expect(readSourceRevision(nested)).toBe(sha);
  });

  test("falls back to packed-refs when no loose ref exists", () => {
    const root = fixture();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(root, ".git", "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted \n${sha} refs/heads/main\n^${other}\n`,
    );
    expect(readSourceRevision(root)).toBe(sha);
  });

  test("accepts a detached HEAD", () => {
    const root = fixture();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), `${sha}\n`);
    expect(readSourceRevision(root)).toBe(sha);
  });

  test("resolves worktree gitdir files and the common directory", () => {
    const root = fixture();
    const common = join(root, "main-checkout", ".git");
    const worktree = join(common, "worktrees", "feature");
    mkdirSync(join(common, "refs", "heads"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(common, "refs", "heads", "main"), `${sha}\n`);
    writeFileSync(join(worktree, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(worktree, "commondir"), "../..\n");
    const checkout = join(root, "linked-checkout");
    mkdirSync(join(checkout, "src"), { recursive: true });
    writeFileSync(join(checkout, ".git"), `gitdir: ${worktree}\n`);
    expect(readSourceRevision(join(checkout, "src"))).toBe(sha);
  });

  test("returns null outside a repository and for malformed metadata", () => {
    expect(readSourceRevision(fixture())).toBeNull();

    const malformed = fixture();
    mkdirSync(join(malformed, ".git"), { recursive: true });
    writeFileSync(join(malformed, ".git", "HEAD"), "ref: ../../etc/passwd\n");
    expect(readSourceRevision(malformed)).toBeNull();

    writeFileSync(join(malformed, ".git", "HEAD"), "ref: refs/heads/missing\n");
    expect(readSourceRevision(malformed)).toBeNull();

    writeFileSync(join(malformed, ".git", "HEAD"), "not-a-revision\n");
    expect(readSourceRevision(malformed)).toBeNull();
  });
});

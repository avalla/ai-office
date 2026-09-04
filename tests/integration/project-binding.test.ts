import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProjectBindingAdapter } from "@ai-office/runtime-host/local-project-binding-adapter.ts";
import { parseProjectBinding } from "@ai-office/application/project-lifecycle/project-binding.ts";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const binding = {
  schemaVersion: 2,
  managedBy: "ai-office",
  repositoryId: "repository-one",
} as const;

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("repository-local project binding", () => {
  test("writes a minimal portable binding atomically and idempotently", async () => {
    const root = temporaryRoot("ai-office-binding-write-");
    const adapter = new LocalProjectBindingAdapter();
    const first = await adapter.planWrite(root, binding);
    expect(first).toMatchObject({ action: "create", expectedSha256: null });
    await adapter.applyWrite(first);

    expect(
      parseProjectBinding(
        JSON.parse(
          readFileSync(join(root, ".ai-office", "project.json"), "utf8"),
        ) as unknown,
      ),
    ).toEqual(binding);
    expect(
      readFileSync(join(root, ".ai-office", "project.json"), "utf8"),
    ).not.toContain(root);
    expect(await adapter.planWrite(root, binding)).toMatchObject({
      action: "none",
    });
  });

  test("discovers the nearest binding from descendants and supports nested projects", async () => {
    const root = temporaryRoot("ai-office-binding-ancestor-");
    const nested = join(root, "packages", "nested");
    const descendant = join(nested, "src");
    mkdirSync(descendant, { recursive: true });
    const adapter = new LocalProjectBindingAdapter();
    await adapter.applyWrite(await adapter.planWrite(root, binding));
    await adapter.applyWrite(
      await adapter.planWrite(nested, {
        ...binding,
        repositoryId: "repository-nested",
      }),
    );

    const fromNested = await adapter.inspect(descendant, { ancestors: true });
    expect(fromNested).toMatchObject({
      status: "valid",
      rootPath: realpathSync(nested),
      binding: { repositoryId: "repository-nested" },
    });
    const fromRoot = await adapter.inspect(root, { ancestors: true });
    expect(fromRoot).toMatchObject({
      status: "valid",
      rootPath: realpathSync(root),
      binding: { repositoryId: "repository-one" },
    });
  });

  test("canonicalizes a symlinked starting directory before ancestor traversal", async () => {
    const workspace = temporaryRoot("ai-office-binding-canonical-");
    const root = join(workspace, "real-project");
    const child = join(root, "packages", "child");
    const link = join(workspace, "project-link");
    mkdirSync(child, { recursive: true });
    symlinkSync(root, link);
    const adapter = new LocalProjectBindingAdapter();
    await adapter.applyWrite(await adapter.planWrite(root, binding));

    const inspection = await adapter.inspect(join(link, "packages", "child"), {
      ancestors: true,
    });
    expect(inspection.rootPath).toBe(realpathSync(root));
    expect(inspection.searchedFrom).toBe(realpathSync(child));
  });

  test("stops without heuristics when no ancestor binding exists", async () => {
    const root = temporaryRoot("ai-office-binding-missing-");
    const child = join(root, "a", "b");
    mkdirSync(join(root, ".ai-office"));
    mkdirSync(child, { recursive: true });

    const inspection = await new LocalProjectBindingAdapter().inspect(child, {
      ancestors: true,
    });
    expect(inspection).toMatchObject({
      status: "missing",
      rootPath: realpathSync(child),
    });
  });

  test("resolves Git descendants, linked worktrees, and standalone directories", async () => {
    const workspace = temporaryRoot("ai-office-binding-root-resolution-");
    const repository = join(workspace, "repository");
    const descendant = join(repository, "packages", "foo");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(descendant, { recursive: true });
    const adapter = new LocalProjectBindingAdapter();
    expect(await adapter.resolveProjectRoot(descendant)).toBe(
      realpathSync(repository),
    );

    const worktree = join(workspace, "worktree");
    const worktreeChild = join(worktree, "src");
    mkdirSync(worktreeChild, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../git/worktrees/one\n");
    expect(await adapter.resolveProjectRoot(worktreeChild)).toBe(
      realpathSync(worktree),
    );

    const standalone = join(workspace, "standalone", "src");
    mkdirSync(standalone, { recursive: true });
    expect(await adapter.resolveProjectRoot(standalone)).toBe(
      realpathSync(standalone),
    );
  });

  test("fails closed on ambiguous Git root markers", async () => {
    const root = temporaryRoot("ai-office-binding-git-marker-");
    const child = join(root, "src");
    const external = temporaryRoot("ai-office-binding-git-external-");
    mkdirSync(child);
    symlinkSync(external, join(root, ".git"));
    const adapter = new LocalProjectBindingAdapter();
    await expect(adapter.resolveProjectRoot(child)).rejects.toThrow(
      ".git must be a real directory",
    );

    rmSync(join(root, ".git"));
    writeFileSync(join(root, ".git"), "not a worktree pointer\n");
    await expect(adapter.resolveProjectRoot(child)).rejects.toThrow(
      ".git worktree file is malformed",
    );
  });

  test("fails closed when .ai-office or project.json is symlinked", async () => {
    const root = temporaryRoot("ai-office-binding-symlink-");
    const external = temporaryRoot("ai-office-binding-external-");
    writeFileSync(join(external, "project.json"), JSON.stringify(binding));
    symlinkSync(external, join(root, ".ai-office"));

    const adapter = new LocalProjectBindingAdapter();
    expect(await adapter.inspect(root)).toMatchObject({ status: "invalid" });
    await expect(adapter.planWrite(root, binding)).rejects.toThrow(
      ".ai-office must be a real directory",
    );

    rmSync(join(root, ".ai-office"));
    mkdirSync(join(root, ".ai-office"));
    symlinkSync(
      join(external, "project.json"),
      join(root, ".ai-office", "project.json"),
    );
    expect(await adapter.inspect(root)).toMatchObject({ status: "invalid" });
  });

  test("rejects stale write and removal plans and preserves unrelated entries", async () => {
    const root = temporaryRoot("ai-office-binding-stale-");
    const adapter = new LocalProjectBindingAdapter();
    const create = await adapter.planWrite(root, binding);
    mkdirSync(join(root, ".ai-office"));
    writeFileSync(
      join(root, ".ai-office", "project.json"),
      JSON.stringify({ ...binding, repositoryId: "concurrent" }),
    );
    await expect(adapter.applyWrite(create)).rejects.toThrow(
      "changed after planning",
    );

    const remove = await adapter.planRemove(root);
    writeFileSync(join(root, ".ai-office", "notes.txt"), "preserve\n");
    writeFileSync(
      join(root, ".ai-office", "project.json"),
      `${JSON.stringify({ ...binding, repositoryId: "concurrent" })}\n`,
    );
    await expect(adapter.applyRemove(remove)).rejects.toThrow(
      "changed after planning",
    );
    const fresh = await adapter.planRemove(root);
    await adapter.applyRemove(fresh);
    expect(existsSync(join(root, ".ai-office", "project.json"))).toBe(false);
    expect(readFileSync(join(root, ".ai-office", "notes.txt"), "utf8")).toBe(
      "preserve\n",
    );
  });
});

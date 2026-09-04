import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalProjectArchiveAdapter,
  nodeProjectArchiveFileSystem,
} from "@ai-office/runtime-host/local-project-archive-adapter.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("local portable project archive", () => {
  test("writes atomically with private permissions and refuses overwrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-archive-"));
    roots.push(root);
    const path = join(root, "backup.aioffice");
    const adapter = new LocalProjectArchiveAdapter();
    await adapter.write(path, "snapshot\n");
    expect(readFileSync(path, "utf8")).toBe("snapshot\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["backup.aioffice"]);
    await expect(adapter.write(path, "replacement\n")).rejects.toThrow(
      "Refusing to overwrite",
    );
  });

  test("rejects symlink input, non-archive extensions, and missing files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-archive-security-"));
    roots.push(root);
    const target = join(root, "target.aioffice");
    const link = join(root, "link.aioffice");
    writeFileSync(target, "{}\n");
    symlinkSync(target, link);
    const adapter = new LocalProjectArchiveAdapter();
    await expect(adapter.read(link)).rejects.toThrow("non-symlink");
    await expect(adapter.read(join(root, "backup.zip"))).rejects.toThrow(
      ".aioffice",
    );
    await expect(adapter.read(join(root, "missing.aioffice"))).rejects.toThrow(
      "does not exist",
    );
  });

  test("cleans the private temporary file when its write fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-archive-write-fail-"));
    roots.push(root);
    const path = join(root, "backup.aioffice");
    const adapter = new LocalProjectArchiveAdapter({
      ...nodeProjectArchiveFileSystem,
      write: () => {
        throw new Error("injected temporary write failure");
      },
    });
    await expect(adapter.write(path, "snapshot\n")).rejects.toThrow(
      "Could not write portable project archive",
    );
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("leaves no artifact or temporary file when publication fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-archive-link-fail-"));
    roots.push(root);
    const path = join(root, "backup.aioffice");
    const adapter = new LocalProjectArchiveAdapter({
      ...nodeProjectArchiveFileSystem,
      link: () => {
        throw new Error("injected publication failure");
      },
    });
    await expect(adapter.write(path, "snapshot\n")).rejects.toThrow(
      "Could not write portable project archive",
    );
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  ProjectStorageBootstrap,
  requireCompleteProjectStorage,
  StorageProviderConfigurationError,
  StorageProviderIncompleteError,
  projectStorageCapabilityNames,
} from "@ai-office/storage-bootstrap/project-storage-bootstrap.ts";
import { SqliteJobOutboxRepository } from "@ai-office/storage-sqlite/repositories/sqlite-job-outbox.repository.ts";
import { executeRuntimeCommand } from "@ai-office/runtime-host/runtime-command.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("project storage provider bootstrap", () => {
  test("defaults to a complete SQLite authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-storage-bootstrap-"));
    roots.push(root);
    const databasePath = join(root, "project.sqlite");
    const bootstrap = new ProjectStorageBootstrap({
      sqliteDatabasePath: databasePath,
      environment: {},
    });

    const handle = await bootstrap.open({ requireComplete: true });
    try {
      expect(handle.provider).toBe("sqlite");
      expect(handle.capabilities).toEqual(
        Object.fromEntries(
          projectStorageCapabilityNames.map((name) => [name, true]),
        ),
      );
      expect(requireCompleteProjectStorage(handle).jobOutbox).toBeInstanceOf(
        SqliteJobOutboxRepository,
      );
    } finally {
      await handle.close();
      await handle.close();
    }
    expect(existsSync(databasePath)).toBe(true);
  });

  test("explicit SQLite uses the supplied database path", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-storage-bootstrap-"));
    roots.push(root);
    const databasePath = join(root, "explicit.sqlite");
    const defaultPath = join(root, "default.sqlite");
    const bootstrap = new ProjectStorageBootstrap({
      sqliteDatabasePath: defaultPath,
      environment: { AI_OFFICE_STORAGE_PROVIDER: "sqlite" },
    });

    const handle = await bootstrap.open({
      configuration: { provider: "sqlite", databasePath },
      requireComplete: true,
    });
    await handle.close();

    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(defaultPath)).toBe(false);
  });

  test("unknown providers fail without falling back", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-storage-bootstrap-"));
    roots.push(root);
    const databasePath = join(root, "project.sqlite");
    const bootstrap = new ProjectStorageBootstrap({
      sqliteDatabasePath: databasePath,
      environment: { AI_OFFICE_STORAGE_PROVIDER: "mysql" },
    });

    expect(() => bootstrap.resolve()).toThrow(
      StorageProviderConfigurationError,
    );
    expect(existsSync(databasePath)).toBe(false);
  });

  test("PostgreSQL selection requires a connection string before opening", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-storage-bootstrap-"));
    roots.push(root);
    const databasePath = join(root, "project.sqlite");
    const bootstrap = new ProjectStorageBootstrap({
      sqliteDatabasePath: databasePath,
      environment: { AI_OFFICE_STORAGE_PROVIDER: "postgres" },
    });

    expect(() => bootstrap.resolve()).toThrow(
      "AI_OFFICE_POSTGRES_URL is required",
    );
    expect(existsSync(databasePath)).toBe(false);
  });

  test("incomplete-provider errors do not include connection secrets", () => {
    const error = new StorageProviderIncompleteError("postgres", ["jobOutbox"]);
    expect(error.message).not.toContain("postgres://");
    expect(error.missingCapabilities).toEqual(["jobOutbox"]);
  });

  test("rejects conflicting injected authority and storage configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-storage-bootstrap-"));
    roots.push(root);
    const bootstrap = new ProjectStorageBootstrap({
      sqliteDatabasePath: join(root, "project.sqlite"),
      environment: {},
    });
    const handle = await bootstrap.open({ requireComplete: true });
    const stderr: string[] = [];

    try {
      await expect(
        executeRuntimeCommand(["project:create", "ambiguous"], {
          projectRoot: root,
          projectStorage: requireCompleteProjectStorage(handle),
          projectStorageConfig: {
            provider: "postgres",
            connectionString: "postgres://example",
            tenantId: "bootstrap-tenant",
          },
          io: {
            stdout: () => {},
            stderr: (message) => stderr.push(message),
          },
        }),
      ).resolves.toBe(1);
      expect(stderr).toEqual([
        "projectStorage and projectStorageConfig cannot be supplied together",
      ]);
    } finally {
      await handle.close();
    }
  });
});

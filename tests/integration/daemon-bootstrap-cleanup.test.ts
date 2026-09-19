import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProjectStorageBootstrap } from "@ai-office/storage-bootstrap/project-storage-bootstrap.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function trackedProjectStorageBootstrap(root: string) {
  const delegate = new ProjectStorageBootstrap({
    sqliteDatabasePath: join(root, ".ai-office", "project.sqlite"),
    environment: {},
  });
  let closeCalls = 0;
  return {
    projectStorageBootstrap: {
      resolve: (configuration: Parameters<typeof delegate.resolve>[0]) =>
        delegate.resolve(configuration),
      open: async (options: Parameters<typeof delegate.open>[0]) => {
        const handle = await delegate.open(options);
        return {
          ...handle,
          close: async () => {
            closeCalls += 1;
            await handle.close();
          },
        };
      },
    },
    closeCalls: () => closeCalls,
  };
}

describe("daemon bootstrap resource ownership", () => {
  test("closes project storage when global database acquisition fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-bootstrap-cleanup-"));
    roots.push(root);
    const tracker = trackedProjectStorageBootstrap(root);

    await expect(
      bootstrap({
        projectRoot: root,
        projectStorageBootstrap: tracker.projectStorageBootstrap,
        openGlobalDatabase: () => {
          throw new Error("global database open failed");
        },
      }),
    ).rejects.toThrow("global database open failed");

    expect(tracker.closeCalls()).toBe(1);
  });

  test("closes project storage and global database after migration failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-bootstrap-cleanup-"));
    roots.push(root);
    const tracker = trackedProjectStorageBootstrap(root);
    const globalDatabase = openDatabase(join(root, "global.sqlite"));
    const globalClose = vi.spyOn(globalDatabase, "close");

    await expect(
      bootstrap({
        projectRoot: root,
        projectStorageBootstrap: tracker.projectStorageBootstrap,
        openGlobalDatabase: () => globalDatabase,
        globalMigrationDirectory: join(root, "missing-global-migrations"),
      }),
    ).rejects.toThrow();

    expect(tracker.closeCalls()).toBe(1);
    expect(globalClose).toHaveBeenCalledTimes(1);
  });

  test("transfers ownership to the host and closes project storage on stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-bootstrap-cleanup-"));
    roots.push(root);
    const socket = createTestUnixSocket();
    roots.push(socket.root);
    const tracker = trackedProjectStorageBootstrap(root);
    const host = await bootstrap({
      projectRoot: root,
      socketPath: socket.socketPath,
      projectStorageBootstrap: tracker.projectStorageBootstrap,
    });

    expect(tracker.closeCalls()).toBe(0);
    const controller = new AbortController();
    const running = host.start(controller.signal);
    for (
      let attempt = 0;
      attempt < 100 && !existsSync(socket.socketPath);
      attempt += 1
    )
      await Bun.sleep(5);
    controller.abort();
    await running;

    expect(tracker.closeCalls()).toBe(1);
  });
});

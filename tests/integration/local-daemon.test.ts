import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonClient,
  IpcRuntimeClient,
} from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { DaemonAlreadyRunningError } from "../../apps/daemon/src/office-daemon.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitForHealth(client: DaemonClient): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error("Daemon did not become healthy");
}

describe("local daemon", () => {
  test("serves health and commands, audits safe metadata, and removes its socket", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-daemon-"));
    temporaryDirectories.push(projectRoot);
    const socketPath = join(projectRoot, "daemon.sock");
    const daemon = await bootstrap({ projectRoot, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const client = new DaemonClient(socketPath);

    try {
      await waitForHealth(client);
      const health = await client.health();
      expect(health.status).toBe("ok");
      expect(Number.isNaN(Date.parse(health.startedAt))).toBe(false);

      const response = await client.execute([
        "project:create",
        "Sensitive project name",
      ]);
      expect(response.exitCode).toBe(0);
      expect(response.stdout[0]).toMatch(/^Project created: /);
      expect(response.stderr).toEqual([]);
      expect(existsSync(socketPath)).toBe(true);

      const projectId = response.stdout[0]!.replace("Project created: ", "");
      const secondClient = new IpcRuntimeClient(socketPath);
      const createdTask = await secondClient.execute([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Created by another client",
      ]);
      expect(createdTask.exitCode).toBe(0);
      const observedByFirstClient = await client.execute([
        "task:list",
        "--project",
        projectId,
      ]);
      expect(observedByFirstClient.stdout.join("\n")).toContain(
        "Created by another client",
      );
    } finally {
      controller.abort();
      await running;
    }

    expect(existsSync(socketPath)).toBe(false);
    const database = openDatabase(
      join(projectRoot, ".ai-office", "project.sqlite"),
    );
    const events = database
      .query<{ event_type: string; payload_json: string }, []>(
        "SELECT event_type, payload_json FROM audit_event ORDER BY rowid",
      )
      .all();
    expect(events.map((event) => event.event_type)).toEqual([
      "daemon.started",
      "command.received",
      "command.completed",
      "command.received",
      "command.completed",
      "command.received",
      "command.completed",
      "daemon.stopped",
    ]);
    expect(
      events.some((event) =>
        event.payload_json.includes("Sensitive project name"),
      ),
    ).toBe(false);
    expect(() =>
      database.exec("UPDATE audit_event SET event_type = 'changed'"),
    ).toThrow("audit_event is append-only");
    expect(() => database.exec("DELETE FROM audit_event")).toThrow(
      "audit_event is append-only",
    );
    database.close();
  });

  test("replaces a stale socket but refuses a second active daemon", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-daemon-stale-"));
    temporaryDirectories.push(projectRoot);
    const socketPath = join(projectRoot, "daemon.sock");
    writeFileSync(socketPath, "stale");

    const first = await bootstrap({ projectRoot, socketPath });
    const firstController = new AbortController();
    const firstRunning = first.start(firstController.signal);
    const client = new DaemonClient(socketPath);

    try {
      await waitForHealth(client);
      const second = await bootstrap({ projectRoot, socketPath });
      await expect(
        second.start(new AbortController().signal),
      ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
      expect((await client.health()).status).toBe("ok");
    } finally {
      firstController.abort();
      await firstRunning;
    }
  });
});

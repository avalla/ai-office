import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  TaskDeliverySetupEntry,
  TaskDeliverySetupRepository,
  TaskDeliverySetupScope,
} from "@ai-office/application/ports/task-delivery-setup-repository.port.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import {
  defaultTaskDeliverySetupValues,
  taskDeliverySetupKeys,
} from "@ai-office/application/task-delivery-setup/task-delivery-setup-schema.ts";
import { ReadTaskDeliverySetup } from "@ai-office/application/task-delivery-setup/read-task-delivery-setup.ts";
import { WriteTaskDeliverySetup } from "@ai-office/application/task-delivery-setup/write-task-delivery-setup.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class InMemorySetupRepository implements TaskDeliverySetupRepository {
  readonly entries: TaskDeliverySetupEntry[] = [];
  readonly actors: { actor: string; now: Date }[] = [];

  private index(entry: {
    projectId: string;
    scope: TaskDeliverySetupScope;
    scopeRef: string | null;
    key: string;
  }): number {
    return this.entries.findIndex(
      (existing) =>
        existing.projectId === entry.projectId &&
        existing.scope === entry.scope &&
        existing.scopeRef === entry.scopeRef &&
        existing.key === entry.key,
    );
  }

  async get(
    projectId: string,
    scope: TaskDeliverySetupScope,
    scopeRef: string | null,
  ): Promise<TaskDeliverySetupEntry[]> {
    return this.entries
      .filter(
        (entry) =>
          entry.projectId === projectId &&
          entry.scope === scope &&
          entry.scopeRef === scopeRef,
      )
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async put(
    entry: TaskDeliverySetupEntry,
    actor: string,
    now: Date,
  ): Promise<void> {
    this.actors.push({ actor, now });
    const at = this.index(entry);
    if (at >= 0) this.entries[at] = entry;
    else this.entries.push(entry);
  }

  async remove(
    projectId: string,
    scope: TaskDeliverySetupScope,
    scopeRef: string | null,
    key: string,
  ): Promise<boolean> {
    const at = this.index({ projectId, scope, scopeRef, key });
    if (at < 0) return false;
    this.entries.splice(at, 1);
    return true;
  }
}

function harness(options: {
  entries?: TaskDeliverySetupEntry[];
  projectExists?: boolean;
}) {
  const setup = new InMemorySetupRepository();
  setup.entries.push(...(options.entries ?? []));
  const ports = {
    projects: {
      findById: async (id: string) =>
        options.projectExists === false || id !== "project"
          ? null
          : { id },
    },
    setup,
    transactions: {
      run: async <T>(work: () => Promise<T>): Promise<T> => await work(),
    },
  };
  return {
    setup,
    read: new ReadTaskDeliverySetup(ports),
    write: new WriteTaskDeliverySetup(ports),
    ports,
  };
}

describe("ReadTaskDeliverySetup", () => {
  test("returns the built-in defaults when nothing is stored", async () => {
    const { read } = harness({});
    const resolved = await read.read("project");
    expect(resolved.values).toEqual(defaultTaskDeliverySetupValues);
    expect(resolved.project).toEqual({});
    expect(resolved.overrides).toEqual([]);
  });

  test("merges project, then run, then task, with the narrowest scope winning", async () => {
    const { read } = harness({
      entries: [
        {
          projectId: "project",
          scope: "project",
          scopeRef: null,
          key: "checkpointFrequency",
          value: "stage-boundaries",
        },
        {
          projectId: "project",
          scope: "run",
          scopeRef: "run-1",
          key: "checkpointFrequency",
          value: "handoff-only",
        },
        {
          projectId: "project",
          scope: "task",
          scopeRef: "task-1",
          key: "checkpointFrequency",
          value: "every-gate",
        },
        {
          projectId: "project",
          scope: "task",
          scopeRef: "task-1",
          key: "resumeDetail",
          value: "full",
        },
        // Another run and task must not leak into this resolution.
        {
          projectId: "project",
          scope: "run",
          scopeRef: "run-2",
          key: "handoffMode",
          value: "gate",
        },
        {
          projectId: "project",
          scope: "task",
          scopeRef: "task-2",
          key: "contextThreshold",
          value: 0.9,
        },
      ],
    });
    const resolved = await read.read("project", {
      runId: "run-1",
      taskId: "task-1",
    });
    expect(resolved.values).toEqual({
      ...defaultTaskDeliverySetupValues,
      checkpointFrequency: "every-gate",
      resumeDetail: "full",
    });
    expect(resolved.project).toEqual({ checkpointFrequency: "stage-boundaries" });
    expect(resolved.overrides).toEqual([
      {
        scope: "run",
        scopeRef: "run-1",
        key: "checkpointFrequency",
        value: "handoff-only",
      },
      {
        scope: "task",
        scopeRef: "task-1",
        key: "checkpointFrequency",
        value: "every-gate",
      },
      {
        scope: "task",
        scopeRef: "task-1",
        key: "resumeDetail",
        value: "full",
      },
    ]);
  });

  test("ignores stored rows with unknown keys or out-of-contract values", async () => {
    const { read } = harness({
      entries: [
        {
          projectId: "project",
          scope: "project",
          scopeRef: null,
          key: "madeUp",
          value: "x",
        },
        {
          projectId: "project",
          scope: "project",
          scopeRef: null,
          key: "contextThreshold",
          value: 7,
        },
        {
          projectId: "project",
          scope: "project",
          scopeRef: null,
          key: "knowledgePolicy",
          value: "required",
        },
      ],
    });
    const resolved = await read.read("project");
    expect(resolved.values).toEqual({
      ...defaultTaskDeliverySetupValues,
      knowledgePolicy: "required",
    });
    expect(resolved.project).toEqual({ knowledgePolicy: "required" });
  });

  test("refuses an unknown project", async () => {
    const { read } = harness({ projectExists: false });
    await expect(read.read("missing")).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});

describe("WriteTaskDeliverySetup", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");

  test("upserts a project-scope key and reports the stored value", async () => {
    const { write, setup } = harness({});
    const result = await write.set(
      {
        projectId: "project",
        scope: "project",
        key: "handoffMode",
        value: "gate",
        actor: "operator",
      },
      now,
    );
    expect(result).toEqual({
      scope: "project",
      scopeRef: null,
      key: "handoffMode",
      value: "gate",
      deleted: false,
      updatedAt: now,
    });
    expect(setup.entries).toHaveLength(1);
    // A second write replaces the row instead of adding one.
    await write.set(
      {
        projectId: "project",
        scope: "project",
        key: "handoffMode",
        value: "offer",
        actor: "operator",
      },
      now,
    );
    expect(setup.entries).toHaveLength(1);
    expect(setup.entries[0]!.value).toBe("offer");
    expect(setup.actors).toEqual([
      { actor: "operator", now },
      { actor: "operator", now },
    ]);
  });

  test("requires a reference for run and task scopes and forbids one for project scope", async () => {
    const { write } = harness({});
    await expect(
      write.set(
        {
          projectId: "project",
          scope: "run",
          key: "handoffMode",
          value: "gate",
          actor: "operator",
        },
        now,
      ),
    ).rejects.toMatchObject({
      code: "TASK_DELIVERY_SETUP_SCOPE_REF_REQUIRED",
    });
    await expect(
      write.set(
        {
          projectId: "project",
          scope: "project",
          scopeRef: "task-1",
          key: "handoffMode",
          value: "gate",
          actor: "operator",
        },
        now,
      ),
    ).rejects.toMatchObject({
      code: "TASK_DELIVERY_SETUP_SCOPE_REF_FORBIDDEN",
    });
  });

  test.each([
    ["an unknown key", "madeUp", "x", "TASK_DELIVERY_SETUP_UNKNOWN_KEY"],
    [
      "an out-of-vocabulary word",
      "checkpointFrequency",
      "whenever",
      "TASK_DELIVERY_SETUP_INVALID_VALUE",
    ],
    [
      "an out-of-range number",
      "contextThreshold",
      1.5,
      "TASK_DELIVERY_SETUP_INVALID_VALUE",
    ],
    [
      "a non-number threshold",
      "contextThreshold",
      "high",
      "TASK_DELIVERY_SETUP_INVALID_VALUE",
    ],
  ])(
    "rejects %s with a typed code before touching the store",
    async (_label, key, value, code) => {
      const { write, setup } = harness({});
      await expect(
        write.set(
          {
            projectId: "project",
            scope: "project",
            key,
            value,
            actor: "operator",
          },
          now,
        ),
      ).rejects.toMatchObject({ code });
      expect(setup.entries).toHaveLength(0);
      expect(setup.actors).toHaveLength(0);
    },
  );

  test("a JSON null deletes the key", async () => {
    const { write, setup } = harness({
      entries: [
        {
          projectId: "project",
          scope: "task",
          scopeRef: "task-1",
          key: "resumeDetail",
          value: "full",
        },
      ],
    });
    const result = await write.set(
      {
        projectId: "project",
        scope: "task",
        scopeRef: "task-1",
        key: "resumeDetail",
        value: null,
        actor: "operator",
      },
      now,
    );
    expect(result).toEqual({
      scope: "task",
      scopeRef: "task-1",
      key: "resumeDetail",
      value: null,
      deleted: true,
      updatedAt: now,
    });
    expect(setup.entries).toHaveLength(0);
  });

  test("refuses an unknown project before writing", async () => {
    const { write, setup } = harness({ projectExists: false });
    await expect(
      write.set(
        {
          projectId: "missing",
          scope: "project",
          key: "handoffMode",
          value: "gate",
          actor: "operator",
        },
        now,
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(setup.entries).toHaveLength(0);
  });
});

describe("SqliteTaskDeliverySetupRepository", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");

  test("round-trips upserts, deletes and scope separation on a real database", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-setup-repo-"));
    temporaryDirectories.push(root);
    const migrations = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "migrations",
      "project",
    );
    const database = openDatabase(join(root, "project.sqlite"));
    try {
      migrate(database, migrations);
      const at = "2026-10-09T00:00:00.000Z";
      database
        .query(
          "INSERT INTO project(id,name,created_at,updated_at) VALUES ('project','Project',?,?)",
        )
        .run(at, at);
      const storage = createSqliteProjectStorage(database);

      const put = (
        scope: TaskDeliverySetupScope,
        scopeRef: string | null,
        key: string,
        value: unknown,
      ) =>
        storage.taskDeliverySetup.put(
          { projectId: "project", scope, scopeRef, key, value },
          "operator",
          now,
        );
      await put("project", null, "checkpointFrequency", "every-gate");
      await put("project", null, "contextThreshold", 0.25);
      await put("task", "task-1", "checkpointFrequency", "handoff-only");
      await put("task", "task-2", "checkpointFrequency", "stage-boundaries");

      // Upsert replaces in place; NULL and non-NULL scope refs stay apart.
      await put("project", null, "checkpointFrequency", "stage-boundaries");
      expect(await storage.taskDeliverySetup.get("project", "project", null)).toEqual([
        {
          projectId: "project",
          scope: "project",
          scopeRef: null,
          key: "checkpointFrequency",
          value: "stage-boundaries",
        },
        {
          projectId: "project",
          scope: "project",
          scopeRef: null,
          key: "contextThreshold",
          value: 0.25,
        },
      ]);
      expect(
        (await storage.taskDeliverySetup.get("project", "task", "task-1")).map(
          (entry) => entry.value,
        ),
      ).toEqual(["handoff-only"]);

      const rows = database
        .query<{ actor: string; updated_at: string }, []>(
          "SELECT actor, updated_at FROM task_delivery_setup WHERE key='checkpointFrequency' AND scope='project'",
        )
        .get();
      expect(rows).toEqual({ actor: "operator", updated_at: now.toISOString() });

      expect(
        await storage.taskDeliverySetup.remove(
          "project",
          "task",
          "task-1",
          "checkpointFrequency",
        ),
      ).toBe(true);
      expect(
        await storage.taskDeliverySetup.remove(
          "project",
          "task",
          "task-1",
          "checkpointFrequency",
        ),
      ).toBe(false);
      expect(
        await storage.taskDeliverySetup.get("project", "task", "task-1"),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });
});

test("the key vocabulary stays aligned with the defaults", () => {
  expect(taskDeliverySetupKeys).toEqual([
    "checkpointFrequency",
    "contextThreshold",
    "handoffMode",
    "knowledgePolicy",
    "resumeDetail",
  ]);
  for (const key of taskDeliverySetupKeys)
    expect(Object.hasOwn(defaultTaskDeliverySetupValues, key)).toBe(true);
});

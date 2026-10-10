import { describe, expect, it, vi } from "vitest";
import { handleDeliverySetupCommand } from "../../packages/runtime-host/src/commands/delivery-setup.ts";
import type { CommandContext } from "../../packages/runtime-host/src/commands/shared.ts";

interface Harness {
  context: CommandContext;
  stdout: string[];
}

function harness(
  options: {
    entries?: {
      scope: "project" | "run" | "task";
      scopeRef: string | null;
      key: string;
      value: unknown;
    }[];
    projectExists?: boolean;
  } = {},
): Harness {
  const stdout: string[] = [];
  const entries = [...(options.entries ?? [])];
  const context = {
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: () => {},
    },
    projects: {
      findById: async (id: string) =>
        options.projectExists === false || id !== "project" ? null : { id },
    },
    taskDeliverySetup: {
      get: async (_projectId: string, scope: string, scopeRef: string | null) =>
        entries
          .filter(
            (entry) => entry.scope === scope && entry.scopeRef === scopeRef,
          )
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      put: vi.fn(
        async (entry: {
          scope: "project" | "run" | "task";
          scopeRef: string | null;
          key: string;
          value: unknown;
        }) => {
          entries.push(entry);
        },
      ),
      remove: vi.fn(async () => true),
    },
    transactions: {
      run: async <T>(work: () => Promise<T>): Promise<T> => await work(),
    },
    principal: { kind: "operator", source: "local_cli", id: "local-operator" },
    clock: { now: () => new Date("2026-10-09T12:00:00.000Z") },
  } as unknown as CommandContext;
  return { context, stdout };
}

function run(
  context: CommandContext,
  command: string,
  args: string[],
): Promise<number | null> {
  return handleDeliverySetupCommand(command, args, context);
}

describe("delivery:setup:show", () => {
  it("reports the project rows and the applied overrides as schemaVersion 1 JSON", async () => {
    const { context, stdout } = harness({
      entries: [
        {
          scope: "project",
          scopeRef: null,
          key: "checkpointFrequency",
          value: "stage-boundaries",
        },
        {
          scope: "project",
          scopeRef: null,
          key: "knowledgePolicy",
          value: "required",
        },
        {
          scope: "task",
          scopeRef: "task-1",
          key: "resumeDetail",
          value: "full",
        },
      ],
    });
    const code = await run(context, "delivery:setup:show", [
      "--project",
      "project",
      "--task",
      "task-1",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({
      schemaVersion: 1,
      source: "runtime",
      project: {
        checkpointFrequency: "stage-boundaries",
        knowledgePolicy: "required",
      },
      overrides: [
        {
          scope: "task",
          scopeRef: "task-1",
          key: "resumeDetail",
          value: "full",
        },
      ],
    });
  });

  it("reports only project rows without a run or task filter", async () => {
    const { context, stdout } = harness({
      entries: [
        {
          scope: "run",
          scopeRef: "run-1",
          key: "handoffMode",
          value: "gate",
        },
      ],
    });
    expect(await run(context, "delivery:setup:show", ["--project", "project"])).toBe(
      0,
    );
    expect(JSON.parse(stdout[0]!)).toEqual({
      schemaVersion: 1,
      source: "runtime",
      project: {},
      overrides: [],
    });
  });

  it("accepts --run and --task together and merges both override scopes", async () => {
    const { context, stdout } = harness({
      entries: [
        {
          scope: "project",
          scopeRef: null,
          key: "checkpointFrequency",
          value: "stage-boundaries",
        },
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
      ],
    });
    const code = await run(context, "delivery:setup:show", [
      "--project",
      "project",
      "--run",
      "run-1",
      "--task",
      "task-1",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({
      schemaVersion: 1,
      source: "runtime",
      project: { checkpointFrequency: "stage-boundaries" },
      overrides: [
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
      ],
    });
  });

  it("rejects positionals and unknown options on show", async () => {
    const { context } = harness();
    await expect(
      run(context, "delivery:setup:show", ["--project", "project", "extra"]),
    ).rejects.toThrow("only accepts named options");
    await expect(
      run(context, "delivery:setup:show", ["--project", "project", "--json"]),
    ).rejects.toThrow("Unknown option --json");
    await expect(run(context, "delivery:setup:show", [])).rejects.toThrow(
      "Missing required option --project",
    );
  });

  it("propagates a typed unknown-project failure without output", async () => {
    const { context, stdout } = harness({ projectExists: false });
    await expect(
      run(context, "delivery:setup:show", ["--project", "missing"]),
    ).rejects.toBeInstanceOf(Error);
    expect(stdout).toHaveLength(0);
  });
});

describe("delivery:setup:set", () => {
  it("upserts a project-scope key with the operator as default actor", async () => {
    const { context, stdout } = harness();
    const code = await run(context, "delivery:setup:set", [
      "--project",
      "project",
      "--key",
      "handoffMode",
      "--value",
      '"gate"',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({
      schemaVersion: 1,
      key: "handoffMode",
      value: "gate",
      scope: "project",
      updatedAt: "2026-10-09T12:00:00.000Z",
    });
  });

  it("writes a task-scope override with its reference and a named actor", async () => {
    const { context, stdout } = harness();
    expect(
      await run(context, "delivery:setup:set", [
        "--project",
        "project",
        "--task",
        "task-1",
        "--key",
        "resumeDetail",
        "--value",
        '"full"',
        "--actor",
        "reviewer",
      ]),
    ).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({
      schemaVersion: 1,
      key: "resumeDetail",
      value: "full",
      scope: "task",
      updatedAt: "2026-10-09T12:00:00.000Z",
    });
    const put = (
      context.taskDeliverySetup as unknown as { put: ReturnType<typeof vi.fn> }
    ).put;
    expect(put).toHaveBeenCalledWith(
      {
        projectId: "project",
        scope: "task",
        scopeRef: "task-1",
        key: "resumeDetail",
        value: "full",
      },
      "reviewer",
      new Date("2026-10-09T12:00:00.000Z"),
    );
  });

  it("parses numbers and maps JSON null to a delete", async () => {
    const { context, stdout } = harness();
    expect(
      await run(context, "delivery:setup:set", [
        "--project",
        "project",
        "--key",
        "contextThreshold",
        "--value",
        "0.5",
      ]),
    ).toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      key: "contextThreshold",
      value: 0.5,
    });

    const remove = (
      context.taskDeliverySetup as unknown as {
        remove: ReturnType<typeof vi.fn>;
      }
    ).remove;
    expect(
      await run(context, "delivery:setup:set", [
        "--project",
        "project",
        "--key",
        "contextThreshold",
        "--value",
        "null",
      ]),
    ).toBe(0);
    expect(JSON.parse(stdout[1]!)).toMatchObject({
      key: "contextThreshold",
      value: null,
    });
    expect(remove).toHaveBeenCalledWith("project", "project", null, "contextThreshold");
  });

  it("keeps --run and --task mutually exclusive on set", async () => {
    const { context } = harness();
    await expect(
      run(context, "delivery:setup:set", [
        "--project",
        "project",
        "--run",
        "run-1",
        "--task",
        "task-1",
        "--key",
        "handoffMode",
        "--value",
        '"gate"',
      ]),
    ).rejects.toThrow("accepts at most one of --run and --task");
  });

  it("rejects invalid JSON, unknown keys and out-of-contract values", async () => {
    const { context } = harness();
    await expect(
      run(context, "delivery:setup:set", [
        "--project",
        "project",
        "--key",
        "handoffMode",
        "--value",
        "gate",
      ]),
    ).rejects.toThrow("--value must be valid JSON");
    await expect(
      run(context, "delivery:setup:set", [
        "--project",
        "project",
        "--key",
        "madeUp",
        "--value",
        '"x"',
      ]),
    ).rejects.toMatchObject({ code: "TASK_DELIVERY_SETUP_UNKNOWN_KEY" });
    await expect(
      run(context, "delivery:setup:set", [
        "--project",
        "project",
        "--key",
        "checkpointFrequency",
        "--value",
        '"whenever"',
      ]),
    ).rejects.toMatchObject({ code: "TASK_DELIVERY_SETUP_INVALID_VALUE" });
  });

  it("writes a run-scope override with its reference", async () => {
    const { context, stdout } = harness();
    expect(
      await run(context, "delivery:setup:set", [
        "--project",
        "project",
        "--run",
        "run-1",
        "--key",
        "handoffMode",
        "--value",
        '"gate"',
      ]),
    ).toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      key: "handoffMode",
      value: "gate",
      scope: "run",
    });
    const put = (
      context.taskDeliverySetup as unknown as { put: ReturnType<typeof vi.fn> }
    ).put;
    expect(put).toHaveBeenCalledWith(
      {
        projectId: "project",
        scope: "run",
        scopeRef: "run-1",
        key: "handoffMode",
        value: "gate",
      },
      "local-operator",
      new Date("2026-10-09T12:00:00.000Z"),
    );
  });

  it("returns null for an unrelated command", async () => {
    const { context } = harness();
    expect(await run(context, "knowledge:task", [])).toBeNull();
  });
});

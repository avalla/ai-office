import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveKnowledgePolicy } from "../../scripts/skills/knowledge-policy.ts";
import {
  resolveSetup,
  resolveSetupFromShow,
  SetupResolutionError,
  type SetupCommandRunner,
} from "../../scripts/skills/setup-resolution.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "task-delivery-setup-"));
  temporaryDirectories.push(root);
  return root;
}

function showOutput(project: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: "runtime",
    project,
    overrides: [],
  });
}

describe("resolveSetupFromShow", () => {
  test("applies runtime project rows over the defaults only", () => {
    const resolved = resolveSetupFromShow(
      {
        project: { checkpointFrequency: "stage-boundaries" },
        overrides: [],
      },
      { checkpointFrequency: "handoff-only" },
    );
    expect(resolved.source).toBe("runtime");
    expect(resolved.values).toMatchObject({
      checkpointFrequency: "stage-boundaries",
      handoffMode: "offer",
      contextThreshold: 0.25,
    });
  });

  test("applies overrides after project rows so the narrowest scope wins", () => {
    const resolved = resolveSetupFromShow(
      {
        project: { resumeDetail: "brief" },
        overrides: [
          {
            scope: "task",
            scopeRef: "task-1",
            key: "resumeDetail",
            value: "full",
          },
        ],
      },
      null,
    );
    expect(resolved.values.resumeDetail).toBe("full");
  });

  test("prefers YAML over defaults when no Runtime answer exists", () => {
    const resolved = resolveSetupFromShow(null, {
      knowledgePolicy: "required",
      contextThreshold: 0.5,
    });
    expect(resolved.source).toBe("yaml");
    expect(resolved.values).toMatchObject({
      knowledgePolicy: "required",
      contextThreshold: 0.5,
      handoffMode: "offer",
    });
  });

  test("returns the defaults untouched when nothing answers", () => {
    const resolved = resolveSetupFromShow(null, null);
    expect(resolved.source).toBe("defaults");
    expect(resolved.values.checkpointFrequency).toBe("every-gate");
    expect(resolved.values.knowledgePolicy).toBe("auto");
    expect(resolved.values.contextThreshold).toBe(0.25);
  });

  test("ignores out-of-contract values instead of merging them", () => {
    const resolved = resolveSetupFromShow(
      {
        project: { checkpointFrequency: "whenever", contextThreshold: 9 },
        overrides: [],
      },
      null,
    );
    expect(resolved.values.checkpointFrequency).toBe("every-gate");
    expect(resolved.values.contextThreshold).toBe(0.25);
  });
});

describe("resolveSetup", () => {
  test("uses the Runtime answer when the CLI responds", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, ".task-delivery.yaml"),
      "checkpointFrequency: handoff-only\n",
    );
    const runner: SetupCommandRunner = () => ({
      status: 0,
      stdout: showOutput({ checkpointFrequency: "stage-boundaries" }),
    });
    const resolved = resolveSetup(root, { runner });
    expect(resolved.source).toBe("runtime");
    expect(resolved.values.checkpointFrequency).toBe("stage-boundaries");
  });

  test("falls back to YAML when the Runtime does not answer", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, ".task-delivery.yaml"),
      "checkpointFrequency: handoff-only\nresumeDetail: full\n",
    );
    const missing: SetupCommandRunner = () => ({ status: null, stdout: "" });
    const failing: SetupCommandRunner = () => ({
      status: 1,
      stdout: "not bound",
    });
    for (const runner of [missing, failing]) {
      const resolved = resolveSetup(root, { runner });
      expect(resolved.source).toBe("yaml");
      expect(resolved.values.checkpointFrequency).toBe("handoff-only");
      expect(resolved.values.resumeDetail).toBe("full");
    }
  });

  test("falls back to the defaults when neither Runtime nor file answers", () => {
    const root = temporaryRoot();
    const runner: SetupCommandRunner = () => ({ status: 1, stdout: "" });
    const resolved = resolveSetup(root, { runner });
    expect(resolved.source).toBe("defaults");
    expect(resolved.values).toMatchObject({
      checkpointFrequency: "every-gate",
      handoffMode: "offer",
      resumeDetail: "standard",
      knowledgePolicy: "auto",
      contextThreshold: 0.25,
    });
  });

  test("errors when the Runtime answers but the payload breaks the contract", () => {
    const root = temporaryRoot();
    const malformed: SetupCommandRunner = () => ({
      status: 0,
      stdout: "not json at all",
    });
    expect(() => resolveSetup(root, { runner: malformed })).toThrow(
      SetupResolutionError,
    );
    // The fallback file is untouched by a Runtime that did answer.
    const outOfContract: SetupCommandRunner = () => ({
      status: 0,
      stdout: JSON.stringify({ schemaVersion: 2, project: {}, overrides: [] }),
    });
    expect(() => resolveSetup(root, { runner: outOfContract })).toThrow(
      /schemaVersion 1/u,
    );
  });

  test("errors when the Runtime is missing and the fallback file breaks its contract", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, ".task-delivery.yaml"),
      "checkpointFrequency: whenever\n",
    );
    const runner: SetupCommandRunner = () => ({ status: 1, stdout: "" });
    expect(() => resolveSetup(root, { runner })).toThrow(
      /breaks its contract/u,
    );
  });

  test("passes the run or task scope through to the show command", () => {
    const root = temporaryRoot();
    const calls: string[][] = [];
    const runner: SetupCommandRunner = (args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: showOutput({ contextThreshold: 0.5 }),
      };
    };
    resolveSetup(root, { runner, taskId: "task-1" });
    expect(calls[0]).toEqual(["delivery:setup:show", "--task", "task-1"]);
    resolveSetup(root, { runner, runId: "run-1" });
    expect(calls[1]).toEqual(["delivery:setup:show", "--run", "run-1"]);
  });

  test("the resolved knowledge policy feeds the retrieval decision mapping", () => {
    const resolved = resolveSetupFromShow(null, { knowledgePolicy: "required" });
    expect(
      resolveKnowledgePolicy(resolved.values.knowledgePolicy, "unavailable"),
    ).toMatchObject({ action: "block-gate" });
    const automatic = resolveSetupFromShow(null, null);
    expect(
      resolveKnowledgePolicy(automatic.values.knowledgePolicy, "unavailable"),
    ).toMatchObject({ action: "proceed-without-knowledge", evidenceNote: true });
  });
});

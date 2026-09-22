import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModelRoutingState,
} from "@ai-office/llm-gateway/model-routing-configuration.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import type { ModelRoutingState } from "@ai-office/application/model-routing/model-routing.ts";
import type { CommandContext } from "@ai-office/runtime-host/commands/shared.ts";
import { handleModelCommand } from "@ai-office/runtime-host/commands/model.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const routingText = `{"schema_version":1,"profiles":{"balanced":{"model":"openai:old-model"}},"default_profile":"balanced"}
`;

function createContext(
  path: string,
  project: object | null = {},
  auditFailure = false,
) {
  let active = loadModelRoutingState(
    { AI_OFFICE_MODEL_ROUTING_FILE: path },
    { readFile: () => readFileSync(path, "utf8") },
  );
  const auditEvents: Array<Record<string, unknown>> = [];
  const stdout: string[] = [];
  const context = {
    principal: localOperatorPrincipal,
    modelRouting: active,
    modelRoutingFile: path,
    modelRoutingLoader: (
      readFile?: (value: string) => string,
    ): ModelRoutingState =>
      loadModelRoutingState(
        { AI_OFFICE_MODEL_ROUTING_FILE: path },
        { readFile: readFile ?? ((value) => readFileSync(value, "utf8")) },
      ),
    reloadModelRouting: () => {
      active = loadModelRoutingState(
        { AI_OFFICE_MODEL_ROUTING_FILE: path },
        { readFile: () => readFileSync(path, "utf8") },
      );
      return active;
    },
    restoreModelRouting: (state: ModelRoutingState) => {
      active = state;
    },
    projects: {
      findById: async () => project,
    },
    modelProviders: {
      supportedProviders: () => ["openai"],
    },
    ids: { generate: () => "routing-test-token" },
    audit: {
      execute: async (input: Record<string, unknown>) => {
        if (auditFailure) throw new Error("audit repository unavailable");
        auditEvents.push(input);
        return "audit-id";
      },
    },
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: () => {},
    },
  } as unknown as CommandContext;
  return { context, auditEvents, stdout, getActive: () => active };
}

function file() {
  const root = mkdtempSync(join(tmpdir(), "ao-model-command-"));
  roots.push(root);
  const path = join(root, "model-routing.yaml");
  writeFileSync(path, routingText);
  return path;
}

describe("model routing operator commands", () => {
  test("requires an existing tenant-bound project before project override", async () => {
    const path = file();
    const original = readFileSync(path);
    const { context, auditEvents, stdout } = createContext(path, null);

    await expect(
      handleModelCommand(
        "model:override",
        [
          "--scope",
          "project",
          "--project",
          "missing-project",
          "--agent",
          "architect",
          "--model",
          "openai:new-model",
        ],
        context,
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    expect(readFileSync(path)).toEqual(original);
    expect(context.reloadModelRouting).toBeDefined();
    expect(stdout).toEqual([]);
    expect(auditEvents).toEqual([]);
  });

  test("attributes successful operator override to cli and excludes host details", async () => {
    const path = file();
    const { context, auditEvents, stdout } = createContext(path);

    await expect(
      handleModelCommand(
        "model:override",
        [
          "--scope",
          "host",
          "--agent",
          "architect",
          "--model",
          "openai:new-model",
          "--json",
        ],
        context,
      ),
    ).resolves.toBe(0);

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      eventType: "model.routing.override",
      actorType: "cli",
      actorId: "local-operator",
    });
    expect(JSON.stringify(auditEvents[0])).not.toContain(path);
    expect(JSON.stringify(auditEvents[0])).not.toContain("credential");
    expect(stdout[0]).toContain('"model":"openai:new-model"');
  });

  test("rolls back file and snapshot when override audit fails", async () => {
    const path = file();
    const original = readFileSync(path);
    const { context, auditEvents, getActive } = createContext(path, {}, true);
    const previous = getActive();

    await expect(
      handleModelCommand(
        "model:override",
        [
          "--scope",
          "host",
          "--agent",
          "architect",
          "--model",
          "openai:new-model",
        ],
        context,
      ),
    ).rejects.toThrow("audit repository unavailable");

    expect(readFileSync(path)).toEqual(original);
    expect(getActive()).toBe(previous);
    expect(auditEvents).toEqual([]);
  });

  test("audits successful reload and rolls back snapshot when audit fails", async () => {
    const path = file();
    const success = createContext(path);
    await expect(
      handleModelCommand("model:reload", ["--json"], success.context),
    ).resolves.toBe(0);
    expect(success.auditEvents[0]).toMatchObject({
      eventType: "model.routing.reload",
      actorType: "cli",
      actorId: "local-operator",
    });

    const failingPath = file();
    writeFileSync(
      failingPath,
      `{"schema_version":1,"profiles":{"next":{"model":"openai:new-model"}},"default_profile":"next"}
`,
    );
    const failing = createContext(failingPath, {}, true);
    const previous = failing.getActive();
    await expect(
      handleModelCommand("model:reload", ["--json"], failing.context),
    ).rejects.toThrow("audit repository unavailable");
    expect(failing.getActive()).toBe(previous);
  });

  test("returns failure and audits a misconfigured reload", async () => {
    const path = file();
    writeFileSync(
      path,
      `{"schema_version":1,"profiles":{"broken":{"model":"unknown:model"}},"default_profile":"broken"}
`,
    );
    const { context, auditEvents, stdout } = createContext(path);
    await expect(
      handleModelCommand("model:reload", ["--json"], context),
    ).resolves.toBe(1);
    expect(auditEvents[0]).toMatchObject({
      eventType: "model.routing.reload",
      actorType: "cli",
      payload: { status: "misconfigured" },
    });
    expect(stdout[0]).toContain('"status":"misconfigured"');
  });
});

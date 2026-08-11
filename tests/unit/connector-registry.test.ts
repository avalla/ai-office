import { describe, expect, test } from "vitest";
import type { ConnectorDefinition } from "@ai-office/connector-sdk/connector.ts";
import { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";
import {
  ConnectorRegistryError,
  UnsupportedConnectorError,
  UnsupportedConnectorOperationError,
} from "@ai-office/connector-sdk/errors.ts";
import {
  fakeConnectorDefinition,
  fakeConnectorDescriptor,
} from "@ai-office/connector-sdk/fake-connector.ts";
import { createDefaultConnectorRegistry } from "@ai-office/filesystem-connector/default-connector-registry.ts";
import { filesystemConnectorDefinition } from "@ai-office/filesystem-connector/filesystem-connector.ts";
import { UnsupportedConnectorResourceTypeError } from "@ai-office/domain/capability/errors.ts";
import type { ConnectorConstraintHandler } from "@ai-office/domain/capability/capability.ts";

function definitionWith(
  descriptor: ConnectorDefinition["descriptor"],
): ConnectorDefinition {
  return { ...fakeConnectorDefinition, descriptor };
}

describe("connector registry", () => {
  test("is immutable, deterministic, and has no unknown-provider fallback", () => {
    const registry = createDefaultConnectorRegistry();
    expect(registry.get("fake")).toMatchObject({
      id: fakeConnectorDescriptor.id,
      version: fakeConnectorDescriptor.version,
      supportedResourceTypes: ["filesystem_scope"],
    });
    expect(registry.get("filesystem")).toMatchObject({
      id: "filesystem",
      version: "2",
      supportedResourceTypes: ["filesystem_scope"],
    });
    expect(registry.get("github")).toBeNull();
    expect(() => registry.requireDefinition("github")).toThrow(
      UnsupportedConnectorError,
    );
    expect(() =>
      registry.requireOperation("filesystem", "filesystem.unknown"),
    ).toThrow(UnsupportedConnectorOperationError);
    expect(
      registry.get("filesystem")?.operations.map((value) => value.operation),
    ).toEqual([
      "filesystem.create",
      "filesystem.delete",
      "filesystem.list",
      "filesystem.move",
      "filesystem.read",
      "filesystem.search",
      "filesystem.write",
    ]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.get("filesystem"))).toBe(true);
    expect(Object.isFrozen(registry.get("filesystem")?.operations)).toBe(true);
  });

  test("rejects duplicate descriptors and duplicate operations", () => {
    expect(
      () =>
        new ConnectorRegistry([
          fakeConnectorDefinition,
          fakeConnectorDefinition,
        ]),
    ).toThrow(ConnectorRegistryError);
    expect(
      () =>
        new ConnectorRegistry([
          definitionWith({
            ...fakeConnectorDescriptor,
            operations: [
              fakeConnectorDescriptor.operations[0],
              fakeConnectorDescriptor.operations[0],
            ],
          }),
        ]),
    ).toThrow("Duplicate connector operation");
  });

  test("rejects empty or inconsistent trusted descriptor metadata", () => {
    expect(
      () =>
        new ConnectorRegistry([
          definitionWith({ ...fakeConnectorDescriptor, id: "" }),
        ]),
    ).toThrow("connector id cannot be empty");
    expect(
      () =>
        new ConnectorRegistry([
          definitionWith({ ...fakeConnectorDescriptor, version: " " }),
        ]),
    ).toThrow("connector version cannot be empty");
    expect(
      () =>
        new ConnectorRegistry([
          definitionWith({
            ...fakeConnectorDescriptor,
            operations: [
              {
                ...fakeConnectorDescriptor.operations[0],
                operation: "fake.read",
                mode: "mutation",
                supportsSimulation: false,
              },
            ],
          }),
        ]),
    ).toThrow("must support simulation");
  });

  test("keeps connector version and operation policy trusted", () => {
    const registry = createDefaultConnectorRegistry();
    const operation = registry.requireOperation(
      "filesystem",
      "filesystem.delete",
    );
    expect(operation).toMatchObject({
      mode: "mutation",
      riskLevel: "high",
      supportsSimulation: true,
      supportsExecution: true,
      requiresApproval: true,
    });
    expect(registry.requireDefinition("filesystem").descriptor.version).toBe(
      "2",
    );
  });

  test("requires a trusted execution boundary for executable mutations", () => {
    const { executeMutation: _executeMutation, ...withoutExecution } =
      filesystemConnectorDefinition;
    expect(
      () =>
        new ConnectorRegistry([withoutExecution]),
    ).toThrow("executable mutations without an execution boundary");
    expect(
      () =>
        new ConnectorRegistry([
          {
            ...fakeConnectorDefinition,
            executeMutation: async () => ({ audit: {} }),
          },
        ]),
    ).toThrow("unused mutation execution boundary");
  });

  test("defensively captures a mutable constraint handler", () => {
    const original = fakeConnectorDefinition.constraintHandler;
    const handler: {
      connector: string;
      combineAndValidate: ConnectorConstraintHandler["combineAndValidate"];
    } = {
      connector: original.connector,
      combineAndValidate: original.combineAndValidate,
    };
    const registry = new ConnectorRegistry([
      { ...fakeConnectorDefinition, constraintHandler: handler },
    ]);
    const policy = registry.getPolicyDefinition("fake");
    expect(policy).not.toBeNull();
    expect(Object.isFrozen(policy)).toBe(true);
    const input = ["fake.read", { target: "a" }, [{}], {}] as const;
    const before = policy!.constraintHandler.combineAndValidate(...input);
    handler.combineAndValidate = () => ({
      ok: false,
      effectiveConstraints: {},
      reasons: ["mutated by caller"],
    });
    const after = registry
      .getPolicyDefinition("fake")!
      .constraintHandler.combineAndValidate(...input);
    expect(after).toEqual(before);
    expect(after.reasons).not.toContain("mutated by caller");
    expect(registry.get("fake")).toMatchObject({ id: "fake", version: "1" });
  });

  test("never binds context-free callbacks to caller-mutable receivers", async () => {
    interface MutableHandlerState {
      enabled: boolean;
    }
    const statefulEvaluation = function (
      this: void | MutableHandlerState,
      ..._input: Parameters<ConnectorConstraintHandler["combineAndValidate"]>
    ) {
      const enabled = this === undefined ? true : this.enabled;
      return {
        ok: enabled,
        effectiveConstraints: { enabled },
        reasons: enabled ? [] : ["disabled by mutable receiver"],
      };
    };
    const handler: ConnectorConstraintHandler & MutableHandlerState = {
      connector: "fake",
      enabled: true,
      combineAndValidate: statefulEvaluation,
    };
    interface MutableDefinitionState {
      label: string;
    }
    const statefulPrepare = async function (
      this: void | MutableDefinitionState,
      input: Parameters<ConnectorDefinition["prepareResource"]>[0],
    ) {
      return {
        configuration: {
          ...input.configuration,
          receiver: this === undefined ? "context-free" : this.label,
        },
      };
    };
    const candidate: ConnectorDefinition & MutableDefinitionState = {
      ...fakeConnectorDefinition,
      constraintHandler: handler,
      label: "original receiver",
      prepareResource: statefulPrepare,
    };
    const input = ["fake.read", { target: "a" }, [{}], {}] as const;
    expect(statefulEvaluation.call(handler, ...input).ok).toBe(true);
    expect(
      (
        await statefulPrepare.call(candidate, {
          type: "filesystem_scope",
          configuration: {},
        })
      ).configuration,
    ).toEqual({ receiver: "original receiver" });

    const registry = new ConnectorRegistry([candidate]);
    const before = registry
      .getPolicyDefinition("fake")!
      .constraintHandler.combineAndValidate(...input);
    const preparedBefore = await registry
      .requireDefinition("fake")
      .prepareResource({ type: "filesystem_scope", configuration: {} });

    handler.enabled = false;
    candidate.label = "mutated receiver";
    expect(statefulEvaluation.call(handler, ...input).ok).toBe(false);
    const after = registry
      .getPolicyDefinition("fake")!
      .constraintHandler.combineAndValidate(...input);
    const preparedAfter = await registry
      .requireDefinition("fake")
      .prepareResource({ type: "filesystem_scope", configuration: {} });

    expect(after).toEqual(before);
    expect(after.ok).toBe(true);
    expect(preparedBefore.configuration).toEqual({ receiver: "context-free" });
    expect(preparedAfter).toEqual(preparedBefore);
  });

  test("rejects a filesystem resource type mismatch", async () => {
    const definition =
      createDefaultConnectorRegistry().requireDefinition("filesystem");
    await expect(
      definition.prepareResource({
        type: "github_repository",
        externalRef: "/tmp",
        configuration: {},
      }),
    ).rejects.toBeInstanceOf(UnsupportedConnectorResourceTypeError);
  });
});

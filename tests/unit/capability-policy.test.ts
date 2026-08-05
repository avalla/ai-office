import { describe, expect, test } from "vitest";
import { hashCanonicalActionPayload } from "@ai-office/application/capability/canonical-action.ts";
import { ActionRequest } from "@ai-office/domain/capability/action-request.ts";
import type {
  CapabilityGrant,
  PolicyInput,
  Resource,
} from "@ai-office/domain/capability/capability.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import {
  CanonicalSerializationError,
  InvalidCapabilityConstraintsError,
  InvalidActionTimestampError,
  InvalidActionTransitionError,
} from "@ai-office/domain/capability/errors.ts";
import { PolicyEngine } from "@ai-office/domain/capability/policy-engine.ts";
import { validateFakeConnectorConstraints } from "@ai-office/domain/capability/fake-connector-policy.ts";

const now = new Date("2026-08-05T12:00:00.000Z");
const resource = (overrides: Partial<Resource> = {}): Resource => ({
  id: "resource-1",
  projectId: "project-1",
  type: "filesystem_scope",
  provider: "fake",
  displayName: "Fake",
  configuration: {},
  status: "active",
  createdAt: now,
  updatedAt: now,
  ...overrides,
});
const grant = (overrides: Partial<CapabilityGrant> = {}): CapabilityGrant => ({
  id: "grant-1",
  projectId: "project-1",
  principalType: "agent",
  principalId: "agent-1",
  resourceId: "resource-1",
  actions: ["fake.read"],
  constraints: {},
  validFrom: new Date("2026-08-01T00:00:00.000Z"),
  grantedBy: "owner",
  reason: "test",
  createdAt: now,
  ...overrides,
});
const input = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  projectId: "project-1",
  agentId: "agent-1",
  roleIds: ["role-1"],
  resource: resource(),
  operation: "fake.read",
  arguments: { target: "docs/readme.md" },
  grants: [],
  ...overrides,
});

describe("capability policy", () => {
  const engine = new PolicyEngine();

  test("denies by default and permits a valid agent grant", () => {
    expect(engine.evaluate(input(), now).decision).toBe("deny");
    const decision = engine.evaluate(input({ grants: [grant()] }), now);
    expect(decision.decision).toBe("allow");
    expect(decision.matchedGrantIds).toEqual(["grant-1"]);
  });

  test("ignores future-dated, expired, and revoked grants at exact boundaries", () => {
    expect(
      engine.evaluate(
        input({
          grants: [grant({ validFrom: new Date("2026-08-05T12:00:00.001Z") })],
        }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(input({ grants: [grant({ expiresAt: now })] }), now)
        .decision,
    ).toBe("deny");
    expect(
      engine.evaluate(input({ grants: [grant({ revokedAt: now })] }), now)
        .decision,
    ).toBe("deny");
  });

  test("denies disabled and cross-project resources", () => {
    expect(
      engine.evaluate(
        input({
          resource: resource({ status: "disabled" }),
          grants: [grant()],
        }),
        now,
      ).reasons,
    ).toContain("resource is disabled");
    expect(
      engine.evaluate(
        input({ resource: resource({ projectId: "project-2" }) }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(
        input({
          resource: resource({ id: "resource-2" }),
          grants: [grant({ resourceId: "resource-1" })],
        }),
        now,
      ).decision,
    ).toBe("deny");
  });

  test("matches persisted role grants and ignores unrelated principals", () => {
    const roleGrant = grant({ principalType: "role", principalId: "role-1" });
    expect(engine.evaluate(input({ grants: [roleGrant] }), now).decision).toBe(
      "allow",
    );
    expect(
      engine.evaluate(
        input({ grants: [grant({ principalId: "agent-2" })] }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(
        input({ grants: [grant({ projectId: "project-2" })] }),
        now,
      ).decision,
    ).toBe("deny");
    const mixed = engine.evaluate(
      input({
        grants: [
          grant({ id: "matching" }),
          grant({ id: "other-agent", principalId: "agent-2" }),
          grant({ id: "other-project", projectId: "project-2" }),
        ],
      }),
      now,
    );
    expect(mixed.matchedGrantIds).toEqual(["matching"]);
  });

  test("supports connector wildcards but requires an exact critical grant", () => {
    const wildcard = grant({
      actions: ["fake.*"],
      constraints: { allowMutation: true },
    });
    expect(
      engine.evaluate(
        input({ operation: "fake.write", grants: [wildcard] }),
        now,
      ).decision,
    ).toBe("allow_simulation_only");
    expect(
      engine.evaluate(
        input({ operation: "fake.admin", grants: [wildcard] }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(
        input({
          operation: "fake.admin",
          grants: [
            grant({
              actions: ["fake.admin"],
              constraints: { allowMutation: true },
            }),
          ],
        }),
        now,
      ).decision,
    ).toBe("allow_with_approval");
    for (const unsafe of ["fake.*evil", "*read", "fake.r*", "fake.read*"]) {
      expect(
        engine.evaluate(input({ grants: [grant({ actions: [unsafe] })] }), now)
          .decision,
      ).toBe("deny");
    }
    expect(
      engine.evaluate(input({ grants: [grant({ actions: [] })] }), now)
        .decision,
    ).toBe("deny");
  });

  test("intersects allow lists, unions deny lists, minimizes maxima, and ANDs mutation", () => {
    const first = grant({
      id: "a",
      actions: ["fake.write"],
      constraints: {
        allowedTargets: ["a", "b"],
        deniedTargets: ["x"],
        maxPayloadBytes: 1000,
        allowMutation: true,
      },
    });
    const second = grant({
      id: "b",
      actions: ["fake.write"],
      constraints: {
        allowedTargets: ["b", "c"],
        deniedTargets: ["y"],
        maxPayloadBytes: 500,
        allowMutation: true,
      },
    });
    const decision = engine.evaluate(
      input({
        operation: "fake.write",
        arguments: { target: "b" },
        grants: [first, second],
      }),
      now,
    );
    expect(decision.decision).toBe("allow_simulation_only");
    expect(decision.effectiveConstraints).toEqual({
      allowedTargets: ["b"],
      deniedTargets: ["x", "y"],
      maxPayloadBytes: 500,
      allowMutation: true,
    });
  });

  test("combines three grants deterministically and treats absent fields restrictively", () => {
    const grants = [
      grant({
        id: "c",
        actions: ["fake.write"],
        constraints: {
          allowedTargets: ["b", "a", "b"],
          deniedTargets: ["x", "x"],
          maxPayloadBytes: 900,
          allowMutation: true,
        },
      }),
      grant({
        id: "a",
        actions: ["fake.write"],
        constraints: {
          allowedTargets: ["a", "b", "c"],
          deniedTargets: ["y"],
          maxPayloadBytes: 700,
          allowMutation: true,
        },
      }),
      grant({
        id: "b",
        actions: ["fake.write"],
        constraints: {
          deniedTargets: ["z"],
          maxPayloadBytes: 800,
          allowMutation: true,
        },
      }),
    ];
    const decision = engine.evaluate(
      input({
        operation: "fake.write",
        arguments: { target: "a" },
        grants,
      }),
      now,
    );
    expect(decision).toMatchObject({
      decision: "allow_simulation_only",
      matchedGrantIds: ["a", "b", "c"],
      effectiveConstraints: {
        allowedTargets: ["a", "b"],
        deniedTargets: ["x", "y", "z"],
        maxPayloadBytes: 700,
        allowMutation: true,
      },
    });
    const missingFlag = grant({
      id: "missing-flag",
      actions: ["fake.write"],
      constraints: {},
    });
    expect(
      engine.evaluate(
        input({
          operation: "fake.write",
          arguments: { target: "a" },
          grants: [...grants, missingFlag],
        }),
        now,
      ).decision,
    ).toBe("deny");
  });

  test("denies unsafe or failing constraint combinations", () => {
    expect(() =>
      validateFakeConnectorConstraints({ inventedPermission: true }),
    ).toThrow(InvalidCapabilityConstraintsError);
    expect(
      engine.evaluate(
        input({
          grants: [grant({ constraints: { inventedPermission: true } })],
        }),
        now,
      ).decision,
    ).toBe("deny");
    for (const invalid of [-1, 1.5, "100"]) {
      expect(
        engine.evaluate(
          input({
            grants: [grant({ constraints: { maxPayloadBytes: invalid } })],
          }),
          now,
        ).decision,
      ).toBe("deny");
    }
    expect(
      engine.evaluate(
        input({
          grants: [
            grant({
              constraints: {
                allowedTargets: [],
                deniedTargets: ["docs/readme.md"],
              },
            }),
          ],
        }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(
        input({
          grants: [grant({ constraints: { allowedTargets: ["other"] } })],
        }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(
        input({
          operation: "fake.write",
          grants: [grant({ actions: ["fake.write"] })],
        }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(
        input({
          arguments: { target: undefined },
          grants: [grant()],
        }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(
        input({
          arguments: { target: "same" },
          grants: [
            grant({
              constraints: {
                allowedTargets: ["same"],
                deniedTargets: ["same"],
              },
            }),
          ],
        }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(
        input({
          arguments: {},
          grants: [grant({ constraints: { maxPayloadBytes: 2 } })],
        }),
        now,
      ).decision,
    ).toBe("allow");
    expect(
      engine.evaluate(
        input({
          arguments: {},
          grants: [grant({ constraints: { maxPayloadBytes: 1 } })],
        }),
        now,
      ).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(
        input({
          grants: [grant({ constraints: { allowedTargets: "readme" } })],
        }),
        now,
      ).decision,
    ).toBe("deny");
  });

  test("classifies risk deterministically without allowing grants to lower it", () => {
    const mutation = (operation: string) =>
      engine.evaluate(
        input({
          operation,
          grants: [
            grant({
              actions: [operation],
              constraints: { allowMutation: true },
            }),
          ],
        }),
        now,
      );
    expect(mutation("fake.write")).toMatchObject({
      decision: "allow_simulation_only",
      riskLevel: "medium",
    });
    expect(mutation("fake.delete")).toMatchObject({
      decision: "allow_with_approval",
      riskLevel: "high",
    });
    expect(mutation("fake.admin")).toMatchObject({
      decision: "allow_with_approval",
      riskLevel: "critical",
    });
    expect(
      engine.evaluate(
        input({
          operation: "fake.read",
          arguments: { target: "x", riskLevel: "critical" },
          grants: [grant()],
        }),
        now,
      ),
    ).toMatchObject({ decision: "allow", riskLevel: "low" });
    expect(
      engine.evaluate(
        input({
          operation: "fake.unknown",
          grants: [grant({ actions: ["fake.*"] })],
        }),
        now,
      ),
    ).toMatchObject({
      decision: "deny",
      reasons: ["unsupported operation: fake.unknown"],
    });
  });
});

describe("action lifecycle and canonical payload", () => {
  const request = () =>
    ActionRequest.create({
      id: "action-1",
      projectId: "project-1",
      agentId: "agent-1",
      resourceId: "resource-1",
      connector: "fake",
      connectorVersion: "1",
      operation: "fake.write",
      normalizedArguments: { target: "a" },
      effectiveConstraints: { allowMutation: true },
      payloadHash: "a".repeat(64),
      decision: "allow_simulation_only",
      riskLevel: "medium",
      matchedGrantIds: ["grant-1"],
      reasons: ["simulation is required"],
      now,
    });

  test("enforces the M6A state machine with typed errors", () => {
    const action = request();
    const authorizedAt = new Date(now.getTime() + 1);
    action.transition("authorized", authorizedAt);
    action.transition("simulating", new Date(now.getTime() + 2));
    action.transition("simulated", new Date(now.getTime() + 3));
    action.transition("approval_pending", new Date(now.getTime() + 4));
    expect(action.snapshot().status).toBe("approval_pending");
    expect(action.snapshot().updatedAt).toEqual(new Date(now.getTime() + 4));
    expect(() => request().transition("completed", now)).toThrow(
      InvalidActionTransitionError,
    );
    const denied = request();
    denied.transition("denied", authorizedAt);
    expect(() => denied.transition("authorized", authorizedAt)).toThrow(
      InvalidActionTransitionError,
    );
    expect(() =>
      request().transition("authorized", new Date(now.getTime() - 1)),
    ).toThrow(InvalidActionTimestampError);
    for (const status of [
      "denied",
      "approval_pending",
      "approved",
      "rejected",
      "executing",
      "completed",
      "failed",
      "cancelled",
      "expired",
    ] as const) {
      const terminal = ActionRequest.restore({
        ...request().snapshot(),
        status,
      });
      expect(() => terminal.transition("authorized", authorizedAt)).toThrow(
        InvalidActionTransitionError,
      );
    }
  });

  test("serializes semantic equals identically and distinguishes absence from null", () => {
    expect(canonicalStringify({ b: 2, a: { y: 1, x: null } })).toBe(
      canonicalStringify({ a: { x: null, y: 1 }, b: 2 }),
    );
    expect(canonicalStringify({})).not.toBe(
      canonicalStringify({ value: null }),
    );
    expect(canonicalStringify({ items: [1, 2] })).not.toBe(
      canonicalStringify({ items: [2, 1] }),
    );
    expect(canonicalStringify({ outer: { z: { b: 2, a: 1 }, a: 0 } })).toBe(
      canonicalStringify({ outer: { a: 0, z: { a: 1, b: 2 } } }),
    );
    expect(() => canonicalStringify({ value: undefined })).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify([undefined])).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify(new Array(1))).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify({ value: Number.NaN })).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify({ value: Infinity })).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify({ value: -Infinity })).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify({ value: () => 1 })).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify({ value: Symbol("x") })).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify({ value: 1n })).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify({ value: new Map() })).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify({ value: new Set() })).toThrow(
      CanonicalSerializationError,
    );
    class Unsupported {}
    expect(() => canonicalStringify({ value: new Unsupported() })).toThrow(
      CanonicalSerializationError,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalStringify(cyclic)).toThrow(
      CanonicalSerializationError,
    );
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => Date.now(),
    });
    expect(() => canonicalStringify(accessor)).toThrow(
      CanonicalSerializationError,
    );
    const hidden = Object.defineProperty({}, "value", {
      enumerable: false,
      value: "hidden",
    });
    expect(() => canonicalStringify(hidden)).toThrow(
      CanonicalSerializationError,
    );
    const augmented = [1] as number[] & { extra?: string };
    augmented.extra = "not JSON array data";
    expect(() => canonicalStringify(augmented)).toThrow(
      CanonicalSerializationError,
    );
    expect(() => canonicalStringify({ [Symbol("key")]: "value" })).toThrow(
      CanonicalSerializationError,
    );
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => canonicalStringify(JSON.parse(`{"${key}":true}`))).toThrow(
        CanonicalSerializationError,
      );
    }
  });

  test("hashes all authorization-relevant payload fields", () => {
    const base = request().canonicalPayload();
    const hash = hashCanonicalActionPayload(base).hash;
    expect(hash).toHaveLength(64);
    expect(
      hashCanonicalActionPayload({
        ...base,
        normalizedArguments: { target: "a" },
      }).hash,
    ).toBe(hash);
    expect(
      hashCanonicalActionPayload({ ...base, operation: "fake.delete" }).hash,
    ).not.toBe(hash);
    expect(
      hashCanonicalActionPayload({ ...base, projectId: "other" }).hash,
    ).not.toBe(hash);
    expect(
      hashCanonicalActionPayload({ ...base, agentId: "other" }).hash,
    ).not.toBe(hash);
    expect(
      hashCanonicalActionPayload({ ...base, resourceId: "other" }).hash,
    ).not.toBe(hash);
    expect(
      hashCanonicalActionPayload({ ...base, connector: "other" }).hash,
    ).not.toBe(hash);
    expect(
      hashCanonicalActionPayload({ ...base, connectorVersion: "2" }).hash,
    ).not.toBe(hash);
    expect(
      hashCanonicalActionPayload({
        ...base,
        normalizedArguments: { target: "b" },
      }).hash,
    ).not.toBe(hash);
    expect(
      hashCanonicalActionPayload({
        ...base,
        effectiveConstraints: { allowMutation: false },
      }).hash,
    ).not.toBe(hash);
  });
});

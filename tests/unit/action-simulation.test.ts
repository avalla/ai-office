import { describe, expect, test } from "vitest";
import {
  hashActionSimulationArtifact,
  sha256Text,
} from "@ai-office/application/capability/action-simulation-hash.ts";
import { ActionSimulation } from "@ai-office/domain/capability/action-simulation.ts";
import { CapabilityValidationError } from "@ai-office/domain/capability/errors.ts";

const authorizationPayloadHash = "a".repeat(64);
const diffSha256 = sha256Text("diff");
const payload = {
  schemaVersion: 1 as const,
  actionRequestId: "action-1",
  authorizationPayloadHash,
  connector: "filesystem",
  connectorVersion: "1",
  operation: "filesystem.write",
  preconditions: [
    {
      kind: "file" as const,
      path: "src/a.txt",
      sha256: "b".repeat(64),
      size: 3,
    },
  ],
  diffSha256,
};

describe("action simulation artifacts", () => {
  test("hashes deterministically and separately from authorization", () => {
    const first = hashActionSimulationArtifact(payload);
    const second = hashActionSimulationArtifact({
      ...payload,
      preconditions: [
        {
          size: 3,
          sha256: "b".repeat(64),
          path: "src/a.txt",
          kind: "file",
        },
      ],
    });
    expect(first).toBe(second);
    expect(first).not.toBe(authorizationPayloadHash);
    expect(
      hashActionSimulationArtifact({ ...payload, connectorVersion: "2" }),
    ).not.toBe(first);
    expect(
      hashActionSimulationArtifact({
        ...payload,
        preconditions: [{ kind: "absent", path: "src/a.txt" }],
      }),
    ).not.toBe(first);
  });

  test("validates file preconditions at runtime", () => {
    const base = {
      id: "simulation-1",
      projectId: "project-1",
      actionRequestId: "action-1",
      authorizationPayloadHash,
      connector: "filesystem",
      connectorVersion: "1",
      operation: "filesystem.write",
      diff: "diff",
      diffSha256,
      artifactSha256: hashActionSimulationArtifact(payload),
      createdAt: new Date("2026-08-06T00:00:00.000Z"),
    };
    expect(
      ActionSimulation.create({
        ...base,
        preconditions: payload.preconditions,
      }).snapshot().preconditions,
    ).toEqual(payload.preconditions);
    expect(() =>
      ActionSimulation.create({
        ...base,
        preconditions: [
          {
            kind: "file",
            path: "src/a.txt",
            sha256: "invalid",
            size: -1,
          },
        ],
      }),
    ).toThrow(CapabilityValidationError);
  });

  test.each([
    [
      {
        kind: "file" as const,
        path: "src/a.txt",
        sha256: "b".repeat(64),
        size: 1,
      },
      {
        kind: "file" as const,
        path: "src/a.txt",
        sha256: "c".repeat(64),
        size: 2,
      },
    ],
    [
      { kind: "absent" as const, path: "src/a.txt" },
      { kind: "absent" as const, path: "src/a.txt" },
    ],
    [
      {
        kind: "file" as const,
        path: "src/a.txt",
        sha256: "b".repeat(64),
        size: 1,
      },
      { kind: "absent" as const, path: "src/a.txt" },
    ],
  ])(
    "rejects contradictory preconditions sharing one path",
    (...preconditions) => {
      expect(() =>
        ActionSimulation.create({
          id: "simulation-contradictory",
          projectId: "project-1",
          actionRequestId: "action-1",
          authorizationPayloadHash,
          connector: "filesystem",
          connectorVersion: "1",
          operation: "filesystem.write",
          preconditions,
          diff: "diff",
          diffSha256,
          artifactSha256: hashActionSimulationArtifact(payload),
          createdAt: new Date("2026-08-06T00:00:00.000Z"),
        }),
      ).toThrow("contradict for the same path");
    },
  );
});

import { describe, expect, test } from "vitest";
import { resolveProjectConfiguration } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import { verifyDomainPackManifest } from "../../packages/domain-pack-contracts/src/index.ts";
import {
  developmentPackBytes,
  developmentPackId,
  testCatalogWith,
} from "../helpers/development-pack-parity.ts";

const identity = (kind: string, localId: string) =>
  `pack:${developmentPackId}/${kind}/${localId}`;

function resolve(withFilesystem: boolean) {
  const { catalog, pack } = testCatalogWith(developmentPackBytes());
  return resolveProjectConfiguration({
    projectId: "development-declarations",
    binding: {
      projectId: "development-declarations",
      configurationRevision: 1,
      packs: [pack],
    },
    definitions: {
      projectId: "development-declarations",
      revision: 0,
      owned: [],
      overrides: [],
    },
    catalog,
    coreContractVersion: catalog.coreContractVersion,
    providers: {
      list: () =>
        withFilesystem
          ? [
              {
                id: "filesystem",
                version: "2",
                operations: [
                  { operation: "filesystem.list", mode: "read" as const },
                  { operation: "filesystem.read", mode: "read" as const },
                  { operation: "filesystem.search", mode: "read" as const },
                  { operation: "filesystem.write", mode: "mutation" as const },
                ],
              },
            ]
          : [],
    },
  });
}

describe("GP-10C-1 development reference declarations", () => {
  test("the committed manifest declares five closed artifact/evidence pairs and agent knowledge guidance", () => {
    const { contributions } = verifyDomainPackManifest(developmentPackBytes());
    expect(contributions.artifactTypes.map(({ id }) => id)).toEqual([
      "repository-state",
      "github-reference",
      "commit",
      "pull-request",
      "ci-result",
    ]);
    expect(
      contributions.evidenceTypes.map(({ id, subject }) => [id, subject]),
    ).toEqual([
      ["repository-context", "repository-state"],
      ["github-context", "github-reference"],
      ["commit-provenance", "commit"],
      ["pull-request-review", "pull-request"],
      ["ci-verification", "ci-result"],
    ]);
    for (const artifact of contributions.artifactTypes) {
      expect(artifact.contentSchema?.type).toBe("object");
      expect(artifact.maximumBytes).toBe(65536);
    }
    for (const evidence of contributions.evidenceTypes)
      expect(evidence.payloadSchema?.type).toBe("object");
    expect(contributions.knowledge).toMatchObject([
      {
        id: "repository-context",
        category: "repository_context",
        retrieval: { maxResults: 5 },
      },
    ]);
    for (const agent of contributions.agents)
      expect(agent.knowledge).toEqual(["repository-context"]);
    expect(contributions.validators).toEqual([]);
  });

  test("a test-supplied catalog resolves the views with optional provider bindings", () => {
    const unbound = resolve(false);
    const bound = resolve(true);
    expect(bound.artifactTypes.map(({ definitionId }) => definitionId)).toEqual(
      [
        identity("artifactTypes", "ci-result"),
        identity("artifactTypes", "commit"),
        identity("artifactTypes", "github-reference"),
        identity("artifactTypes", "pull-request"),
        identity("artifactTypes", "repository-state"),
      ],
    );
    expect(bound.evidenceTypes).toHaveLength(5);
    expect(bound.knowledge.map(({ knowledgeId }) => knowledgeId)).toEqual([
      identity("knowledge", "repository-context"),
    ]);
    expect(bound.capabilities).toHaveLength(14);
    const declared = bound.capabilities.filter(
      ({ operations }) => operations.length > 0,
    );
    expect(declared.map(({ capabilityId }) => capabilityId)).toEqual(
      [
        "create_patch",
        "inspect_code",
        "inspect_project",
        "inspect_tests",
        "modify_code",
      ].map((id) => identity("capabilities", id)),
    );
    for (const capability of declared) {
      expect(capability.requirement).toBe("optional");
      expect(
        capability.operations.every(({ binding }) => binding === "bound"),
      ).toBe(true);
    }
    for (const capability of unbound.capabilities.filter(
      ({ operations }) => operations.length > 0,
    ))
      expect(
        capability.operations.every(
          ({ binding }) => binding === "unbound_optional",
        ),
      ).toBe(true);
    expect(bound.configurationDigest).toBe(unbound.configurationDigest);
  });
});

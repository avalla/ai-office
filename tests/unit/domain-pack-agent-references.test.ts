import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DomainPackManifestError,
  canonicalizeDomainPackManifest,
  computeManifestDigest,
  contributionKinds,
  maximumContributionReferences,
  parseDomainPackManifest,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const placeholder = `sha256:${"0".repeat(64)}`;

function manifest(
  contributions: Record<string, unknown[]> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "org.example.custom",
    version: "1.0.0",
    manifestDigest: placeholder,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: "Custom", description: "Contract fixture" },
    dependencies: [],
    contributions: {
      ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
      ...contributions,
    },
  };
}

const bytes = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

function failure(value: unknown): { code: string; path: string } {
  try {
    parseDomainPackManifest(bytes(value));
  } catch (error) {
    expect(error).toBeInstanceOf(DomainPackManifestError);
    const { code, path } = error as DomainPackManifestError;
    return { code, path };
  }
  throw new Error("Expected manifest rejection");
}

// counsel declares draft and review; clerk declares nothing.
const base = {
  roles: [
    { id: "counsel", capabilities: ["draft", "review"] },
    { id: "clerk" },
  ],
  prompts: [{ id: "brief" }, { id: "style" }, { id: "tone" }],
  knowledge: [{ id: "precedents" }, { id: "statutes" }],
  capabilities: [{ id: "draft" }, { id: "file" }, { id: "review" }],
};

const withAgent = (agent: object, sections: Record<string, unknown[]> = {}) =>
  manifest({ ...base, ...sections, agents: [agent] });

describe("GP-12 agent references in the schema-1 manifest", () => {
  test("an agent may name a role, prompts, knowledge and requested capabilities of the same manifest", () => {
    const parsed = parseDomainPackManifest(
      bytes(
        manifest({
          ...base,
          agents: [
            {
              id: "drafter",
              title: "Drafter",
              role: "counsel",
              prompts: ["brief"],
              knowledge: ["statutes"],
              capabilities: ["draft"],
            },
            { id: "filer", role: "clerk" },
            { id: "plain" },
          ],
        }),
      ),
    );
    expect(parsed.contributions.agents).toEqual([
      {
        id: "drafter",
        title: "Drafter",
        role: "counsel",
        prompts: ["brief"],
        knowledge: ["statutes"],
        capabilities: ["draft"],
      },
      { id: "filer", role: "clerk" },
      { id: "plain" },
    ]);
    // Absent fields stay absent: there is no second "empty" encoding.
    for (const field of ["role", "prompts", "knowledge", "capabilities"])
      expect(Object.hasOwn(parsed.contributions.agents[2]!, field)).toBe(false);
  });

  test("each list is in ascending code-unit order and the digest ignores the written order", () => {
    const written = (
      prompts: string[],
      knowledge: string[],
      capabilities: string[],
    ) =>
      parseDomainPackManifest(
        bytes(
          withAgent({
            id: "drafter",
            role: "counsel",
            prompts,
            knowledge,
            capabilities,
          }),
        ),
      );
    const ascending = written(
      ["brief", "style", "tone"],
      ["precedents", "statutes"],
      ["draft", "review"],
    );
    const shuffled = written(
      ["tone", "brief", "style"],
      ["statutes", "precedents"],
      ["review", "draft"],
    );
    expect(shuffled.contributions.agents[0]).toEqual({
      id: "drafter",
      role: "counsel",
      prompts: ["brief", "style", "tone"],
      knowledge: ["precedents", "statutes"],
      capabilities: ["draft", "review"],
    });
    expect(computeManifestDigest(shuffled)).toBe(
      computeManifestDigest(ascending),
    );
    expect(decoder.decode(canonicalizeDomainPackManifest(shuffled))).toBe(
      decoder.decode(canonicalizeDomainPackManifest(ascending)),
    );
    // Uppercase sorts before lowercase: code units, not a locale.
    expect(
      parseDomainPackManifest(
        bytes(
          withAgent(
            { id: "drafter", prompts: ["b", "B", "a"] },
            { prompts: [{ id: "a" }, { id: "b" }, { id: "B" }] },
          ),
        ),
      ).contributions.agents[0],
    ).toEqual({ id: "drafter", prompts: ["B", "a", "b"] });
  });

  test("every reference field is part of the manifest digest", () => {
    const digest = (agent: object) =>
      computeManifestDigest(parseDomainPackManifest(bytes(withAgent(agent))));
    const digests = [
      digest({ id: "drafter" }),
      digest({ id: "drafter", role: "counsel" }),
      digest({ id: "drafter", role: "clerk" }),
      digest({ id: "drafter", prompts: ["brief"] }),
      digest({ id: "drafter", prompts: ["brief", "tone"] }),
      digest({ id: "drafter", knowledge: ["statutes"] }),
      digest({ id: "drafter", role: "counsel", capabilities: ["draft"] }),
      digest({
        id: "drafter",
        role: "counsel",
        capabilities: ["draft", "review"],
      }),
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });

  test("manifests that omit the fields keep their golden digests and canonical bytes", () => {
    const golden = {
      custom:
        "sha256:6da016cf854774724029e2753f91b49353d6fbb9a74e965fb3ad2ee4e7e0aaf3",
      development:
        "sha256:26b71333f202563bf5f1f8e377c68500f3a01fd8638305b2d1e06bff659dae8f",
      legal:
        "sha256:1a3339f5faeb8558db8fe20e31cacf98d900c0e7e4ebe67f8672983095b35b77",
      manufacturing:
        "sha256:a6f991dcd8af725d15143a42ee605ba95a8470dc127fd2be4d3955ce03bbd583",
    };
    for (const name of Object.keys(golden) as (keyof typeof golden)[]) {
      const file = readFileSync(
        new URL(`../fixtures/domain-pack/${name}.json`, import.meta.url),
      );
      const verified = verifyDomainPackManifest(file, 1);
      expect(computeManifestDigest(verified)).toBe(golden[name]);
      // No agent of a golden fixture carries a reference field.
      for (const agent of verified.contributions.agents)
        expect(Object.keys(agent).sort()).toEqual(
          Object.keys(agent)
            .filter((key) => ["id", "title", "description"].includes(key))
            .sort(),
        );
    }
    // A manifest with descriptive agents only keeps its pre-GP-12 digest.
    expect(
      computeManifestDigest(
        parseDomainPackManifest(
          bytes(
            manifest({
              ...base,
              agents: [{ id: "drafter", title: "Drafter" }, { id: "reviewer" }],
            }),
          ),
        ),
      ),
    ).toBe(
      "sha256:b4b14c6f593987f475d75ce663d0069d77bb8add80bb8cee7b30d145cad9a8fa",
    );
  });

  test.each([
    ["a non-string role", { role: 7 }, "role"],
    ["a null role", { role: null }, "role"],
    ["an array role", { role: ["counsel"] }, "role"],
    ["a malformed role ID", { role: "not a local id" }, "role"],
    [
      "a qualified cross-pack style role",
      { role: "org.example.other/roles/counsel" },
      "role",
    ],
    ["an undeclared role", { role: "partner" }, "role"],
    ["a non-array prompt list", { prompts: "brief" }, "prompts"],
    ["an object prompt list", { prompts: { brief: true } }, "prompts"],
    ["a null prompt list", { prompts: null }, "prompts"],
    ["an empty prompt list", { prompts: [] }, "prompts"],
    ["a duplicate prompt", { prompts: ["brief", "tone", "brief"] }, "prompts"],
    ["a malformed prompt ID", { prompts: ["brief", "no id"] }, "prompts[1]"],
    ["a non-string prompt", { prompts: ["brief", 7] }, "prompts[1]"],
    ["an undeclared prompt", { prompts: ["brief", "closing"] }, "prompts[1]"],
    ["a non-array knowledge list", { knowledge: "statutes" }, "knowledge"],
    ["an empty knowledge list", { knowledge: [] }, "knowledge"],
    [
      "a duplicate knowledge entry",
      { knowledge: ["statutes", "statutes"] },
      "knowledge",
    ],
    [
      "a malformed knowledge ID",
      { knowledge: ["statutes", ""] },
      "knowledge[1]",
    ],
    [
      "an undeclared knowledge entry",
      { knowledge: ["treaties"] },
      "knowledge[0]",
    ],
    [
      "a non-array capability list",
      { role: "counsel", capabilities: "draft" },
      "capabilities",
    ],
    [
      "an empty capability list",
      { role: "counsel", capabilities: [] },
      "capabilities",
    ],
    [
      "a duplicate capability",
      { role: "counsel", capabilities: ["draft", "draft"] },
      "capabilities",
    ],
    [
      "a malformed capability ID",
      { role: "counsel", capabilities: ["draft", "no id"] },
      "capabilities[1]",
    ],
    [
      "an undeclared capability",
      { role: "counsel", capabilities: ["draft", "sign"] },
      "capabilities[1]",
    ],
    // The limit: a request needs a role and stays inside that role's set.
    [
      "capabilities without a role",
      { capabilities: ["draft"] },
      "capabilities",
    ],
    [
      "a capability the role does not declare",
      { role: "counsel", capabilities: ["draft", "file"] },
      "capabilities[1]",
    ],
    [
      "a capability requested from a role that declares none",
      { role: "clerk", capabilities: ["file"] },
      "capabilities[0]",
    ],
  ])("rejects %s with a typed code and path", (_label, fields, member) => {
    expect(failure(withAgent({ id: "drafter", ...fields }))).toEqual({
      code: "invalid_contribution",
      path: `contributions.agents[0].${member}`,
    });
  });

  test("a reference list holds at most 1,000 entries, for agents and for roles", () => {
    expect(maximumContributionReferences).toBe(1_000);
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `p${String(index).padStart(4, "0")}`,
      }));
    const names = (count: number) => ids(count).map((entry) => entry.id);
    const agentWith = (count: number) =>
      manifest({
        prompts: ids(1_001),
        agents: [{ id: "drafter", prompts: names(count) }],
      });
    expect(
      parseDomainPackManifest(bytes(agentWith(1_000))).contributions.agents[0]
        ?.prompts,
    ).toHaveLength(1_000);
    expect(failure(agentWith(1_001))).toEqual({
      code: "invalid_contribution",
      path: "contributions.agents[0].prompts",
    });
    const roleWith = (count: number) =>
      manifest({
        capabilities: ids(1_001),
        roles: [{ id: "counsel", capabilities: names(count) }],
      });
    expect(
      parseDomainPackManifest(bytes(roleWith(1_000))).contributions.roles[0]
        ?.capabilities,
    ).toHaveLength(1_000);
    expect(failure(roleWith(1_001))).toEqual({
      code: "invalid_contribution",
      path: "contributions.roles[0].capabilities",
    });
  });

  test("the path names the offending agent", () => {
    expect(
      failure(
        manifest({
          ...base,
          agents: [
            { id: "drafter", role: "counsel" },
            { id: "filer", role: "clerk", capabilities: ["file"] },
          ],
        }),
      ),
    ).toEqual({
      code: "invalid_contribution",
      path: "contributions.agents[1].capabilities[0]",
    });
  });

  test("definitions declared only in a dependency pack are unknown references", () => {
    const dependency = manifest(base);
    dependency.id = "org.example.base";
    const parsed = parseDomainPackManifest(bytes(dependency));
    const dependent = (agent: object) => {
      const value = manifest({ agents: [agent] });
      value.dependencies = [
        {
          id: parsed.id,
          version: parsed.version,
          manifestDigest: computeManifestDigest(parsed),
        },
      ];
      return value;
    };
    for (const [agent, member] of [
      [{ id: "drafter", role: "counsel" }, "role"],
      [{ id: "drafter", prompts: ["brief"] }, "prompts[0]"],
      [{ id: "drafter", knowledge: ["statutes"] }, "knowledge[0]"],
    ] as const)
      expect(failure(dependent(agent))).toEqual({
        code: "invalid_contribution",
        path: `contributions.agents[0].${member}`,
      });
  });

  test("the fields are unknown fields on every other contribution kind", () => {
    for (const kind of contributionKinds) {
      if (kind === "agents") continue;
      for (const [field, value] of [
        ["role", "counsel"],
        ["prompts", ["brief"]],
        ["knowledge", ["statutes"]],
        // A role's own `capabilities` is the GP-11 field.
        ...(kind === "roles" ? [] : [["capabilities", ["draft"]]]),
      ] as [string, unknown][]) {
        const item =
          kind === "workflows"
            ? { id: "w", taskType: "t", stages: [], [field]: value }
            : { id: "x", [field]: value };
        const sections: Record<string, unknown[]> = {
          ...base,
          taskTypes: [{ id: "t" }],
        };
        sections[kind] = [...(sections[kind] ?? []), item];
        const index = sections[kind].length - 1;
        expect(failure(manifest(sections)), `${kind}.${field}`).toEqual({
          code: "invalid_contribution",
          path: `contributions.${kind}[${index}].${field}`,
        });
      }
    }
  });
});

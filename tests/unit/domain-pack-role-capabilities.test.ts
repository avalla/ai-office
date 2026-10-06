import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DomainPackManifestError,
  canonicalizeDomainPackManifest,
  computeManifestDigest,
  contributionKinds,
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

const capabilities = [{ id: "draft" }, { id: "file" }, { id: "review" }];

describe("GP-11 role capability declarations in the schema-1 manifest", () => {
  test("a role may reference capabilities declared in the same manifest", () => {
    const parsed = parseDomainPackManifest(
      bytes(
        manifest({
          roles: [
            { id: "counsel", title: "Counsel", capabilities: ["review"] },
            { id: "clerk" },
          ],
          capabilities,
        }),
      ),
    );
    expect(parsed.contributions.roles).toEqual([
      { id: "counsel", title: "Counsel", capabilities: ["review"] },
      { id: "clerk" },
    ]);
    // An absent field stays absent: there is no second "empty" encoding.
    expect(Object.hasOwn(parsed.contributions.roles[1]!, "capabilities")).toBe(
      false,
    );
  });

  test("the validated set is in ascending code-unit order and the digest ignores the written order", () => {
    const written = (order: string[]) =>
      parseDomainPackManifest(
        bytes(
          manifest({
            roles: [{ id: "counsel", capabilities: order }],
            capabilities,
          }),
        ),
      );
    const ascending = written(["draft", "file", "review"]);
    const shuffled = written(["review", "draft", "file"]);
    expect(shuffled.contributions.roles[0]).toEqual({
      id: "counsel",
      capabilities: ["draft", "file", "review"],
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
          manifest({
            roles: [{ id: "counsel", capabilities: ["b", "B", "a"] }],
            capabilities: [{ id: "a" }, { id: "b" }, { id: "B" }],
          }),
        ),
      ).contributions.roles[0],
    ).toEqual({ id: "counsel", capabilities: ["B", "a", "b"] });
  });

  test("a different capability set is a different manifest digest", () => {
    const digest = (role: object) =>
      computeManifestDigest(
        parseDomainPackManifest(
          bytes(manifest({ roles: [role], capabilities })),
        ),
      );
    const none = digest({ id: "counsel" });
    const one = digest({ id: "counsel", capabilities: ["draft"] });
    const two = digest({ id: "counsel", capabilities: ["draft", "review"] });
    expect(new Set([none, one, two]).size).toBe(3);
  });

  test("manifests that omit the field keep their golden digests and canonical bytes", () => {
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
      const declared = (
        JSON.parse(decoder.decode(file)) as {
          manifestDigest: string;
        }
      ).manifestDigest;
      expect(declared).toBe(golden[name]);
      const verified = verifyDomainPackManifest(file, 1);
      expect(computeManifestDigest(verified)).toBe(golden[name]);
      expect(
        decoder.decode(canonicalizeDomainPackManifest(verified)),
      ).not.toContain('"capabilities":["');
    }
  });

  test.each([
    ["a non-array value", "review", "contributions.roles[0].capabilities"],
    [
      "an object value",
      { review: true },
      "contributions.roles[0].capabilities",
    ],
    ["null", null, "contributions.roles[0].capabilities"],
    ["an empty array", [], "contributions.roles[0].capabilities"],
    [
      "a duplicate entry",
      ["review", "draft", "review"],
      "contributions.roles[0].capabilities",
    ],
    [
      "a malformed local ID",
      ["draft", "not a local id"],
      "contributions.roles[0].capabilities[1]",
    ],
    [
      "a non-string entry",
      ["draft", 7],
      "contributions.roles[0].capabilities[1]",
    ],
    [
      "a qualified cross-pack style reference",
      ["org.example.other/capabilities/review"],
      "contributions.roles[0].capabilities[0]",
    ],
    [
      "an undeclared capability",
      ["draft", "sign"],
      "contributions.roles[0].capabilities[1]",
    ],
  ])("rejects %s with a typed code and path", (_label, value, path) => {
    expect(
      failure(
        manifest({
          roles: [{ id: "counsel", capabilities: value }],
          capabilities,
        }),
      ),
    ).toEqual({ code: "invalid_contribution", path });
  });

  test("a capability declared only in a dependency pack is an unknown reference", () => {
    const dependency = manifest({ capabilities: [{ id: "review" }] });
    dependency.id = "org.example.base";
    const base = parseDomainPackManifest(bytes(dependency));
    const dependent = manifest({
      roles: [{ id: "counsel", capabilities: ["review"] }],
    });
    dependent.dependencies = [
      {
        id: base.id,
        version: base.version,
        manifestDigest: computeManifestDigest(base),
      },
    ];
    expect(failure(dependent)).toEqual({
      code: "invalid_contribution",
      path: "contributions.roles[0].capabilities[0]",
    });
  });

  test("the field is an unknown field on every other contribution kind", () => {
    for (const kind of contributionKinds) {
      if (kind === "roles") continue;
      const item =
        kind === "workflows"
          ? { id: "w", taskType: "t", stages: [], capabilities: ["review"] }
          : { id: "x", capabilities: ["review"] };
      const sections: Record<string, unknown[]> = {
        capabilities: [{ id: "review" }],
        taskTypes: [{ id: "t" }],
      };
      sections[kind] = [...(sections[kind] ?? []), item];
      const index = sections[kind].length - 1;
      expect(failure(manifest(sections))).toEqual({
        code: "invalid_contribution",
        path: `contributions.${kind}[${index}].capabilities`,
      });
    }
  });
});

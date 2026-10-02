import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  DomainPackManifestError,
  canonicalizeDomainPackManifest,
  checkCoreContract,
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
  parseQualifiedContributionRef,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

const encoder = new TextEncoder();
const placeholder = `sha256:${"0".repeat(64)}`;
const sections = {
  roles: [],
  taskTypes: [],
  workflows: [],
  agents: [],
  artifactTypes: [],
  evidenceTypes: [],
  policies: [],
  knowledge: [],
  capabilities: [],
  prompts: [],
  validators: [],
};

function fixture(id = "org.example.custom"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    manifestDigest: placeholder,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: "Custom", description: "Contract fixture" },
    dependencies: [],
    contributions: structuredClone(sections),
  };
}

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function signed(value: Record<string, unknown>): Uint8Array {
  value.manifestDigest = computeManifestDigest(
    parseDomainPackManifest(bytes(value)),
  );
  return bytes(value);
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainPackManifestError);
    return (error as DomainPackManifestError).code;
  }
  throw new Error("expected manifest error");
}

describe("Domain Pack schema-1 contract", () => {
  test.each([
    [
      "development.json",
      "sha256:26b71333f202563bf5f1f8e377c68500f3a01fd8638305b2d1e06bff659dae8f",
    ],
    [
      "legal.json",
      "sha256:1a3339f5faeb8558db8fe20e31cacf98d900c0e7e4ebe67f8672983095b35b77",
    ],
    [
      "manufacturing.json",
      "sha256:a6f991dcd8af725d15143a42ee605ba95a8470dc127fd2be4d3955ce03bbd583",
    ],
    [
      "custom.json",
      "sha256:6da016cf854774724029e2753f91b49353d6fbb9a74e965fb3ad2ee4e7e0aaf3",
    ],
  ])("matches %s golden digest", (file, expected) => {
    const source = readFileSync(
      new URL(`../fixtures/domain-pack/${file}`, import.meta.url),
    );
    const manifest = verifyDomainPackManifest(source, 1);
    expect(manifest.manifestDigest).toBe(expected);
    expect(computeManifestDigest(manifest)).toBe(expected);
  });

  test.each([
    ["development", "org.ai-office.development", "reviewer"],
    ["legal", "org.example.legal", "counsel"],
    ["manufacturing", "org.example.manufacturing", "quality-lead"],
    ["minimal custom", "org.example.custom", ""],
  ])("accepts %s contract fixture", (_label, id, role) => {
    const value = fixture(id);
    if (role)
      (value.contributions as Record<string, unknown>).roles = [
        { id: role, title: role },
      ];
    const manifest = verifyDomainPackManifest(signed(value), 1);
    expect(manifest.id).toBe(id);
    expect(manifest.manifestDigest).toBe(computeManifestDigest(manifest));
  });

  test("rejects invalid identity, version, digest and unsupported schema", () => {
    expect(
      errorCode(() => parseDomainPackManifest(bytes({ schemaVersion: 2 }))),
    ).toBe("unsupported_schema");
    for (const [field, replacement, code] of [
      ["id", "Development", "invalid_identity"],
      ["version", "^1.0.0", "invalid_identity"],
      ["manifestDigest", "SHA256:abc", "invalid_identity"],
      ["schemaVersion", 2, "unsupported_schema"],
    ] as const) {
      const value = fixture();
      value[field] = replacement;
      expect(errorCode(() => parseDomainPackManifest(bytes(value)))).toBe(code);
    }
  });

  test("rejects malformed dependencies and duplicate contribution IDs", () => {
    const value = fixture();
    value.dependencies = [
      { id: "org.example.other", version: "1.x", manifestDigest: placeholder },
    ];
    expect(errorCode(() => parseDomainPackManifest(bytes(value)))).toBe(
      "invalid_dependency",
    );
    value.dependencies = [];
    (value.contributions as Record<string, unknown>).roles = [
      { id: "reviewer" },
      { id: "reviewer" },
    ];
    expect(errorCode(() => parseDomainPackManifest(bytes(value)))).toBe(
      "invalid_contribution",
    );
    (value.contributions as Record<string, unknown>).roles = [];
    value.dependencies = [
      {
        id: "org.example.other",
        version: "1.0.0",
        manifestDigest: placeholder,
      },
      {
        id: "org.example.other",
        version: "2.0.0",
        manifestDigest: placeholder,
      },
    ];
    expect(errorCode(() => parseDomainPackManifest(bytes(value)))).toBe(
      "invalid_dependency",
    );
  });

  test("rejects executable and unknown contribution fields", () => {
    const value = fixture();
    (value.contributions as Record<string, unknown>).validators = [
      { id: "check", command: "sh run.sh" },
    ];
    expect(errorCode(() => parseDomainPackManifest(bytes(value)))).toBe(
      "invalid_contribution",
    );
    value.script = "run.sh";
    expect(errorCode(() => parseDomainPackManifest(bytes(value)))).toBe(
      "malformed_input",
    );
  });

  test("rejects duplicate decoded keys, malformed UTF-8, BOM, and lone surrogates", () => {
    for (const source of [
      '{"id":1,"\\u0069d":2}',
      '{"a":{"x":1,"x":2}}',
      '"\\ud800"',
      '"\\q"',
      "1e400",
      "9007199254740993",
    ])
      expect(
        errorCode(() => parseDomainPackManifest(encoder.encode(source))),
      ).toBe("malformed_input");
    for (const bad of [
      new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      new Uint8Array([0xc3, 0x28]),
    ])
      expect(errorCode(() => parseDomainPackManifest(bad))).toBe(
        "malformed_input",
      );
  });

  test("rejects trailing content, controls, malformed collections and excessive nesting", () => {
    for (const source of [
      `${new TextDecoder().decode(signed(fixture()))} true`,
      '"raw\ncontrol"',
      '{"a":[1,]}',
      '{"a":1,}',
      "[1 2]",
      `${"[".repeat(129)}0${"]".repeat(129)}`,
    ])
      expect(
        errorCode(() => parseDomainPackManifest(encoder.encode(source))),
      ).toBe("malformed_input");
  });

  test("normalizes only declared unordered arrays and object keys", () => {
    const first = fixture();
    first.dependencies = [
      { id: "org.example.zed", version: "2.0.0", manifestDigest: placeholder },
      {
        id: "org.example.alpha",
        version: "1.0.0",
        manifestDigest: placeholder,
      },
    ];
    (first.contributions as Record<string, unknown>).roles = [
      { id: "zed" },
      { id: "alpha" },
    ];
    (first.contributions as Record<string, unknown>).workflows = [
      {
        id: "flow",
        taskType: "task",
        stages: [
          { id: "first", role: "alpha" },
          { id: "second", role: "zed" },
        ],
      },
    ];
    const second = structuredClone(first);
    second.dependencies = [...(first.dependencies as unknown[])].reverse();
    (second.contributions as Record<string, unknown>).roles = [
      ...((first.contributions as Record<string, unknown>).roles as unknown[]),
    ].reverse();
    second.metadata = { description: "Contract fixture", name: "Custom" };
    const a = parseDomainPackManifest(bytes(first));
    const b = parseDomainPackManifest(bytes(second));
    expect(computeManifestDigest(a)).toBe(computeManifestDigest(b));
    expect(canonicalizeDomainPackManifest(a)).toEqual(
      canonicalizeDomainPackManifest(b),
    );

    (
      (second.contributions as Record<string, unknown>).workflows as Array<
        Record<string, unknown>
      >
    )[0]!.stages = [
      ...((
        (first.contributions as Record<string, unknown>).workflows as Array<
          Record<string, unknown>
        >
      )[0]!.stages as unknown[]),
    ].reverse();
    expect(
      computeManifestDigest(parseDomainPackManifest(bytes(second))),
    ).not.toBe(computeManifestDigest(a));
  });

  test("content and dependencies affect identity; declared digest does not", () => {
    const value = fixture();
    const original = parseDomainPackManifest(bytes(value));
    const expected = computeManifestDigest(original);
    value.manifestDigest = `sha256:${"1".repeat(64)}`;
    expect(computeManifestDigest(parseDomainPackManifest(bytes(value)))).toBe(
      expected,
    );
    expect(errorCode(() => verifyDomainPackManifest(bytes(value)))).toBe(
      "digest_mismatch",
    );
    value.dependencies = [
      {
        id: "org.example.other",
        version: "1.0.0",
        manifestDigest: placeholder,
      },
    ];
    expect(
      computeManifestDigest(parseDomainPackManifest(bytes(value))),
    ).not.toBe(expected);
    const dependencyDigest = computeManifestDigest(
      parseDomainPackManifest(bytes(value)),
    );
    (value.dependencies as Array<Record<string, unknown>>)[0]!.version =
      "2.0.0";
    expect(
      computeManifestDigest(parseDomainPackManifest(bytes(value))),
    ).not.toBe(dependencyDigest);
    (value.dependencies as Array<Record<string, unknown>>)[0]!.version =
      "1.0.0";
    (value.dependencies as Array<Record<string, unknown>>)[0]!.manifestDigest =
      `sha256:${"2".repeat(64)}`;
    expect(
      computeManifestDigest(parseDomainPackManifest(bytes(value))),
    ).not.toBe(dependencyDigest);
    value.dependencies = [];
    (value.contributions as Record<string, unknown>).roles = [
      { id: "reviewer", title: "Reviewer" },
    ];
    expect(
      computeManifestDigest(parseDomainPackManifest(bytes(value))),
    ).not.toBe(expected);
    const contributionDigest = computeManifestDigest(
      parseDomainPackManifest(bytes(value)),
    );
    (
      (value.contributions as Record<string, unknown>).roles as Array<
        Record<string, unknown>
      >
    )[0]!.title = "Lead reviewer";
    expect(
      computeManifestDigest(parseDomainPackManifest(bytes(value))),
    ).not.toBe(contributionDigest);
  });

  test("checks core interval and qualified reference shape", () => {
    const manifest = verifyDomainPackManifest(signed(fixture()), 2);
    checkCoreContract(manifest.coreContract, 1);
    expect(errorCode(() => checkCoreContract(manifest.coreContract, 3))).toBe(
      "incompatible_core_contract",
    );
    expect(
      parseQualifiedContributionRef({
        pack: "org.example.custom",
        kind: "roles",
        id: "reviewer",
      }).id,
    ).toBe("reviewer");
    expect(
      errorCode(() =>
        parseQualifiedContributionRef({
          pack: "org.example.custom",
          kind: "unknown",
          id: "reviewer",
        }),
      ),
    ).toBe("invalid_identity");
    expect(
      errorCode(() =>
        parseQualifiedContributionRef({
          pack: "org.example.custom",
          kind: "roles",
          id: "bad id",
        }),
      ),
    ).toBe("invalid_identity");
    expect(
      errorCode(() =>
        parseQualifiedContributionRef({
          pack: "org.example.custom",
          kind: "roles",
          id: "reviewer",
          alias: "reviewer",
        }),
      ),
    ).toBe("invalid_identity");
  });

  test("artifact digest hashes exact source bytes", () => {
    const compact = signed(fixture());
    const spaced = encoder.encode(
      new TextDecoder().decode(compact).replace('"id":', '"id" :'),
    );
    expect(computeArtifactDigest(compact)).not.toBe(
      computeArtifactDigest(spaced),
    );
    expect(computeManifestDigest(parseDomainPackManifest(compact))).toBe(
      computeManifestDigest(parseDomainPackManifest(spaced)),
    );
  });
});

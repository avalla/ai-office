import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DomainPackManifestError,
  canonicalizeDomainPackManifest,
  computeManifestDigest,
  contributionKinds,
  maximumPolicyStageOperations,
  parseDomainPackManifest,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

// GP-25: the typed schema-1 policy contribution. A policy targets one
// workflow of its own manifest and declares enforcement and per-stage
// clauses. The contract package validates and canonicalizes it; nothing here
// enforces anything.

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
    metadata: { name: "Custom", description: "Policy contract fixture" },
    dependencies: [],
    contributions: {
      ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
      ...contributions,
    },
  };
}

const bytes = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

const base = {
  roles: [{ id: "author" }, { id: "reviewer" }],
  taskTypes: [{ id: "change" }],
  workflows: [
    {
      id: "delivery",
      taskType: "change",
      stages: [
        { id: "design", role: "author" },
        { id: "implement", role: "author" },
        { id: "review", role: "reviewer" },
      ],
    },
    {
      id: "hotfix",
      taskType: "change",
      stages: [{ id: "fix", role: "author" }],
    },
  ],
};

const withPolicies = (...policies: unknown[]) =>
  manifest({ ...base, policies });

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

const rejected = (policy: unknown, path: string) =>
  expect([path, failure(withPolicies(policy))]).toEqual([
    path,
    { code: "invalid_contribution", path },
  ]);

const fullPolicy = {
  id: "delivery-governance",
  title: "Delivery governance",
  description: "Approval and separation for delivery",
  workflow: "delivery",
  enforcement: "enforced",
  stages: [
    {
      stage: "design",
      operations: ["filesystem.read"],
    },
    {
      stage: "implement",
      requiresDifferentAgentFrom: ["design"],
      operations: ["filesystem.read", "filesystem.write", "git:commit"],
    },
    {
      stage: "review",
      requiresApproval: true,
      requiresIndependentApproval: true,
      requiresDifferentAgentFrom: ["design", "implement"],
    },
  ],
};

describe("GP-25 typed policy contributions in the schema-1 manifest", () => {
  test("a policy may target a workflow of the same manifest and declare enforcement and stage clauses", () => {
    const parsed = parseDomainPackManifest(
      bytes(
        withPolicies(fullPolicy, {
          id: "hotfix-approval",
          workflow: "hotfix",
          stages: [{ stage: "fix", requiresApproval: true }],
        }),
      ),
    );
    expect(parsed.contributions.policies).toEqual([
      fullPolicy,
      {
        id: "hotfix-approval",
        workflow: "hotfix",
        stages: [{ stage: "fix", requiresApproval: true }],
      },
    ]);
    // Absent facts stay absent: guidance, no approval, no operation.
    const hotfix = parsed.contributions.policies[1]!;
    expect(Object.hasOwn(hotfix, "enforcement")).toBe(false);
    expect(Object.keys(hotfix.stages![0]!).sort()).toEqual([
      "requiresApproval",
      "stage",
    ]);
  });

  test("enforcement alone and stages alone are each a complete typed policy", () => {
    const parsed = parseDomainPackManifest(
      bytes(
        withPolicies(
          { id: "enforced", workflow: "delivery", enforcement: "enforced" },
          {
            id: "stages",
            workflow: "hotfix",
            stages: [{ stage: "fix", operations: ["a"] }],
          },
        ),
      ),
    );
    expect(parsed.contributions.policies).toEqual([
      { id: "enforced", workflow: "delivery", enforcement: "enforced" },
      {
        id: "stages",
        workflow: "hotfix",
        stages: [{ stage: "fix", operations: ["a"] }],
      },
    ]);
  });

  test("an untyped policy still parses with its descriptive fields only", () => {
    const parsed = parseDomainPackManifest(
      bytes(withPolicies({ id: "plain", title: "Plain", description: "d" })),
    );
    expect(parsed.contributions.policies).toEqual([
      { id: "plain", title: "Plain", description: "d" },
    ]);
  });

  test("stages, operations and separation targets are sets: one validated order and one digest for every written order", () => {
    const shuffled = {
      ...fullPolicy,
      stages: [
        {
          stage: "review",
          requiresDifferentAgentFrom: ["implement", "design"],
          requiresIndependentApproval: true,
          requiresApproval: true,
        },
        {
          operations: ["git:commit", "filesystem.write", "filesystem.read"],
          requiresDifferentAgentFrom: ["design"],
          stage: "implement",
        },
        { operations: ["filesystem.read"], stage: "design" },
      ],
    };
    const ascending = parseDomainPackManifest(bytes(withPolicies(fullPolicy)));
    const written = parseDomainPackManifest(bytes(withPolicies(shuffled)));
    expect(written.contributions.policies).toEqual([fullPolicy]);
    expect(
      written.contributions.policies[0]!.stages!.map((entry) => entry.stage),
    ).toEqual(["design", "implement", "review"]);
    expect(computeManifestDigest(written)).toBe(
      computeManifestDigest(ascending),
    );
    expect(decoder.decode(canonicalizeDomainPackManifest(written))).toBe(
      decoder.decode(canonicalizeDomainPackManifest(ascending)),
    );
    // Code units, not a locale: uppercase stage IDs sort first.
    const cased = parseDomainPackManifest(
      bytes(
        manifest({
          ...base,
          workflows: [
            {
              id: "w",
              taskType: "change",
              stages: [
                { id: "b", role: "author" },
                { id: "B", role: "author" },
                { id: "a", role: "author" },
              ],
            },
          ],
          policies: [
            {
              id: "p",
              workflow: "w",
              stages: [
                { stage: "b", requiresApproval: true },
                { stage: "a", requiresDifferentAgentFrom: ["b", "B"] },
                { stage: "B", operations: ["z", "a.b", "a"] },
              ],
            },
          ],
        }),
      ),
    );
    expect(cased.contributions.policies[0]!.stages).toEqual([
      { stage: "B", operations: ["a", "a.b", "z"] },
      { stage: "a", requiresDifferentAgentFrom: ["B", "b"] },
      { stage: "b", requiresApproval: true },
    ]);
  });

  test("a different clause is a different manifest digest", () => {
    const digest = (policy: object) =>
      computeManifestDigest(
        parseDomainPackManifest(bytes(withPolicies(policy))),
      );
    const reference = digest(fullPolicy);
    const { enforcement: _enforcement, ...guidance } = fullPolicy;
    const variants = [
      guidance,
      { ...fullPolicy, stages: fullPolicy.stages.slice(0, 2) },
      {
        ...fullPolicy,
        stages: [
          fullPolicy.stages[0],
          fullPolicy.stages[1],
          { stage: "review", requiresApproval: true },
        ],
      },
      {
        ...fullPolicy,
        stages: [
          { stage: "design", operations: ["filesystem.write"] },
          ...fullPolicy.stages.slice(1),
        ],
      },
    ];
    const digests = variants.map(digest);
    expect(new Set([reference, ...digests]).size).toBe(variants.length + 1);
  });

  test("a manifest without a typed policy keeps its canonical form, and the golden fixtures still verify", () => {
    // The four fixtures verify against the digest each one declares; none of
    // them was edited for GP-25.
    for (const name of ["custom", "development", "legal", "manufacturing"]) {
      const fixture = readFileSync(
        new URL(`../fixtures/domain-pack/${name}.json`, import.meta.url),
      );
      const verified = verifyDomainPackManifest(fixture);
      expect(computeManifestDigest(verified)).toBe(verified.manifestDigest);
      expect(
        decoder.decode(canonicalizeDomainPackManifest(verified)),
      ).not.toMatch(
        /"workflow":|"enforcement"|"operations"|"requiresApproval"/,
      );
    }
    // An untyped policy has exactly the canonical members it had before.
    const untyped = parseDomainPackManifest(
      bytes(withPolicies({ id: "plain", title: "Plain" })),
    );
    expect(decoder.decode(canonicalizeDomainPackManifest(untyped))).toContain(
      '"policies":[{"id":"plain","title":"Plain"}]',
    );
  });

  test("the target workflow must be a workflow of the same manifest, governed by one policy only", () => {
    rejected(
      { id: "p", workflow: "missing", enforcement: "enforced" },
      "contributions.policies[0].workflow",
    );
    rejected(
      { id: "p", workflow: "not a local id", enforcement: "enforced" },
      "contributions.policies[0].workflow",
    );
    rejected(
      { id: "p", workflow: 7, enforcement: "enforced" },
      "contributions.policies[0].workflow",
    );
    // A role with the workflow's name is not a workflow.
    rejected(
      { id: "p", workflow: "author", enforcement: "enforced" },
      "contributions.policies[0].workflow",
    );
    expect(
      failure(
        withPolicies(
          { id: "first", workflow: "delivery", enforcement: "enforced" },
          { id: "other", workflow: "hotfix", enforcement: "enforced" },
          {
            id: "second",
            workflow: "delivery",
            stages: [{ stage: "review", requiresApproval: true }],
          },
        ),
      ),
    ).toEqual({
      code: "invalid_contribution",
      path: "contributions.policies[2].workflow",
    });
    // A workflow of a dependency is not a workflow of this manifest.
    const dependency = parseDomainPackManifest(
      bytes({ ...manifest(base), id: "org.example.base" }),
    );
    const dependent = manifest({
      policies: [{ id: "p", workflow: "delivery", enforcement: "enforced" }],
    });
    dependent.dependencies = [
      {
        id: dependency.id,
        version: dependency.version,
        manifestDigest: computeManifestDigest(dependency),
      },
    ];
    expect(failure(dependent)).toEqual({
      code: "invalid_contribution",
      path: "contributions.policies[0].workflow",
    });
  });

  test("a typed policy declares something, and clause fields need a workflow", () => {
    rejected({ id: "p", workflow: "delivery" }, "contributions.policies[0]");
    rejected(
      { id: "p", enforcement: "enforced" },
      "contributions.policies[0].workflow",
    );
    rejected(
      { id: "p", stages: [{ stage: "review", requiresApproval: true }] },
      "contributions.policies[0].workflow",
    );
  });

  test("enforcement has one value and flags are present only as true", () => {
    for (const enforcement of ["guidance", "Enforced", "", true, null, 1])
      rejected(
        { id: "p", workflow: "delivery", enforcement },
        "contributions.policies[0].enforcement",
      );
    for (const flag of ["requiresApproval", "requiresIndependentApproval"])
      for (const value of [false, "true", 1, null])
        rejected(
          {
            id: "p",
            workflow: "delivery",
            stages: [
              { stage: "review", requiresApproval: true, [flag]: value },
            ],
          },
          `contributions.policies[0].stages[0].${flag}`,
        );
  });

  test("stage entries name stages of the target workflow, once each, and carry at least one clause", () => {
    const stages = (value: unknown) => ({
      id: "p",
      workflow: "delivery",
      stages: value,
    });
    rejected(stages({}), "contributions.policies[0].stages");
    rejected(stages([]), "contributions.policies[0].stages");
    rejected(stages(["review"]), "contributions.policies[0].stages[0]");
    rejected(
      stages([{ stage: "review", requiresApproval: true, guard: "x" }]),
      "contributions.policies[0].stages[0].guard",
    );
    rejected(
      stages([{ requiresApproval: true }]),
      "contributions.policies[0].stages[0].stage",
    );
    rejected(
      stages([{ stage: "sign", requiresApproval: true }]),
      "contributions.policies[0].stages[0].stage",
    );
    // A stage of another workflow of the manifest is not a stage of this one.
    rejected(
      stages([{ stage: "fix", requiresApproval: true }]),
      "contributions.policies[0].stages[0].stage",
    );
    rejected(
      stages([
        { stage: "review", requiresApproval: true },
        { stage: "design", operations: ["a"] },
        { stage: "review", operations: ["a"] },
      ]),
      "contributions.policies[0].stages[2].stage",
    );
    rejected(
      stages([{ stage: "review" }]),
      "contributions.policies[0].stages[0]",
    );
  });

  test("independent approval needs approval", () => {
    rejected(
      {
        id: "p",
        workflow: "delivery",
        stages: [{ stage: "review", requiresIndependentApproval: true }],
      },
      "contributions.policies[0].stages[0].requiresIndependentApproval",
    );
  });

  test("a separation target is an earlier stage of the target workflow", () => {
    const separation = (stage: string, value: unknown) => ({
      id: "p",
      workflow: "delivery",
      stages: [{ stage, requiresDifferentAgentFrom: value }],
    });
    const path =
      "contributions.policies[0].stages[0].requiresDifferentAgentFrom";
    rejected(separation("review", "design"), path);
    rejected(separation("review", []), path);
    rejected(separation("review", ["design", "design"]), path);
    rejected(separation("review", ["not a local id"]), `${path}[0]`);
    // Unknown, the stage itself, and a later stage.
    rejected(separation("review", ["design", "sign"]), `${path}[1]`);
    rejected(separation("review", ["review"]), `${path}[0]`);
    rejected(separation("implement", ["design", "review"]), `${path}[1]`);
    // The first stage has no earlier stage.
    rejected(separation("design", ["implement"]), `${path}[0]`);
  });

  test("operations follow the legacy operation-name grammar and bounds", () => {
    const operations = (value: unknown) => ({
      id: "p",
      workflow: "delivery",
      stages: [{ stage: "review", operations: value }],
    });
    const path = "contributions.policies[0].stages[0].operations";
    expect(maximumPolicyStageOperations).toBe(64);
    rejected(operations("filesystem.read"), path);
    rejected(operations([]), path);
    rejected(operations(["a", "b", "a"]), path);
    const names = Array.from({ length: 65 }, (_, index) => `op-${index}`);
    rejected(operations(names), path);
    for (const name of [
      "",
      "Filesystem.read",
      "1read",
      "filesystem..read",
      "filesystem.",
      " filesystem.read",
      "filesystem read",
      "filesystem/read",
      `a${"b".repeat(128)}`,
      7,
      null,
    ])
      rejected(operations(["ok", name]), `${path}[1]`);
    // At the bounds: 64 names, 128 characters, every separator.
    const parsed = parseDomainPackManifest(
      bytes(
        withPolicies(
          operations([...names.slice(0, 62), `a${"b".repeat(127)}`, "a.b:c-d"]),
        ),
      ),
    );
    expect(
      parsed.contributions.policies[0]!.stages![0]!.operations,
    ).toHaveLength(64);
  });

  test("an operation name is opaque: it need not be, and is not read as, a declared capability", () => {
    const parsed = parseDomainPackManifest(
      bytes(
        manifest({
          ...base,
          capabilities: [{ id: "inspect_code" }],
          policies: [
            {
              id: "p",
              workflow: "delivery",
              stages: [
                { stage: "review", operations: ["filesystem.read", "review"] },
              ],
            },
          ],
        }),
      ),
    );
    expect(parsed.contributions.policies[0]!.stages![0]!.operations).toEqual([
      "filesystem.read",
      "review",
    ]);
  });

  test("the three fields are unknown fields on every other contribution kind", () => {
    for (const field of ["workflow", "enforcement", "stages"] as const)
      for (const kind of contributionKinds) {
        if (kind === "policies") continue;
        // `stages` is a workflow's own field.
        if (kind === "workflows" && field === "stages") continue;
        const value =
          field === "workflow"
            ? "delivery"
            : field === "enforcement"
              ? "enforced"
              : [];
        const item =
          kind === "workflows"
            ? { id: "w", taskType: "change", stages: [], [field]: value }
            : { id: "x", [field]: value };
        const sections: Record<string, unknown[]> = {
          roles: [...base.roles],
          taskTypes: [...base.taskTypes],
          workflows: [...base.workflows],
        };
        sections[kind] = [...(sections[kind] ?? []), item];
        const index = sections[kind].length - 1;
        expect(failure(manifest(sections))).toEqual({
          code: "invalid_contribution",
          path: `contributions.${kind}[${index}].${field}`,
        });
      }
  });
});

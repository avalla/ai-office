import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DomainPackManifestError,
  canonicalizeDomainPackManifest,
  computeManifestDigest,
  contributionKinds,
  maximumContributionReferences,
  maximumDescriptiveListEntries,
  parseDomainPackManifest,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

// GP-10B-2, PR 1: the six descriptive fields of manifest schema 1.

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

const base = {
  roles: [{ id: "counsel" }, { id: "clerk" }],
  taskTypes: [{ id: "matter" }, { id: "filing" }, { id: "appeal" }],
};
const stageOf = (extra: object = {}) => ({
  id: "check",
  role: "counsel",
  ...extra,
});
const workflowOf = (extra: object = {}, stage: object = stageOf()) => ({
  id: "review",
  taskType: "matter",
  stages: [stage],
  ...extra,
});
const withWorkflow = (workflow: object) =>
  manifest({ ...base, workflows: [workflow] });
const withStage = (extra: object) =>
  withWorkflow(workflowOf({}, stageOf(extra)));
const withRole = (extra: object) =>
  manifest({ ...base, roles: [{ id: "counsel", ...extra }] });
const withPrompt = (extra: object) =>
  manifest({ ...base, prompts: [{ id: "brief", ...extra }] });
const digestOf = (value: unknown) =>
  computeManifestDigest(parseDomainPackManifest(bytes(value)));
const invalid = (path: string) => ({ code: "invalid_contribution", path });
const loneSurrogate = "a\ud800b";
const many = (count: number) =>
  Array.from({ length: count }, (_, index) => `entry ${index}`);

describe("GP-10B-2 descriptive vocabulary in the schema-1 manifest", () => {
  test("a stage, a role, a prompt and a workflow may carry the descriptive fields", () => {
    const parsed = parseDomainPackManifest(
      bytes(
        manifest({
          ...base,
          roles: [
            {
              id: "counsel",
              title: "Counsel",
              responsibilities: ["Advise the client", "Sign filings"],
            },
            { id: "clerk" },
          ],
          prompts: [
            {
              id: "brief",
              title: "Brief",
              text: "Write the brief.\n\nBe exact.",
            },
            { id: "plain" },
          ],
          workflows: [
            {
              id: "review",
              taskType: "matter",
              additionalTaskTypes: ["appeal", "filing"],
              stages: [
                {
                  id: "check",
                  role: "counsel",
                  title: "Check",
                  objective: "Establish that the draft is correct",
                  checks: ["Citations verified", "Deadline confirmed"],
                },
                { id: "file", role: "clerk" },
              ],
            },
            { id: "intake", taskType: "filing", stages: [] },
          ],
        }),
      ),
    );
    expect(parsed.contributions.roles).toEqual([
      {
        id: "counsel",
        title: "Counsel",
        responsibilities: ["Advise the client", "Sign filings"],
      },
      { id: "clerk" },
    ]);
    expect(parsed.contributions.prompts).toEqual([
      { id: "brief", title: "Brief", text: "Write the brief.\n\nBe exact." },
      { id: "plain" },
    ]);
    expect(parsed.contributions.workflows).toEqual([
      {
        id: "review",
        taskType: "matter",
        additionalTaskTypes: ["appeal", "filing"],
        stages: [
          {
            id: "check",
            role: "counsel",
            title: "Check",
            objective: "Establish that the draft is correct",
            checks: ["Citations verified", "Deadline confirmed"],
          },
          { id: "file", role: "clerk" },
        ],
      },
      { id: "intake", taskType: "filing", stages: [] },
    ]);
    // Absent fields stay absent: there is no second "empty" encoding.
    expect(
      Object.hasOwn(parsed.contributions.roles[1]!, "responsibilities"),
    ).toBe(false);
    expect(Object.hasOwn(parsed.contributions.prompts[1]!, "text")).toBe(false);
    expect(
      Object.hasOwn(parsed.contributions.workflows[1]!, "additionalTaskTypes"),
    ).toBe(false);
    for (const field of ["title", "objective", "checks"])
      expect(
        Object.hasOwn(parsed.contributions.workflows[0]!.stages[1]!, field),
      ).toBe(false);
  });

  test("lists hold 1 to 64 entries, keep duplicates and keep the written order", () => {
    expect(maximumDescriptiveListEntries).toBe(64);
    const atBound = many(maximumDescriptiveListEntries);
    expect(
      parseDomainPackManifest(bytes(withStage({ checks: atBound })))
        .contributions.workflows[0]?.stages[0]?.checks,
    ).toEqual(atBound);
    expect(
      parseDomainPackManifest(bytes(withRole({ responsibilities: atBound })))
        .contributions.roles[0]?.responsibilities,
    ).toEqual(atBound);
    const repeated = ["b", "a", "b", "A"];
    expect(
      parseDomainPackManifest(bytes(withStage({ checks: repeated })))
        .contributions.workflows[0]?.stages[0]?.checks,
    ).toEqual(repeated);
    expect(
      parseDomainPackManifest(bytes(withRole({ responsibilities: repeated })))
        .contributions.roles[0]?.responsibilities,
    ).toEqual(repeated);
  });

  test("the text of the new fields follows the manifest text rule: unbounded, not normalized, U+0000 allowed", () => {
    const long = "x".repeat(70_000);
    const odd = "é \u0000 😀";
    const parsed = parseDomainPackManifest(
      bytes(
        manifest({
          ...base,
          roles: [{ id: "counsel", responsibilities: [long, odd] }],
          prompts: [{ id: "brief", text: `${long}${odd}` }],
          workflows: [
            workflowOf(
              {},
              stageOf({ title: "", objective: long, checks: [odd] }),
            ),
          ],
        }),
      ),
    );
    expect(parsed.contributions.roles[0]?.responsibilities).toEqual([
      long,
      odd,
    ]);
    expect(parsed.contributions.prompts[0]?.text).toBe(`${long}${odd}`);
    expect(parsed.contributions.workflows[0]?.stages[0]).toEqual({
      id: "check",
      role: "counsel",
      // A stage title and objective are plain manifest text, like a
      // contribution title: only a prompt text must be non-empty.
      title: "",
      objective: long,
      checks: [odd],
    });
  });

  test("a malformed descriptive list is rejected with the member path", () => {
    const stage = "contributions.workflows[0].stages[0]";
    const role = "contributions.roles[0]";
    for (const [field, path, wrap] of [
      ["checks", `${stage}.checks`, withStage],
      ["responsibilities", `${role}.responsibilities`, withRole],
    ] as const) {
      // Not an array.
      for (const value of ["one", { 0: "one" }, null, 1, true])
        expect(failure(wrap({ [field]: value }))).toEqual(invalid(path));
      // "None" is the absent field.
      expect(failure(wrap({ [field]: [] }))).toEqual(invalid(path));
      expect(
        failure(wrap({ [field]: many(maximumDescriptiveListEntries + 1) })),
      ).toEqual(invalid(path));
      // An entry is a non-empty string without a lone surrogate.
      expect(failure(wrap({ [field]: ["fine", ""] }))).toEqual(
        invalid(`${path}[1]`),
      );
      expect(failure(wrap({ [field]: [loneSurrogate] }))).toEqual(
        invalid(`${path}[0]`),
      );
      for (const entry of [1, null, ["nested"], { text: "x" }])
        expect(failure(wrap({ [field]: ["fine", "fine", entry] }))).toEqual(
          invalid(`${path}[2]`),
        );
    }
  });

  test("malformed stage text and prompt text are rejected with the member path", () => {
    const stage = "contributions.workflows[0].stages[0]";
    for (const field of ["title", "objective"])
      for (const value of [1, null, ["x"], loneSurrogate])
        expect(failure(withStage({ [field]: value }))).toEqual(
          invalid(`${stage}.${field}`),
        );
    const text = "contributions.prompts[0].text";
    for (const value of ["", 1, null, ["x"], { text: "x" }, loneSurrogate])
      expect(failure(withPrompt({ text: value }))).toEqual(invalid(text));
  });

  test("additionalTaskTypes is a bounded set of declared task types that excludes the taskType", () => {
    const path = "contributions.workflows[0].additionalTaskTypes";
    const reject = (value: unknown) =>
      failure(withWorkflow(workflowOf({ additionalTaskTypes: value })));
    for (const value of ["filing", { 0: "filing" }, null, 1])
      expect(reject(value)).toEqual(invalid(path));
    expect(reject([])).toEqual(invalid(path));
    // Malformed entries.
    for (const entry of ["no id", "", 1, null, ["filing"]])
      expect(reject(["filing", entry])).toEqual(invalid(`${path}[1]`));
    // A set: no duplicate.
    expect(reject(["filing", "filing"])).toEqual(invalid(path));
    // Undeclared: schema-1 references are bare local IDs of this manifest.
    expect(reject(["filing", "ghost"])).toEqual(invalid(`${path}[1]`));
    // The task type itself is not an additional one.
    expect(reject(["matter"])).toEqual(invalid(`${path}[0]`));
    expect(reject(["filing", "matter"])).toEqual(invalid(`${path}[1]`));

    // The bound is the one of every reference list.
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `t${index}`);
    const big = (count: number) =>
      manifest({
        ...base,
        taskTypes: [{ id: "matter" }, ...ids(count).map((id) => ({ id }))],
        workflows: [workflowOf({ additionalTaskTypes: ids(count) })],
      });
    expect(
      parseDomainPackManifest(bytes(big(maximumContributionReferences)))
        .contributions.workflows[0]?.additionalTaskTypes,
    ).toHaveLength(maximumContributionReferences);
    expect(failure(big(maximumContributionReferences + 1))).toEqual(
      invalid(path),
    );
  });

  test("each field exists only where the contract puts it", () => {
    const fields = {
      title: "Check",
      objective: "Why",
      checks: ["One"],
      responsibilities: ["One"],
      text: "Text",
      additionalTaskTypes: ["filing"],
    };
    const allowed: Record<string, readonly string[]> = {
      roles: ["title", "responsibilities"],
      prompts: ["title", "text"],
      workflows: ["title", "additionalTaskTypes"],
    };
    // On a contribution of every kind.
    for (const kind of contributionKinds)
      for (const [field, value] of Object.entries(fields)) {
        const item =
          kind === "workflows"
            ? workflowOf({ [field]: value })
            : { id: "item", [field]: value };
        const source = manifest({ ...base, [kind]: [item] });
        if ((allowed[kind] ?? ["title"]).includes(field))
          expect(
            () => parseDomainPackManifest(bytes(source)),
            `${kind}.${field}`,
          ).not.toThrow();
        else
          expect(failure(source), `${kind}.${field}`).toEqual(
            invalid(`contributions.${kind}[0].${field}`),
          );
      }
    // On a stage.
    for (const field of ["responsibilities", "text", "additionalTaskTypes"])
      expect(
        failure(withStage({ [field]: fields[field as keyof typeof fields] })),
      ).toEqual(invalid(`contributions.workflows[0].stages[0].${field}`));
    for (const field of ["description", "name", "requiresApproval"])
      expect(failure(withStage({ [field]: "x" }))).toEqual(
        invalid(`contributions.workflows[0].stages[0].${field}`),
      );
    // At the manifest root and in the metadata.
    expect(failure({ ...manifest(base), text: "x" })).toEqual({
      code: "malformed_input",
      path: "$.text",
    });
    expect(
      failure({
        ...manifest(base),
        metadata: { name: "N", description: "D", responsibilities: ["x"] },
      }),
    ).toEqual({ code: "malformed_input", path: "metadata.responsibilities" });
  });

  test("the written order of additionalTaskTypes does not change the digest; the order of checks and responsibilities does", () => {
    const routed = (additionalTaskTypes: string[]) =>
      withWorkflow(workflowOf({ additionalTaskTypes }));
    const parsed = parseDomainPackManifest(bytes(routed(["filing", "appeal"])));
    // A set: one order.
    expect(parsed.contributions.workflows[0]?.additionalTaskTypes).toEqual([
      "appeal",
      "filing",
    ]);
    expect(digestOf(routed(["filing", "appeal"]))).toBe(
      digestOf(routed(["appeal", "filing"])),
    );
    expect(digestOf(routed(["filing", "appeal"]))).not.toBe(
      digestOf(routed(["filing"])),
    );
    expect(decoder.decode(canonicalizeDomainPackManifest(parsed))).toContain(
      '"additionalTaskTypes":["appeal","filing"]',
    );

    // Ordered lists are digest material in the order written.
    expect(digestOf(withStage({ checks: ["a", "b"] }))).not.toBe(
      digestOf(withStage({ checks: ["b", "a"] })),
    );
    expect(digestOf(withRole({ responsibilities: ["a", "b"] }))).not.toBe(
      digestOf(withRole({ responsibilities: ["b", "a"] })),
    );
    expect(
      parseDomainPackManifest(bytes(withStage({ checks: ["b", "a"] })))
        .contributions.workflows[0]?.stages[0]?.checks,
    ).toEqual(["b", "a"]);
    // Every field is digest material.
    const plain = digestOf(withStage({}));
    for (const extra of [
      { title: "Check" },
      { objective: "Why" },
      { checks: ["One"] },
    ])
      expect(digestOf(withStage(extra))).not.toBe(plain);
    expect(digestOf(withRole({ responsibilities: ["One"] }))).not.toBe(
      digestOf(withRole({})),
    );
    expect(digestOf(withPrompt({ text: "One" }))).not.toBe(
      digestOf(withPrompt({})),
    );
    expect(digestOf(withPrompt({ text: "One" }))).not.toBe(
      digestOf(withPrompt({ text: "Two" })),
    );
  });

  test("a manifest without the fields keeps its canonical form and digest", () => {
    // The four golden fixtures.
    const golden = {
      development:
        "sha256:26b71333f202563bf5f1f8e377c68500f3a01fd8638305b2d1e06bff659dae8f",
      legal:
        "sha256:1a3339f5faeb8558db8fe20e31cacf98d900c0e7e4ebe67f8672983095b35b77",
      manufacturing:
        "sha256:a6f991dcd8af725d15143a42ee605ba95a8470dc127fd2be4d3955ce03bbd583",
      custom:
        "sha256:6da016cf854774724029e2753f91b49353d6fbb9a74e965fb3ad2ee4e7e0aaf3",
    };
    for (const [name, digest] of Object.entries(golden)) {
      const verified = verifyDomainPackManifest(
        readFileSync(
          new URL(`../fixtures/domain-pack/${name}.json`, import.meta.url),
        ),
        1,
      );
      expect(verified.manifestDigest, name).toBe(digest);
      expect(computeManifestDigest(verified), name).toBe(digest);
    }
    // Development pack 0.2.0, which PR 1 does not edit.
    const development = verifyDomainPackManifest(
      readFileSync(
        new URL(
          "../../packages/domain-pack-development/manifest.json",
          import.meta.url,
        ),
      ),
      1,
    );
    expect(development.version).toBe("0.2.0");
    expect(development.manifestDigest).toBe(
      "sha256:6321bb076a19765ce50f3127914c95487658c44e4cf480c3471337d2983f227e",
    );
    // The canonical form of a manifest without the fields names none of them.
    const canonical = decoder.decode(
      canonicalizeDomainPackManifest(
        parseDomainPackManifest(
          bytes(
            manifest({
              ...base,
              prompts: [{ id: "brief" }],
              workflows: [workflowOf()],
            }),
          ),
        ),
      ),
    );
    for (const field of [
      "objective",
      "checks",
      "responsibilities",
      "text",
      "additionalTaskTypes",
    ])
      expect(canonical).not.toContain(`"${field}"`);
    expect(canonical).toContain(
      '"workflows":[{"id":"review","stages":[{"id":"check","role":"counsel"}],"taskType":"matter"}]',
    );
  });
});

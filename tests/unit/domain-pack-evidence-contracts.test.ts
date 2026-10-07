import { describe, expect, test } from "vitest";
import {
  DomainPackManifestError,
  canonicalizeDomainPackManifest,
  computeManifestDigest,
  contributionKinds,
  maximumArtifactMediaTypes,
  maximumArtifactTypeBytes,
  maximumSchemaDepth,
  maximumSchemaEnumValues,
  maximumSchemaNodes,
  maximumSchemaProperties,
  maximumValidatorAccepts,
  maximumValidatorInputBytes,
  maximumValidatorOutputBytes,
  maximumValidatorTimeoutMs,
  parseDomainPackManifest,
  validateDomainPackManifest,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import {
  ProjectDefinitionConflictError,
  parseDefinitionMutation,
} from "../../packages/application/src/domain-pack/project-definition.ts";

// GP-14A: typed, data-only artifact types, evidence types and validator
// references in the schema-1 manifest. Nothing here runs or enforces anything.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const placeholder = `sha256:${"0".repeat(64)}`;

function manifest(
  contributions: Record<string, unknown[]> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "org.example.legal",
    version: "1.0.0",
    manifestDigest: placeholder,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: "Legal", description: "Evidence contract fixture" },
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

const schemaOf = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    pages: { type: "integer", minimum: 1 },
    kind: { type: "enum", values: ["brief", "motion"] },
  },
  required: ["title"],
};

const artifact = {
  id: "filing",
  title: "Court filing",
  mediaTypes: ["application/pdf", "text/markdown"],
  maximumBytes: 10_485_760,
  contentSchema: schemaOf,
};
const evidence = {
  id: "citation-check",
  subject: "filing",
  payloadSchema: {
    type: "object",
    properties: { verified: { type: "boolean" } },
  },
};
const validator = {
  id: "cite-checker",
  adapter: { id: "legal.citation-checker", version: "1.2.0" },
  accepts: [
    { kind: "evidenceTypes", id: "citation-check" },
    { kind: "artifactTypes", id: "filing" },
  ],
  inputSchema: schemaOf,
  produces: "citation-check",
  outputSchema: evidence.payloadSchema,
  failurePolicy: "fail_closed",
  timeoutMs: 30_000,
  maxInputBytes: 1_048_576,
  maxOutputBytes: 65_536,
};

const typed = (overrides: Record<string, unknown[]> = {}) =>
  manifest({
    artifactTypes: [artifact],
    evidenceTypes: [evidence],
    validators: [validator],
    ...overrides,
  });

/** A copy of an object with one member replaced or, with undefined, removed. */
function patched(
  base: Record<string, unknown>,
  member: string,
  value: unknown,
): Record<string, unknown> {
  const copy = { ...base, [member]: value };
  if (value === undefined) delete copy[member];
  return copy;
}

const inArtifact = (member: string, value: unknown) =>
  typed({ artifactTypes: [patched(artifact, member, value)] });
const inEvidence = (member: string, value: unknown) =>
  typed({ evidenceTypes: [patched(evidence, member, value)] });
const inValidator = (member: string, value: unknown) =>
  typed({ validators: [patched(validator, member, value)] });
const withSchema = (schema: unknown) => inArtifact("contentSchema", schema);

function expectRejected(value: unknown, path: string): void {
  expect([path, failure(value)]).toEqual([
    path,
    { code: "invalid_contribution", path },
  ]);
}

/** Nests an object schema `levels` deep, the innermost a boolean leaf. */
function nested(levels: number): unknown {
  let schema: unknown = { type: "boolean" };
  for (let level = 1; level < levels; level += 1)
    schema = { type: "object", properties: { next: schema } };
  return schema;
}

describe("GP-14A typed artifact, evidence and validator declarations", () => {
  test("a fully typed manifest parses to a canonical, sorted form", () => {
    const parsed = parseDomainPackManifest(bytes(typed()));
    expect(parsed.contributions.artifactTypes[0]).toEqual({
      ...artifact,
      // A set: ascending code-unit order.
      mediaTypes: ["application/pdf", "text/markdown"],
      contentSchema: {
        ...schemaOf,
        properties: {
          kind: { type: "enum", values: ["brief", "motion"] },
          pages: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    });
    expect(parsed.contributions.evidenceTypes[0]).toEqual(evidence);
    const [parsedValidator] = parsed.contributions.validators;
    expect(parsedValidator?.accepts).toEqual([
      { kind: "artifactTypes", id: "filing" },
      { kind: "evidenceTypes", id: "citation-check" },
    ]);
    expect(parsedValidator?.adapter).toEqual(validator.adapter);
    expect(parsedValidator?.failurePolicy).toBe("fail_closed");
  });

  test("the written order of every set does not change the digest", () => {
    const reordered = typed({
      artifactTypes: [
        {
          ...artifact,
          mediaTypes: ["text/markdown", "application/pdf"],
          contentSchema: {
            type: "object",
            required: ["title"],
            properties: {
              kind: { type: "enum", values: ["motion", "brief"] },
              title: { type: "string", maxLength: 200, minLength: 1 },
              pages: { minimum: 1, type: "integer" },
            },
          },
        },
      ],
      validators: [{ ...validator, accepts: [...validator.accepts].reverse() }],
    });
    const digest = (value: unknown) =>
      computeManifestDigest(parseDomainPackManifest(bytes(value)));
    expect(digest(reordered)).toBe(digest(typed()));
    // Content, unlike order, is identity.
    expect(digest(inValidator("timeoutMs", 29_999))).not.toBe(digest(typed()));
    expect(
      digest(
        inValidator("adapter", {
          id: "legal.citation-checker",
          version: "1.2.1",
        }),
      ),
    ).not.toBe(digest(typed()));
  });

  test("canonicalization is idempotent and a verified manifest round-trips", () => {
    const parsed = parseDomainPackManifest(bytes(typed()));
    const canonical = canonicalizeDomainPackManifest(parsed);
    const digest = computeManifestDigest(parsed);
    const published = {
      ...JSON.parse(decoder.decode(canonical)),
      manifestDigest: digest,
    };
    const verified = verifyDomainPackManifest(bytes(published), 1);
    expect(canonicalizeDomainPackManifest(verified)).toEqual(canonical);
  });

  test("label-only entries keep their canonical form", () => {
    const labels = manifest({
      artifactTypes: [{ id: "filing", title: "Filing" }],
      evidenceTypes: [{ id: "check" }],
      validators: [{ id: "checker", description: "A label" }],
    });
    const parsed = parseDomainPackManifest(bytes(labels));
    expect(parsed.contributions.artifactTypes).toEqual([
      { id: "filing", title: "Filing" },
    ]);
    expect(parsed.contributions.validators).toEqual([
      { id: "checker", description: "A label" },
    ]);
    // Absent members are not serialized: no key appears in the digest input.
    const canonical = decoder.decode(canonicalizeDomainPackManifest(parsed));
    for (const member of [
      "mediaTypes",
      "subject",
      "adapter",
      "failurePolicy",
      "contentSchema",
    ])
      expect(canonical).not.toContain(member);
  });

  test("each declared bound is inclusive", () => {
    const parsed = parseDomainPackManifest(
      bytes(
        typed({
          artifactTypes: [
            {
              ...artifact,
              maximumBytes: maximumArtifactTypeBytes,
              mediaTypes: Array.from(
                { length: maximumArtifactMediaTypes },
                (_, index) => `application/x-type${index}`,
              ),
            },
          ],
          validators: [
            {
              ...validator,
              timeoutMs: maximumValidatorTimeoutMs,
              maxInputBytes: maximumValidatorInputBytes,
              maxOutputBytes: maximumValidatorOutputBytes,
            },
          ],
        }),
      ),
    );
    expect(parsed.contributions.artifactTypes[0]?.mediaTypes).toHaveLength(16);
    expect(parsed.contributions.validators[0]?.timeoutMs).toBe(60_000);
  });
});

describe("GP-14A rejections carry the member path", () => {
  test("artifact type members", () => {
    const path = "contributions.artifactTypes[0]";
    for (const [member, value] of [
      ["mediaTypes", "application/pdf"],
      ["mediaTypes", []],
      [
        "mediaTypes",
        Array.from(
          { length: maximumArtifactMediaTypes + 1 },
          (_, i) => `a/b${i}`,
        ),
      ],
      ["mediaTypes", ["application/pdf", "application/pdf"]],
    ] as const)
      expectRejected(inArtifact(member, value), `${path}.${member}`);
    for (const bad of [
      "*/*",
      "application/*",
      "application",
      "Application/PDF",
      "application/pdf; charset=utf-8",
      "https://example.com/x",
      "application/x/y",
      "/pdf",
      "application/",
      "",
      42,
      `a/${"b".repeat(126)}`,
    ])
      expectRejected(
        inArtifact("mediaTypes", ["application/pdf", bad]),
        `${path}.mediaTypes[1]`,
      );
    for (const bad of [
      0,
      -1,
      1.5,
      "10",
      maximumArtifactTypeBytes + 1,
      Number.NaN,
      null,
    ])
      expectRejected(inArtifact("maximumBytes", bad), `${path}.maximumBytes`);
    expectRejected(
      inArtifact("contentSchema", "object"),
      `${path}.contentSchema`,
    );
    expectRejected(
      typed({ artifactTypes: [{ ...artifact, subject: "x" }] }),
      `${path}.subject`,
    );
  });

  test("evidence type members and references", () => {
    const path = "contributions.evidenceTypes[0]";
    expectRejected(inEvidence("subject", "missing"), `${path}.subject`);
    expectRejected(
      inEvidence("subject", "other.pack/filing"),
      `${path}.subject`,
    );
    expectRejected(inEvidence("subject", ["filing"]), `${path}.subject`);
    expectRejected(inEvidence("subject", 5), `${path}.subject`);
    expectRejected(
      inEvidence("payloadSchema", { type: "bogus" }),
      `${path}.payloadSchema.type`,
    );
    expectRejected(
      typed({ evidenceTypes: [{ ...evidence, adapter: validator.adapter }] }),
      `${path}.adapter`,
    );
    // A subject is an artifact type, never an evidence type.
    expectRejected(
      typed({
        evidenceTypes: [evidence, { id: "second", subject: "citation-check" }],
      }),
      "contributions.evidenceTypes[1].subject",
    );
  });

  test("validator adapter, version and executable members", () => {
    const path = "contributions.validators[0]";
    for (const id of [
      "",
      "Legal.Checker",
      "legal checker",
      "legal/checker",
      "../checker",
      "https://example.com/checker",
      "legal:checker",
      "legal.*",
      "*",
      "legal..checker",
      "1legal",
      "legal.",
      `a${"b".repeat(128)}`,
      7,
    ])
      expectRejected(
        inValidator("adapter", { ...validator.adapter, id }),
        `${path}.adapter.id`,
      );
    for (const version of [
      "^1.0.0",
      "~1.2.0",
      "latest",
      "1.x",
      "1.*",
      "*",
      ">=1.0.0",
      "1.2",
      "1.2.0-beta",
      "01.2.0",
      "v1.2.0",
      "",
      1,
    ])
      expectRejected(
        inValidator("adapter", { ...validator.adapter, version }),
        `${path}.adapter.version`,
      );
    expectRejected(inValidator("adapter", "legal.checker"), `${path}.adapter`);
    expectRejected(
      inValidator("adapter", { id: "legal.checker" }),
      `${path}.adapter.version`,
    );
    for (const key of ["command", "entry", "module", "url", "script"]) {
      expectRejected(inValidator(key, "./run.sh"), `${path}.${key}`);
      expectRejected(
        inValidator("adapter", { ...validator.adapter, [key]: "x" }),
        `${path}.adapter.${key}`,
      );
      // A label cannot smuggle one in either.
      expectRejected(
        manifest({ validators: [{ id: "label", [key]: "x" }] }),
        `${path}.${key}`,
      );
    }
    for (const key of ["env", "args", "headers", "credential", "secret"])
      expectRejected(inValidator(key, "x"), `${path}.${key}`);
  });

  test("validator members need the adapter and are all required with it", () => {
    const path = "contributions.validators[0]";
    for (const member of [
      "accepts",
      "inputSchema",
      "produces",
      "outputSchema",
      "failurePolicy",
      "timeoutMs",
      "maxInputBytes",
      "maxOutputBytes",
    ]) {
      // A typed member without an adapter.
      expectRejected(
        manifest({
          artifactTypes: [artifact],
          evidenceTypes: [evidence],
          validators: [
            {
              id: "orphan",
              [member]: validator[member as keyof typeof validator],
            },
          ],
        }),
        `${path}.adapter`,
      );
      // An adapter without one of the members.
      expectRejected(inValidator(member, undefined), `${path}.${member}`);
    }
  });

  test("validator references, sets and limits", () => {
    const path = "contributions.validators[0]";
    expectRejected(inValidator("accepts", []), `${path}.accepts`);
    expectRejected(inValidator("accepts", {}), `${path}.accepts`);
    expectRejected(
      inValidator(
        "accepts",
        Array.from({ length: maximumValidatorAccepts + 1 }, (_, i) => ({
          kind: "artifactTypes",
          id: `t${i}`,
        })),
      ),
      `${path}.accepts`,
    );
    expectRejected(
      inValidator("accepts", [
        { kind: "artifactTypes", id: "filing" },
        { kind: "artifactTypes", id: "filing" },
      ]),
      `${path}.accepts`,
    );
    expectRejected(
      inValidator("accepts", [{ kind: "validators", id: "filing" }]),
      `${path}.accepts[0].kind`,
    );
    expectRejected(
      inValidator("accepts", [{ kind: "artifactTypes", id: "ghost" }]),
      `${path}.accepts[0].id`,
    );
    // The kind decides the section: an evidence ID is not an artifact type.
    expectRejected(
      inValidator("accepts", [{ kind: "artifactTypes", id: "citation-check" }]),
      `${path}.accepts[0].id`,
    );
    expectRejected(
      inValidator("accepts", [{ kind: "artifactTypes", id: "pack/filing" }]),
      `${path}.accepts[0].id`,
    );
    expectRejected(
      inValidator("accepts", [
        { kind: "artifactTypes", id: "filing", pack: "org.other.pack" },
      ]),
      `${path}.accepts[0].pack`,
    );
    expectRejected(
      inValidator("accepts", [{ kind: "artifactTypes" }]),
      `${path}.accepts[0].id`,
    );
    expectRejected(inValidator("produces", "ghost"), `${path}.produces`);
    // Evidence only: an artifact type cannot be produced.
    expectRejected(inValidator("produces", "filing"), `${path}.produces`);
    for (const policy of ["advisory", "fail_open", "FAIL_CLOSED", true, null])
      expectRejected(
        inValidator("failurePolicy", policy),
        `${path}.failurePolicy`,
      );
    for (const [member, ceiling] of [
      ["timeoutMs", maximumValidatorTimeoutMs],
      ["maxInputBytes", maximumValidatorInputBytes],
      ["maxOutputBytes", maximumValidatorOutputBytes],
    ] as const)
      for (const bad of [0, -1, 1.5, "1", ceiling + 1, null])
        expectRejected(inValidator(member, bad), `${path}.${member}`);
  });

  test("duplicate IDs and cross-pack references", () => {
    expectRejected(
      typed({ artifactTypes: [artifact, { id: "filing" }] }),
      "contributions.artifactTypes",
    );
    expectRejected(
      typed({ validators: [validator, { id: "cite-checker" }] }),
      "contributions.validators",
    );
    // References are bare local IDs: a dependency's type cannot be named.
    expectRejected(
      inEvidence("subject", "org.example.base/filing"),
      "contributions.evidenceTypes[0].subject",
    );
  });
});

describe("GP-14A closed data schema", () => {
  test("every type is accepted with its bounds", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", minLength: 0, maxLength: 0 },
        b: { type: "integer", minimum: -5, maximum: 5 },
        c: { type: "number", minimum: -0.5, maximum: 0.5 },
        d: { type: "boolean" },
        e: { type: "enum", values: ["z", "a"] },
        f: {
          type: "array",
          items: { type: "string" },
          minItems: 0,
          maxItems: 3,
        },
      },
      required: ["f", "a"],
    };
    const parsed = parseDomainPackManifest(bytes(withSchema(schema)));
    const content = parsed.contributions.artifactTypes[0]?.contentSchema;
    expect(content).toMatchObject({
      type: "object",
      required: ["a", "f"],
      properties: { e: { type: "enum", values: ["a", "z"] } },
    });
    expect(
      Object.keys(content && "properties" in content ? content.properties : {}),
    ).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("a schema is closed and never a JSON Schema", () => {
    const base = "contributions.artifactTypes[0].contentSchema";
    for (const [member, value] of [
      ["$ref", "#/definitions/x"],
      ["$schema", "https://json-schema.org/draft/2020-12/schema"],
      ["pattern", "^a+$"],
      ["format", "uri"],
      ["additionalProperties", true],
      ["additionalProperties", false],
      ["patternProperties", {}],
      ["oneOf", []],
      ["default", "x"],
      ["const", "x"],
    ] as const) {
      expectRejected(
        withSchema({ ...schemaOf, [member]: value }),
        `${base}.${member}`,
      );
      expectRejected(
        withSchema({ type: "string", [member]: value }),
        `${base}.${member}`,
      );
    }
    expectRejected(
      withSchema({ type: "object", properties: { a: { $ref: "#/x" } } }),
      `${base}.properties.a.type`,
    );
    expectRejected(
      withSchema({
        type: "object",
        properties: { a: { type: "string", $ref: "x" } },
      }),
      `${base}.properties.a.$ref`,
    );
    expectRejected(
      withSchema({
        type: "object",
        properties: { a: { type: "string", pattern: "(a+)+$" } },
      }),
      `${base}.properties.a.pattern`,
    );
    for (const type of ["null", "any", "String", ["string"], undefined])
      expectRejected(withSchema({ type }), `${base}.type`);
    expectRejected(
      withSchema({ type: "boolean", minimum: 1 }),
      `${base}.minimum`,
    );
    expectRejected(
      withSchema({ type: "string", values: ["a"] }),
      `${base}.values`,
    );
  });

  test("bounds are validated and ordered", () => {
    const base = "contributions.artifactTypes[0].contentSchema";
    expectRejected(
      withSchema({ type: "string", minLength: 2, maxLength: 1 }),
      `${base}.minLength`,
    );
    expectRejected(
      withSchema({ type: "string", maxLength: -1 }),
      `${base}.maxLength`,
    );
    expectRejected(
      withSchema({ type: "string", maxLength: 1.5 }),
      `${base}.maxLength`,
    );
    expectRejected(
      withSchema({ type: "integer", minimum: 0.5 }),
      `${base}.minimum`,
    );
    expectRejected(
      withSchema({ type: "integer", minimum: 3, maximum: 2 }),
      `${base}.minimum`,
    );
    expectRejected(
      withSchema({ type: "number", maximum: "5" }),
      `${base}.maximum`,
    );
    expectRejected(
      withSchema({
        type: "array",
        items: { type: "boolean" },
        minItems: 3,
        maxItems: 2,
      }),
      `${base}.minItems`,
    );
    expectRejected(withSchema({ type: "array" }), `${base}.items`);
  });

  test("depth, property and node limits hold at the boundary", () => {
    const base = "contributions.artifactTypes[0].contentSchema";
    expect(() =>
      parseDomainPackManifest(bytes(withSchema(nested(maximumSchemaDepth)))),
    ).not.toThrow();
    expect(failure(withSchema(nested(maximumSchemaDepth + 1)))).toEqual({
      code: "invalid_contribution",
      path: `${base}${".properties.next".repeat(maximumSchemaDepth)}`,
    });
    // Deep nesting well beyond the limit is rejected, not recursed into.
    expect(() => validateDomainPackManifest(withSchema(nested(200)))).toThrow(
      /contentSchema/,
    );
    // Written as file bytes it never reaches the schema rules at all: the
    // reader's own nesting limit refuses it.
    expect(failure(withSchema(nested(200))).code).toBe("malformed_input");
    // Arrays count as a level too.
    expectRejected(
      withSchema({
        type: "array",
        items: {
          type: "array",
          items: {
            type: "array",
            items: { type: "array", items: { type: "boolean" } },
          },
        },
      }),
      `${base}.items.items.items.items`,
    );
    const properties = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`p${i}`, { type: "boolean" }]),
      );
    expect(() =>
      parseDomainPackManifest(
        bytes(
          withSchema({
            type: "object",
            properties: properties(maximumSchemaProperties),
          }),
        ),
      ),
    ).not.toThrow();
    expectRejected(
      withSchema({
        type: "object",
        properties: properties(maximumSchemaProperties + 1),
      }),
      `${base}.properties`,
    );
    expectRejected(
      withSchema({ type: "object", properties: {} }),
      `${base}.properties`,
    );
    // A root of four objects holding `leaves` boolean leaves between them:
    // 1 + 4 + leaves nodes, each object within the property bound.
    const withNodes = (total: number) => {
      let leaves = total - 5;
      return {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 4 }, (_, i) => {
            const own = Math.min(leaves, maximumSchemaProperties);
            leaves -= own;
            return [`o${i}`, { type: "object", properties: properties(own) }];
          }),
        ),
      };
    };
    expect(() =>
      parseDomainPackManifest(bytes(withSchema(withNodes(maximumSchemaNodes)))),
    ).not.toThrow();
    const bomb = failure(withSchema(withNodes(maximumSchemaNodes + 1)));
    expect(bomb.code).toBe("invalid_contribution");
    expect(bomb.path).toContain(`${base}.properties.o3.properties.p`);
    // Far past the limit is refused too, long before the whole input is read.
    expect(failure(withSchema(withNodes(256 + 255 - 4))).code).toBe(
      "invalid_contribution",
    );
    expect(maximumSchemaNodes).toBe(256);
  });

  test("the node budget is per schema, not per manifest", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`p${i}`, { type: "boolean" }]),
    );
    const schema = { type: "object", properties };
    expect(() =>
      parseDomainPackManifest(
        bytes(
          manifest({
            artifactTypes: Array.from({ length: 10 }, (_, i) => ({
              id: `a${i}`,
              contentSchema: schema,
            })),
          }),
        ),
      ),
    ).not.toThrow();
  });

  test("property names and enum values are restricted", () => {
    const base = "contributions.artifactTypes[0].contentSchema.properties";
    for (const name of [
      "__proto__",
      "constructor",
      "prototype",
      "_hidden",
      "1st",
      "has space",
      "has.dot",
      "$ref",
      "a".repeat(65),
      "",
    ])
      expectRejected(
        withSchemaJson(
          `{"type":"object","properties":{${JSON.stringify(name)}:{"type":"boolean"}}}`,
        ),
        `${base}.${name}`,
      );
    const enumPath = "contributions.artifactTypes[0].contentSchema.values";
    const values = (list: unknown) =>
      withSchema({ type: "enum", values: list });
    expectRejected(values([]), enumPath);
    expectRejected(values("a"), enumPath);
    expectRejected(
      values(
        Array.from({ length: maximumSchemaEnumValues + 1 }, (_, i) => `v${i}`),
      ),
      enumPath,
    );
    expect(() =>
      parseDomainPackManifest(
        bytes(
          values(
            Array.from({ length: maximumSchemaEnumValues }, (_, i) => `v${i}`),
          ),
        ),
      ),
    ).not.toThrow();
    expectRejected(values(["a", "a"]), enumPath);
    expectRejected(values(["a", ""]), `${enumPath}[1]`);
    expectRejected(values(["a", 1]), `${enumPath}[1]`);
    expectRejected(values(["a", "x".repeat(129)]), `${enumPath}[1]`);
    expect(() =>
      parseDomainPackManifest(bytes(values(["x".repeat(128)]))),
    ).not.toThrow();
    // The shared definition text rule: no U+0000, no lone surrogate.
    expectRejected(values(["a", "b\u0000c"]), `${enumPath}[1]`);
    // The strict reader refuses a lone surrogate in file bytes first; the
    // validator holds the same rule for in-memory input.
    expect(() => validateDomainPackManifest(values(["a", "b\ud800c"]))).toThrow(
      /artifactTypes\[0\]\.contentSchema\.values\[1\]/,
    );
    expect(() =>
      parseDomainPackManifest(bytes(values(["valid \u{1F600} text"]))),
    ).not.toThrow();
  });

  test("required names a declared property, once", () => {
    const base = "contributions.artifactTypes[0].contentSchema.required";
    const object = (required: unknown) =>
      withSchema({
        type: "object",
        properties: { a: { type: "boolean" } },
        required,
      });
    expectRejected(object([]), base);
    expectRejected(object("a"), base);
    expectRejected(object(["a", "a"]), base);
    expectRejected(object(["b"]), `${base}[0]`);
    expectRejected(object(["__proto__"]), `${base}[0]`);
  });

  test("a lone surrogate in raw manifest bytes is malformed input", () => {
    // The JSON reader rejects it before any schema rule applies.
    const source = JSON.stringify(withSchema({ type: "boolean" })).replace(
      '"boolean"',
      '"\\ud800"',
    );
    expect(() => parseDomainPackManifest(encoder.encode(source))).toThrow(
      DomainPackManifestError,
    );
  });

  test("a __proto__ member written in JSON is an own key and is refused", () => {
    const source = JSON.stringify(typed()).replace(
      '"id":"cite-checker"',
      '"id":"cite-checker","__proto__":{"polluted":true}',
    );
    expect(() => parseDomainPackManifest(encoder.encode(source))).toThrow(
      /unknown field/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/** A manifest whose artifact content schema is written as raw JSON. */
function withSchemaJson(schemaSource: string): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(withSchema(null)).replace("null", schemaSource),
  ) as Record<string, unknown>;
}

describe("GP-14A fixtures from the legal and manufacturing domains", () => {
  test("a legal-like and a manufacturing-like pack declare typed definitions", () => {
    const legal = manifest({
      artifactTypes: [
        {
          id: "matter-memo",
          mediaTypes: ["text/markdown"],
          maximumBytes: 1_000_000,
          contentSchema: {
            type: "object",
            properties: {
              matter: { type: "string", minLength: 1 },
              privilege: { type: "enum", values: ["none", "privileged"] },
            },
            required: ["matter"],
          },
        },
      ],
      evidenceTypes: [{ id: "citation-review", subject: "matter-memo" }],
      validators: [
        {
          ...validator,
          id: "citation-validator",
          accepts: [{ kind: "artifactTypes", id: "matter-memo" }],
          produces: "citation-review",
        },
      ],
    });
    const plant = manifest({
      artifactTypes: [
        {
          id: "inspection-record",
          mediaTypes: ["application/json"],
          contentSchema: {
            type: "object",
            properties: {
              lot: { type: "string" },
              measurements: {
                type: "array",
                items: { type: "number" },
                maxItems: 100,
              },
            },
          },
        },
      ],
      evidenceTypes: [
        { id: "calibration-proof", subject: "inspection-record" },
      ],
      validators: [
        {
          ...validator,
          id: "tolerance-validator",
          adapter: { id: "mfg.tolerance", version: "2.0.0" },
          accepts: [{ kind: "artifactTypes", id: "inspection-record" }],
          produces: "calibration-proof",
        },
      ],
    });
    for (const fixture of [legal, plant])
      expect(
        parseDomainPackManifest(bytes(fixture)).contributions.validators,
      ).toHaveLength(1);
  });
});

describe("GP-14A typed fields are pack-owned in project payloads", () => {
  const source = (kind: string) => ({
    id: "org.example.legal",
    version: "1.0.0",
    manifestDigest: `sha256:${"a".repeat(64)}`,
    kind,
    localId: "filing",
  });
  const code = (mutation: unknown): string => {
    try {
      parseDefinitionMutation(mutation);
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectDefinitionConflictError);
      return (error as ProjectDefinitionConflictError).code;
    }
    return "accepted";
  };
  const typedKeys: Record<string, Record<string, unknown>> = {
    artifactTypes: {
      mediaTypes: ["application/pdf"],
      maximumBytes: 10,
      contentSchema: { type: "boolean" },
    },
    evidenceTypes: {
      subject: "filing",
      payloadSchema: { type: "boolean" },
    },
  };

  test("any typed key is protected_security_invariant, for every operation", () => {
    for (const [kind, members] of Object.entries(typedKeys))
      for (const [member, value] of Object.entries(members)) {
        const payload = { id: "filing", [member]: value };
        expect([
          kind,
          member,
          code({
            action: "put_owned",
            kind,
            id: "filing",
            enabled: true,
            payload,
          }),
        ]).toEqual([kind, member, "protected_security_invariant"]);
        expect([
          kind,
          member,
          code({
            action: "put_override",
            source: source(kind),
            operation: "replace",
            payload,
          }),
        ]).toEqual([kind, member, "protected_security_invariant"]);
        expect([
          kind,
          member,
          code({
            action: "put_override",
            source: source(kind),
            operation: "extend",
            payload: { [member]: value },
          }),
        ]).toEqual([kind, member, "protected_security_invariant"]);
      }
  });

  test("descriptive replace and extend stay accepted", () => {
    for (const kind of ["artifactTypes", "evidenceTypes"]) {
      expect(
        code({
          action: "put_override",
          source: source(kind),
          operation: "replace",
          payload: { id: "filing", title: "Renamed" },
        }),
      ).toBe("accepted");
      expect(
        code({
          action: "put_override",
          source: source(kind),
          operation: "extend",
          payload: { description: "More" },
        }),
      ).toBe("accepted");
    }
  });

  test("validators stay unsupported for every project operation", () => {
    for (const operation of ["replace", "extend", "disable"])
      expect(
        code({
          action: "put_override",
          source: source("validators"),
          operation,
          ...(operation === "disable" ? {} : { payload: { id: "filing" } }),
        }),
      ).toBe("unsupported_override_operation");
    expect(
      code({
        action: "put_owned",
        kind: "validators",
        id: "filing",
        enabled: true,
        payload: { id: "filing" },
      }),
    ).toBe("protected_security_invariant");
  });

  test("disabling an artifact or evidence type stays unsupported", () => {
    for (const kind of ["artifactTypes", "evidenceTypes"])
      expect(
        code({
          action: "put_override",
          source: source(kind),
          operation: "disable",
        }),
      ).toBe("unsupported_override_operation");
  });
});

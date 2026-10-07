import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { knowledgeRetrievalLimits } from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import {
  DomainPackManifestError,
  canonicalizeDomainPackManifest,
  computeManifestDigest,
  contributionKinds,
  maximumKnowledgeRetrievalCategories,
  maximumKnowledgeRetrievalResults,
  maximumKnowledgeSchemaFields,
  maximumKnowledgeSeeds,
  maximumKnowledgeTextLength,
  parseDomainPackManifest,
  validateDomainPackManifest,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

// GP-15: the typed schema-1 knowledge contribution. The contract package
// validates and canonicalizes it; nothing here reads, seeds or searches a
// knowledge store, and a seed is never resolved.

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
    metadata: { name: "Custom", description: "Knowledge contract fixture" },
    dependencies: [],
    contributions: {
      ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
      ...contributions,
    },
  };
}

const bytes = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));
const withKnowledge = (...knowledge: unknown[]) => manifest({ knowledge });
const parse = (value: unknown) => parseDomainPackManifest(bytes(value));

function failure(value: unknown): { code: string; path: string } {
  try {
    parse(value);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainPackManifestError);
    const { code, path } = error as DomainPackManifestError;
    return { code, path };
  }
  throw new Error("Expected manifest rejection");
}

/** The entry is rejected with `invalid_contribution` at `path`. */
const rejected = (entry: unknown, path: string) =>
  expect([path, failure(withKnowledge(entry))]).toEqual([
    path,
    { code: "invalid_contribution", path },
  ]);

const entry = (member: Record<string, unknown>) => ({ id: "kb", ...member });
const at = (member: string) => `contributions.knowledge[0].${member}`;

const fullEntry = {
  id: "contracts",
  title: "Contract clauses",
  description: "Reference clauses for review",
  category: "clauses",
  schema: [
    { field: "jurisdiction", description: "Where the clause applies" },
    { field: "clause", description: "The clause text" },
  ],
  seeds: ["seed:clauses/standard", "seed:clauses/nda"],
  retrieval: {
    maxResults: 3,
    hint: "Prefer the clause of the matter's jurisdiction",
    categories: ["clauses", "precedents"],
  },
};

describe("GP-15 typed knowledge contributions in the schema-1 manifest", () => {
  test("an entry may declare a category, a schema, seeds and retrieval guidance, each optional", () => {
    const parsed = parse(withKnowledge(fullEntry));
    expect(parsed.contributions.knowledge).toEqual([
      {
        ...fullEntry,
        schema: [
          { field: "clause", description: "The clause text" },
          { field: "jurisdiction", description: "Where the clause applies" },
        ],
        seeds: ["seed:clauses/nda", "seed:clauses/standard"],
      },
    ]);
    for (const member of ["category", "schema", "seeds", "retrieval"] as const)
      expect(
        parse(withKnowledge({ id: "contracts", [member]: fullEntry[member] }))
          .contributions.knowledge[0],
      ).toHaveProperty(member);
    expect(
      parse(withKnowledge({ id: "bare" })).contributions.knowledge,
    ).toEqual([{ id: "bare" }]);
  });

  test("retrieval accepts any non-empty subset of its three members", () => {
    for (const retrieval of [
      { maxResults: 1 },
      { maxResults: knowledgeRetrievalLimits.maxResults },
      { hint: "Short hint" },
      { categories: ["one"] },
      { hint: "h", categories: ["b", "a"] },
    ])
      expect(
        parse(withKnowledge(entry({ retrieval }))).contributions.knowledge[0],
      ).toMatchObject({ retrieval: expect.any(Object) });
  });

  test("the retrieval ceiling is the Runtime's own bound", () => {
    expect(maximumKnowledgeRetrievalResults).toBe(
      knowledgeRetrievalLimits.maxResults,
    );
  });

  test("schema, seeds and retrieval categories are sets: one validated order and one digest for every written order", () => {
    const forward = parse(withKnowledge(fullEntry));
    const reversed = parse(
      withKnowledge({
        ...fullEntry,
        schema: [...fullEntry.schema].reverse(),
        seeds: [...fullEntry.seeds].reverse(),
        retrieval: {
          ...fullEntry.retrieval,
          categories: [...fullEntry.retrieval.categories].reverse(),
        },
      }),
    );
    expect(reversed.contributions.knowledge).toEqual(
      forward.contributions.knowledge,
    );
    expect(computeManifestDigest(reversed)).toBe(
      computeManifestDigest(forward),
    );
    expect(forward.contributions.knowledge[0]!.seeds).toEqual([
      "seed:clauses/nda",
      "seed:clauses/standard",
    ]);
    // Code-unit order, not locale order.
    expect(
      parse(withKnowledge(entry({ seeds: ["b", "B", "a", "Z"] }))).contributions
        .knowledge[0]!.seeds,
    ).toEqual(["B", "Z", "a", "b"]);
  });

  test("a member that is present changes the manifest digest, and each one differently", () => {
    const digest = (member: Record<string, unknown>) =>
      computeManifestDigest(parse(withKnowledge(entry(member))));
    const variants = [
      {},
      { category: "clauses" },
      { category: "precedents" },
      { schema: [{ field: "clause", description: "Text" }] },
      { schema: [{ field: "clause", description: "Other text" }] },
      { seeds: ["seed:a"] },
      { seeds: ["seed:b"] },
      { retrieval: { maxResults: 2 } },
      { retrieval: { maxResults: 3 } },
      { retrieval: { hint: "text" } },
      { retrieval: { categories: ["clauses"] } },
    ];
    expect(new Set(variants.map(digest)).size).toBe(variants.length);
  });

  test("a manifest without typed knowledge keeps its canonical form and digest, and the golden fixtures still verify", () => {
    for (const name of [
      "custom",
      "development",
      "development-0.2.0",
      "development-0.3.0",
      "legal",
      "manufacturing",
    ]) {
      const fixture = readFileSync(
        new URL(`../fixtures/domain-pack/${name}.json`, import.meta.url),
      );
      const verified = verifyDomainPackManifest(fixture);
      expect(computeManifestDigest(verified)).toBe(verified.manifestDigest);
      expect(
        decoder.decode(canonicalizeDomainPackManifest(verified)),
      ).not.toMatch(/"seeds"|"retrieval"|"category"/);
    }
    // A descriptive entry has exactly the canonical members it had before.
    const descriptive = parse(
      withKnowledge({ id: "plain", title: "Plain", description: "Text" }),
    );
    expect(
      decoder.decode(canonicalizeDomainPackManifest(descriptive)),
    ).toContain(
      '"knowledge":[{"description":"Text","id":"plain","title":"Plain"}]',
    );
    // The digest of this literal manifest was computed by the code before
    // GP-15 (35092f8) and is pinned: an additive extension must not change it.
    expect(computeManifestDigest(descriptive)).toBe(
      "sha256:e76a4e9bb4b82b7f9ce512fef2081aa28c7a214e95f0e974c7b5ebf3b001a0bf",
    );
  });

  test("a reader built before GP-15 rejects the typed members as unknown fields: they are not in its allowlist, and never ignored", () => {
    // Before GP-15 a knowledge entry accepted `id`, `title` and `description`.
    const legacyMembers = ["id", "title", "description"];
    const typed = parse(withKnowledge(fullEntry)).contributions.knowledge[0]!;
    expect(
      Object.keys(typed).filter((member) => !legacyMembers.includes(member)),
    ).toEqual(["category", "schema", "seeds", "retrieval"]);
  });

  test("the four members are unknown fields on every other contribution kind", () => {
    const values = {
      category: "clauses",
      schema: [{ field: "clause", description: "Text" }],
      seeds: ["seed:a"],
      retrieval: { maxResults: 1 },
    };
    for (const [member, value] of Object.entries(values))
      for (const kind of contributionKinds) {
        if (kind === "knowledge") continue;
        const item =
          kind === "workflows"
            ? { id: "w", taskType: "change", stages: [], [member]: value }
            : { id: "x", [member]: value };
        expect(failure(manifest({ [kind]: [item] }))).toEqual({
          code: "invalid_contribution",
          path: `contributions.${kind}[0].${member}`,
        });
      }
  });

  test("category is a local ID", () => {
    for (const category of ["", "Has Space", "-lead", 1, null, ["a"], {}])
      rejected(entry({ category }), at("category"));
  });

  test("schema is a non-empty, bounded set of unique fields with a description", () => {
    const field = (name: string) => ({ field: name, description: "Text" });
    rejected(entry({ schema: [] }), at("schema"));
    rejected(entry({ schema: "clause" }), at("schema"));
    rejected(entry({ schema: {} }), at("schema"));
    rejected(entry({ schema: null }), at("schema"));
    rejected(entry({ schema: [field("a"), field("a")] }), at("schema"));
    rejected(entry({ schema: ["a"] }), at("schema[0]"));
    rejected(entry({ schema: [null] }), at("schema[0]"));
    rejected(entry({ schema: [{ field: "a" }] }), at("schema[0].description"));
    rejected(entry({ schema: [{ description: "T" }] }), at("schema[0].field"));
    rejected(
      entry({ schema: [{ field: "Not Local", description: "T" }] }),
      at("schema[0].field"),
    );
    rejected(
      entry({ schema: [{ field: "a", description: "" }] }),
      at("schema[0].description"),
    );
    rejected(
      entry({ schema: [{ field: "a", description: 1 }] }),
      at("schema[0].description"),
    );
    // The description shares the 512 bound of seeds and hints.
    const described = (length: number) => ({
      schema: [{ field: "a", description: "d".repeat(length) }],
    });
    expect(
      parse(withKnowledge(entry(described(maximumKnowledgeTextLength))))
        .contributions.knowledge[0]!.schema![0]!.description,
    ).toHaveLength(maximumKnowledgeTextLength);
    rejected(
      entry(described(maximumKnowledgeTextLength + 1)),
      at("schema[0].description"),
    );
    rejected(
      entry({ schema: [{ field: "a", description: "T", type: "string" }] }),
      at("schema[0].type"),
    );
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => field(`f${index}`));
    expect(
      parse(
        withKnowledge(entry({ schema: many(maximumKnowledgeSchemaFields) })),
      ).contributions.knowledge[0]!.schema,
    ).toHaveLength(maximumKnowledgeSchemaFields);
    rejected(
      entry({ schema: many(maximumKnowledgeSchemaFields + 1) }),
      at("schema"),
    );
  });

  test("seeds are a non-empty, bounded set of unique, bounded manifest text", () => {
    rejected(entry({ seeds: [] }), at("seeds"));
    rejected(entry({ seeds: "seed:a" }), at("seeds"));
    rejected(entry({ seeds: { 0: "a" } }), at("seeds"));
    rejected(entry({ seeds: ["a", "a"] }), at("seeds"));
    rejected(entry({ seeds: [""] }), at("seeds[0]"));
    rejected(entry({ seeds: [1] }), at("seeds[0]"));
    rejected(entry({ seeds: [null] }), at("seeds[0]"));
    rejected(entry({ seeds: [{ uri: "a" }] }), at("seeds[0]"));
    const text = (length: number) => "s".repeat(length);
    expect(
      parse(withKnowledge(entry({ seeds: [text(maximumKnowledgeTextLength)] })))
        .contributions.knowledge[0]!.seeds![0],
    ).toHaveLength(maximumKnowledgeTextLength);
    rejected(
      entry({ seeds: [text(maximumKnowledgeTextLength + 1)] }),
      at("seeds[0]"),
    );
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => `seed:${index}`);
    expect(
      parse(withKnowledge(entry({ seeds: many(maximumKnowledgeSeeds) })))
        .contributions.knowledge[0]!.seeds,
    ).toHaveLength(maximumKnowledgeSeeds);
    rejected(entry({ seeds: many(maximumKnowledgeSeeds + 1) }), at("seeds"));
  });

  test("manifest text rule: a lone surrogate is rejected anywhere in the new members, U+0000 is allowed as in every manifest text", () => {
    // The raw JSON escape of a lone surrogate is rejected by the manifest
    // parser itself (malformed_input), before any contribution is read.
    for (const member of [
      '"seeds":["\\ud800"]',
      '"schema":[{"field":"a","description":"\\udc00"}]',
      '"retrieval":{"hint":"\\ud800x"}',
    ]) {
      const json = JSON.stringify(withKnowledge({ id: "kb" })).replace(
        '{"id":"kb"}',
        `{"id":"kb",${member}}`,
      );
      expect(() => parseDomainPackManifest(encoder.encode(json))).toThrow(
        DomainPackManifestError,
      );
    }
    // GP-23: U+0000 is allowed by design in manifest text, and canonical.
    const parsed = parse(
      withKnowledge(
        entry({
          seeds: ["a\u0000b"],
          schema: [{ field: "a", description: "x\u0000y" }],
          retrieval: { hint: "\u0000" },
        }),
      ),
    );
    expect(parsed.contributions.knowledge[0]!.seeds).toEqual(["a\u0000b"]);
    const canonical = JSON.parse(
      decoder.decode(canonicalizeDomainPackManifest(parsed)),
    ) as Record<string, unknown>;
    expect(
      computeManifestDigest(
        parse({ ...canonical, manifestDigest: parsed.manifestDigest }),
      ),
    ).toBe(computeManifestDigest(parsed));
    // A well-formed surrogate pair is text.
    expect(
      parse(withKnowledge(entry({ seeds: ["\u{1F600}"] }))).contributions
        .knowledge[0]!.seeds,
    ).toEqual(["\u{1F600}"]);
  });

  test("whitespace-only text is accepted, as for every manifest text that must be non-empty", () => {
    const parsed = parse(
      withKnowledge(
        entry({
          seeds: [" "],
          retrieval: { hint: "\t" },
          schema: [{ field: "a", description: "  " }],
        }),
      ),
    );
    expect(parsed.contributions.knowledge[0]!.seeds).toEqual([" "]);
  });

  test("an explicitly undefined member is absent: the in-memory validator, the digest and the byte parser agree", () => {
    const inMemory = (member: Record<string, unknown>) =>
      withKnowledge(entry(member));
    // Rejected everywhere: no defined retrieval member.
    for (const retrieval of [
      { maxResults: undefined },
      { hint: undefined, categories: undefined },
    ]) {
      const value = inMemory({ retrieval });
      for (const run of [
        () => validateDomainPackManifest(value),
        () => computeManifestDigest(value as never),
        // JSON drops undefined, leaving an empty retrieval object.
        () => parse(value),
      ])
        try {
          run();
          throw new Error("Expected manifest rejection");
        } catch (error) {
          expect(error).toBeInstanceOf(DomainPackManifestError);
          expect(error).toMatchObject({
            code: "invalid_contribution",
            path: at("retrieval"),
          });
        }
    }
    // Accepted everywhere, with one canonical form and one digest.
    for (const member of [
      { retrieval: { maxResults: 2, hint: undefined } },
      { category: undefined, seeds: undefined, schema: undefined },
    ]) {
      const value = inMemory(member);
      const viaBytes = parse(value);
      const viaValidator = validateDomainPackManifest(value);
      expect(viaValidator).toEqual(viaBytes);
      expect(computeManifestDigest(value as never)).toBe(
        computeManifestDigest(viaBytes),
      );
    }
    // A schema entry member that is undefined is missing, as in JSON.
    for (const run of [
      () =>
        validateDomainPackManifest(
          inMemory({ schema: [{ field: "a", description: undefined }] }),
        ),
      () =>
        parse(inMemory({ schema: [{ field: "a", description: undefined }] })),
    ])
      expect(run).toThrow(DomainPackManifestError);
  });

  test("retrieval has known members, at least one, and bounded values", () => {
    rejected(entry({ retrieval: {} }), at("retrieval"));
    rejected(entry({ retrieval: [] }), at("retrieval"));
    rejected(entry({ retrieval: "all" }), at("retrieval"));
    rejected(entry({ retrieval: null }), at("retrieval"));
    rejected(entry({ retrieval: { limit: 2 } }), at("retrieval.limit"));
    for (const maxResults of [
      0,
      -1,
      1.5,
      knowledgeRetrievalLimits.maxResults + 1,
      "3",
      null,
      Number.MAX_SAFE_INTEGER,
    ])
      rejected(
        entry({ retrieval: { maxResults } }),
        at("retrieval.maxResults"),
      );
    for (const hint of [
      "",
      1,
      null,
      ["a"],
      "h".repeat(maximumKnowledgeTextLength + 1),
    ])
      rejected(entry({ retrieval: { hint } }), at("retrieval.hint"));
    rejected(
      entry({ retrieval: { categories: [] } }),
      at("retrieval.categories"),
    );
    rejected(
      entry({ retrieval: { categories: "a" } }),
      at("retrieval.categories"),
    );
    rejected(
      entry({ retrieval: { categories: ["a", "a"] } }),
      at("retrieval.categories"),
    );
    rejected(
      entry({ retrieval: { categories: ["Not Local"] } }),
      at("retrieval.categories[0]"),
    );
    rejected(
      entry({
        retrieval: {
          categories: Array.from(
            { length: maximumKnowledgeRetrievalCategories + 1 },
            (_, index) => `c${index}`,
          ),
        },
      }),
      at("retrieval.categories"),
    );
  });

  test("an entry declares no scope, store, endpoint or credential: each such key is an unknown field, in the entry and in every nested object", () => {
    const hostile = [
      "tenantId",
      "repositoryId",
      "projectUid",
      "projectId",
      "scope",
      "store",
      "endpoint",
      "collection",
      "credential",
      "password",
      "namespace",
      "database",
    ];
    for (const key of hostile) {
      rejected(entry({ [key]: "x" }), at(key));
      rejected(
        entry({ retrieval: { maxResults: 1, [key]: "x" } }),
        at(`retrieval.${key}`),
      );
      rejected(
        entry({ schema: [{ field: "a", description: "T", [key]: "x" }] }),
        at(`schema[0].${key}`),
      );
    }
  });

  test("__proto__ is an unknown field and never reaches the validated manifest", () => {
    const json = JSON.stringify(withKnowledge({ id: "kb" })).replace(
      '{"id":"kb"}',
      '{"id":"kb","__proto__":{"seeds":["a"]}}',
    );
    expect(() => parseDomainPackManifest(encoder.encode(json))).toThrow(
      /__proto__/u,
    );
    const nested = JSON.stringify(withKnowledge({ id: "kb" })).replace(
      '{"id":"kb"}',
      '{"id":"kb","retrieval":{"maxResults":1,"__proto__":{}}}',
    );
    expect(() => parseDomainPackManifest(encoder.encode(nested))).toThrow(
      /__proto__/u,
    );
    expect(({} as { seeds?: unknown }).seeds).toBeUndefined();
  });

  test("an agent still references a declared knowledge entry by local ID, and nothing else about it changes", () => {
    const parsed = parse(
      manifest({
        knowledge: [fullEntry],
        roles: [{ id: "counsel" }],
        agents: [{ id: "helper", role: "counsel", knowledge: ["contracts"] }],
      }),
    );
    expect(parsed.contributions.agents[0]!.knowledge).toEqual(["contracts"]);
    expect(
      failure(
        manifest({
          roles: [{ id: "counsel" }],
          agents: [{ id: "helper", role: "counsel", knowledge: ["missing"] }],
        }),
      ).code,
    ).toBe("invalid_contribution");
  });

  test("hostile seed strings are opaque text kept byte for byte", () => {
    const seeds = [
      "file:///etc/passwd",
      "../../../secret",
      "http://169.254.169.254/latest/meta-data",
      "<script>alert(1)</script>",
      "$(rm -rf /)",
      "'; DROP TABLE knowledge; --",
      "surreal://tenant-b/repository-b/memory",
      "C:\\Windows\\System32",
      "  padded  ",
    ];
    const parsed = parse(withKnowledge(entry({ seeds })));
    expect(parsed.contributions.knowledge[0]!.seeds).toEqual(
      [...seeds].sort((left, right) => (left < right ? -1 : 1)),
    );
  });
});

describe("GP-15 plan record", () => {
  const plan = readFileSync(
    new URL(
      "../../docs/development/generic-core-domain-packs.md",
      import.meta.url,
    ),
    "utf8",
  ).replace(/\s+/gu, " ");

  test("the contract section, the reworded row and the rows note say the same", () => {
    expect(plan).toContain("## GP-15 pack knowledge guidance");
    expect(plan).toContain("Definition layer only; store untouched.");
    // The GP-15 bullet of the rows owned by other pull requests is gone.
    expect(plan).not.toContain("GP-15. The row still reads as use of the");
    for (const statement of [
      "Persistence None.",
      "### Scope compatibility plan",
      "`knowledge_change_requires_upgrade`",
    ])
      expect(plan).toContain(statement);
  });

  test("the development pack still declares no knowledge entry, so no statement says otherwise", () => {
    expect(plan).toContain(
      "the development reference pack still declares no knowledge entry",
    );
  });
});

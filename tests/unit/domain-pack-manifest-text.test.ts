import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DomainPackManifestError,
  canonicalizeDomainPackManifest,
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
  validateDomainPackManifest,
  verifyDomainPackManifest,
  type DomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";

// GP-23 outcome: U+0000 is allowed in pack manifest text by design. Manifest
// text is never written to project storage; these tests pin the manifest half
// of that decision. The storage half is in
// tests/integration/pack-manifest-nul-policy.test.ts.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NUL = "\u0000";
const template = JSON.parse(
  readFileSync(
    new URL("../fixtures/domain-pack/custom.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown> & {
  metadata: Record<string, string>;
  contributions: Record<string, Record<string, unknown>[]>;
};

/** A manifest with one item in every section, references kept valid. */
function base(): typeof template {
  const manifest = structuredClone(template);
  for (const kind of contributionKinds)
    manifest.contributions[kind] = [
      kind === "workflows"
        ? {
            id: "item",
            taskType: "item",
            stages: [{ id: "stage", role: "item" }],
          }
        : { id: "item" },
    ];
  return manifest;
}

function signed(manifest: Record<string, unknown>): Uint8Array {
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));
  return bytes({
    ...manifest,
    manifestDigest: computeManifestDigest(
      parseDomainPackManifest(bytes(manifest)),
    ),
  });
}

/** Every free-text field a schema-1 manifest can carry. */
const textFields: readonly (readonly [
  string,
  (manifest: typeof template, text: string) => void,
  (manifest: DomainPackManifest) => string | undefined,
])[] = [
  [
    "metadata.name",
    (manifest, text) => (manifest.metadata.name = text),
    (manifest) => manifest.metadata.name,
  ],
  [
    "metadata.description",
    (manifest, text) => (manifest.metadata.description = text),
    (manifest) => manifest.metadata.description,
  ],
  ...contributionKinds.flatMap((kind) =>
    (["title", "description"] as const).map(
      (field) =>
        [
          `contributions.${kind}[0].${field}`,
          (manifest: typeof template, text: string) =>
            (manifest.contributions[kind]![0]![field] = text),
          (manifest: DomainPackManifest) =>
            manifest.contributions[kind][0]?.[field],
        ] as const,
    ),
  ),
];

function manifestError(action: () => unknown): DomainPackManifestError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainPackManifestError);
    return error as DomainPackManifestError;
  }
  throw new Error("expected manifest error");
}

describe("GP-23 pack manifest text and U+0000", () => {
  test("the field list covers every string a manifest carries outside identities", () => {
    // 2 metadata fields plus title and description of each of the 11 kinds.
    expect(textFields).toHaveLength(2 + contributionKinds.length * 2);
  });

  test.each(textFields)(
    "%s accepts U+0000 and preserves it through parsing, canonicalization and digests",
    (_path, write, read) => {
      const plain = base();
      write(plain, "a-b");
      const withNul = base();
      write(withNul, `a${NUL}b`);
      const bytes = signed(withNul);

      // JSON.stringify writes the escape, so the artifact has no raw 0x00.
      expect(bytes.includes(0)).toBe(false);
      expect(decoder.decode(bytes)).toContain("a\\u0000b");

      const manifest = verifyDomainPackManifest(bytes, 1);
      expect(read(manifest)).toBe(`a${NUL}b`);
      expect(read(validateDomainPackManifest(manifest))).toBe(`a${NUL}b`);

      // RFC 8785 serializes U+0000 as the six characters \u0000.
      const canonical = canonicalizeDomainPackManifest(manifest);
      expect(canonical.includes(0)).toBe(false);
      expect(decoder.decode(canonical)).toContain("a\\u0000b");
      expect(
        read(
          parseDomainPackManifest(
            encoder.encode(
              JSON.stringify({
                ...(JSON.parse(decoder.decode(canonical)) as object),
                manifestDigest: manifest.manifestDigest,
              }),
            ),
          ),
        ),
      ).toBe(`a${NUL}b`);

      // The character is identity material like any other: no normalization.
      const digest = computeManifestDigest(manifest);
      expect(digest).toBe(manifest.manifestDigest);
      expect(computeManifestDigest(parseDomainPackManifest(bytes))).toBe(
        digest,
      );
      expect(digest).not.toBe(
        computeManifestDigest(parseDomainPackManifest(signed(plain))),
      );
      expect(computeArtifactDigest(bytes)).toBe(computeArtifactDigest(bytes));
      expect(computeArtifactDigest(bytes)).not.toBe(
        computeArtifactDigest(signed(plain)),
      );
    },
  );

  test("a raw 0x00 byte stays a JSON syntax error, which is not a text rule", () => {
    const manifest = base();
    manifest.metadata.name = `a${NUL}b`;
    const raw = decoder.decode(signed(manifest)).replace("\\u0000", NUL);
    const error = manifestError(() =>
      parseDomainPackManifest(encoder.encode(raw)),
    );
    expect([error.code, error.path, error.message]).toEqual([
      "malformed_input",
      "$",
      "$: unescaped control character",
    ]);
  });

  test.each(textFields)(
    "%s still rejects a lone surrogate, which has no canonical form",
    (path, write) => {
      const manifest = base();
      write(manifest, "a\ud800b");
      // From bytes the strict reader refuses the escape before any field.
      const parsed = manifestError(() =>
        parseDomainPackManifest(encoder.encode(JSON.stringify(manifest))),
      );
      expect([parsed.code, parsed.path]).toEqual(["malformed_input", "$"]);
      // From a value the field itself is refused, with its path.
      const validated = manifestError(() =>
        validateDomainPackManifest(manifest),
      );
      expect([validated.code, validated.path]).toEqual([
        path.startsWith("metadata.")
          ? "malformed_input"
          : "invalid_contribution",
        path,
      ]);
    },
  );

  test("valid non-BMP text and other control characters are preserved unnormalized", () => {
    const text = `\u{1f600} é é \u0001\u001f\u007f ${NUL}`;
    const manifest = base();
    manifest.metadata.description = text;
    manifest.contributions.roles![0]!.title = text;
    const verified = verifyDomainPackManifest(signed(manifest), 1);
    expect(verified.metadata.description).toBe(text);
    expect(verified.contributions.roles[0]?.title).toBe(text);
  });

  test("no bundled fixture manifest contains U+0000", () => {
    for (const name of ["custom", "development", "legal", "manufacturing"]) {
      const source = readFileSync(
        new URL(`../fixtures/domain-pack/${name}.json`, import.meta.url),
      );
      expect(source.includes(0)).toBe(false);
      expect(decoder.decode(source)).not.toMatch(/\\u0000/iu);
    }
  });
});

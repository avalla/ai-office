# Domain Pack contracts (schema 1)

This package supplies the public, domain-neutral Domain Pack manifest contract
from [ADR-0026](../../docs/adr/ADR-0026-core-domain-pack-boundary.md), subject
to [ADR-0027](../../docs/adr/ADR-0027-cross-domain-authority-and-evidence.md).
It provides branded identity, exact version and digest types; typed contribution,
dependency and core compatibility envelopes; strict UTF-8 JSON parsing; schema
validation; deterministic canonicalization; and digest verification.

Import the public API from `src/index.ts`. `parseDomainPackManifest(bytes)`
validates file bytes and returns a typed `DomainPackManifest`.
`canonicalizeDomainPackManifest(manifest)` returns the exact UTF-8 digest input.
`computeManifestDigest(manifest)` hashes that input. `verifyDomainPackManifest`
also compares the declared digest and optionally checks a supplied integer core
contract version. `computeArtifactDigest(bytes)` hashes exact file bytes; it
does not validate provenance. Failures are `DomainPackManifestError` values
with a stable `code` and `path`.

The reader rejects a BOM, malformed UTF-8 or JSON, duplicate decoded keys at
any depth, lone Unicode surrogates, nonfinite numbers and integer literals
outside the interoperable safe-integer range. Schema 1 requires every envelope
field and contribution section. Contribution items currently accept only an
ASCII `id` and optional `title`/`description`; workflow items also have a
`taskType` and ordered `stages` with `id`/`role`. Unknown fields fail validation,
including executable entry points and embedded credentials. Later GP slices
must explicitly extend section schemas before they can add fields.

For `manifestDigest`, validation removes only the root `manifestDigest`, sorts
`dependencies` and each top-level contribution array by unique ASCII `id`,
retains all other array order, serializes JSON with RFC 8785 object-key and
primitive rules, and hashes the UTF-8 bytes with SHA-256. The four fixtures in
`tests/fixtures/domain-pack` contain reproducible golden digests. A matching
digest identifies content; it is not a signature or trust decision.

This package does not implement the installed-pack catalog, project binding,
dependency resolver, project overrides, Development Pack, installation
lifecycle, remote registry, multi-file artifacts, KnowledgeScopeV2, portable
`projectUid` persistence, evidence storage, professional identity or trusted
validator execution. Those remain separate roadmap work.

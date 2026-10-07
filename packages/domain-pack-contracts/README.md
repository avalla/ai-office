# Domain Pack contracts (schema 1)

This package supplies the public, domain-neutral Domain Pack manifest contract
from [ADR-0026](../../docs/adr/ADR-0026-core-domain-pack-boundary.md), subject
to [ADR-0027](../../docs/adr/ADR-0027-cross-domain-authority-and-evidence.md).
It provides branded identity, exact version and digest types; typed contribution,
dependency and core compatibility envelopes; strict UTF-8 JSON parsing; schema
validation; deterministic canonicalization; and digest verification.

"Public" names the supported contract boundary for pack authors and future
official packs inside the workspace. The package remains `private: true`
because npm publication and versioned external distribution are outside GP-03.
Publication requires a later explicit packaging decision; it is not implied by
this manifest API.

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
`taskType` and ordered `stages` with `id`/`role`, role items may have
`capabilities`, agent items may have `role`, `prompts`, `knowledge` and
`capabilities`, capability items may have `operations` and `requirement`,
policy items may have `workflow`, `enforcement` and `stages`, and GP-10B-2 adds
descriptive fields to stages, roles, prompts and workflows (see below).
Unknown fields fail validation,
including executable entry points and embedded credentials. Later GP slices
must explicitly extend section schemas through a compatible manifest/schema
decision before they can add fields. The current generic `Contribution` type is
not the final field-level schema for artifact types, evidence types,
knowledge, capabilities, prompts or validators, and the agent fields
below are not the final agent schema: model, tools, pipeline participation and
approval eligibility are not expressible.

A role item may carry an optional `capabilities` array of local IDs (GP-11).
Every entry must be a valid, unique local ID naming an item of the same
manifest's `contributions.capabilities`. The list holds at most 1,000 entries
(`maximumContributionReferences`, the bound GP-12 introduced for every
reference list and applies to this one as a uniformity rule). A non-array
value, an empty array, a list over the bound, a
malformed or duplicate ID, an undeclared capability and the field on any other
contribution kind fail with `invalid_contribution` and the member's path. The
field is omitted when a role has no capabilities; an empty array is not a
second encoding. References are bare local IDs, so schema 1 cannot express a
capability of another pack, including a dependency. The list is a set: the
validated manifest holds it in ascending code-unit order, and that order is
what the digest covers. The association is declarative and grants nothing.

An agent item may carry four optional reference fields (GP-12): `role`, one
local ID naming an item of the same manifest's `contributions.roles`, and
`prompts`, `knowledge` and `capabilities`, arrays of local IDs naming items of
`contributions.prompts`, `contributions.knowledge` and
`contributions.capabilities`. The arrays follow the rules of a role's
`capabilities`: valid, unique local IDs, no empty array, at most 1,000 entries
(`maximumContributionReferences`, which also bounds a role's `capabilities`
since GP-12), ascending code-unit
order in the validated manifest and in the digest input. An agent's
`capabilities` are requested capabilities and are bounded by its role: the
field requires `role`, and every entry must be in that role's `capabilities`.
A malformed `role`, a non-array or empty list, a malformed or duplicate entry,
an undeclared reference, a request without a role, a request outside the
role's set and any of the fields on another contribution kind fail with
`invalid_contribution` and the member's path. References are bare local IDs,
so a definition of another pack, including a dependency, cannot be named. The
references are declarative: they create no Runtime agent and grant nothing.

A capability item may carry two optional members (GP-16). `operations` is an
array of `{ "operation", "mode" }` objects: `operation` is a connector
operation name, `<connectorId>.<name>`, and `mode` is `read` or `mutation`. A
name is ASCII, at most 128 characters, two or more segments separated by `.`,
each starting with a letter or digit and continuing with letters, digits, `_`
or `-`; a wildcard is not a name. The array holds at least one and at most 100
entries (`maximumCapabilityOperations`) and names an operation once. It is a
set: the validated manifest holds it in ascending code-unit order of the
operation name, and that order is what the digest covers. `requirement` is
`required` or `optional` and is allowed only with `operations`; when
`operations` is present and `requirement` is absent, the validated manifest
and the digest input hold `required`, so the default has one canonical form.
A non-array, empty, over-bound or duplicate list, a malformed name, an unknown
mode or requirement, `requirement` without `operations`, any other member of
an operation entry and either field on another contribution kind fail with
`invalid_contribution` and the member's path. A capability cannot declare
risk, approval, constraints, a resource, a grant, a principal, a credential
or a provider version: those are unknown fields. The declaration states a
need. It grants nothing, and whether a registered provider satisfies it is
decided by the Runtime host at resolution, not by this package.

A policy item may carry three optional fields (GP-25): `workflow`, one local
ID naming an item of the same manifest's `contributions.workflows`,
`enforcement`, whose only value is `"enforced"`, and `stages`, an array of
`{ stage, requiresApproval?, requiresIndependentApproval?,
requiresDifferentAgentFrom?, operations? }`. `stage` names a stage of the
target workflow, the two flags are present only as `true`,
`requiresDifferentAgentFrom` lists earlier stages of that workflow, and
`operations` lists at most 64 (`maximumPolicyStageOperations`) operation
names of the form `^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$` and at most 128
characters. A policy with `workflow` is typed and must declare `enforcement`
or `stages`; one manifest declares at most one policy for a workflow. An
unknown workflow or stage, a duplicate stage entry, a second policy for a
workflow, a stage entry without a clause, `requiresIndependentApproval`
without `requiresApproval`, a separation target that is not an earlier stage,
an empty list, a malformed, duplicate or over-bound operation, a flag or
`enforcement` with another value, a clause field without `workflow` and any
of the fields on another contribution kind fail with `invalid_contribution`
and the member's path. Absent `enforcement` means guidance and absent
`operations` means that no operation is admitted. `stages`, `operations` and
`requiresDifferentAgentFrom` are sets: the validated manifest holds them in
ascending code-unit order (`stages` by `stage`), and that order is what the
digest covers. Operation names are opaque strings, not references to
`contributions.capabilities`. The clauses are declarative: they are not
enforced by this package or by the Runtime and grant nothing. A policy
without `workflow` still parses as `id`, `title` and `description`.

A knowledge item may carry four optional fields (GP-15): `category`, one local
ID; `schema`, an array of `{ field, description }` with a local-ID `field`, a `description` of at most 512 UTF-16 code units and
at most 64 entries (`maximumKnowledgeSchemaFields`); `seeds`, at most 64
(`maximumKnowledgeSeeds`) opaque reference strings of at most 512 UTF-16 code units
(`maximumKnowledgeTextLength`); and `retrieval`, an object with at least one of
`maxResults` (an integer from 1 to `maximumKnowledgeRetrievalResults`, the
Runtime's retrieval bound), `hint` (text of at most 512 UTF-16 code units) and
`categories` (at most 64 local IDs). A non-array, empty, over-bound or
duplicate list, a malformed local ID, an empty, over-long or non-text value,
an empty or unknown `retrieval` member, any scope, tenant, repository,
project, store, endpoint, collection or credential key and any of the fields
on another contribution kind fail with `invalid_contribution` and the member's
path. `schema` is held in ascending code-unit order of `field`, and `seeds`
and `retrieval.categories` in ascending code-unit order, so the digest does
not depend on the written order; a member is canonical only when present, so a
manifest without them keeps its digest. Whitespace-only text is accepted, as for every non-empty manifest text. A seed is opaque text: this package
never parses, resolves or fetches it. The fields are declarative guidance
that this package does not read, seed or search, and a pack declares no
scope.

Descriptive vocabulary (GP-10B-2). A workflow stage may carry `title`,
`objective` and `checks`; a role item `responsibilities`; a prompt item
`text`; and a workflow item `additionalTaskTypes`. All are optional.
`title` and `objective` are manifest text. `checks` and `responsibilities`
are ordered lists of 1 to 64 entries (`maximumDescriptiveListEntries`), each
a non-empty string under the manifest text rule; duplicates are allowed, the
written order is kept and it is what the digest covers. `text` is manifest
text that must be non-empty, as must each `checks` and `responsibilities`
entry; these are exceptions to the rule below.
`additionalTaskTypes` is a set like a role's `capabilities`: 1 to 1,000
valid, unique local IDs, each naming an item of the same manifest's
`contributions.taskTypes` and none equal to the workflow's `taskType`, held
in ascending code-unit order. A workflow's routes are its `taskType` and its
`additionalTaskTypes`; schema 1 does not require that a task type is named by
only one workflow. A non-array, empty or over-bound list, a non-string, empty
or lone-surrogate entry, an empty `text`, a malformed, duplicate or
undeclared additional task type or one equal to `taskType`, and any of the
fields on another contribution kind or level fail with `invalid_contribution`
and the member's path. The fields are declarative: nothing is executed,
scheduled or sent to a provider because of them.

Versioning and compatibility: these are additive section-schema extensions.
The manifest stays schema 1 and the core contract version stays 1. A manifest
that omits the fields has the same canonical form and `manifestDigest` as
before. A reader built before an extension rejects a manifest that uses its
fields as unknown fields; no reader ignores them.

Manifest text is `metadata.name`, `metadata.description`, every
contribution `title` and `description`, and the GP-10B-2 descriptive text: a
stage `title` and `objective`, every `checks` and `responsibilities` entry
and a prompt `text`. One rule covers all of them: a string
without a lone Unicode surrogate. The text is not normalized and has no length
bound, valid non-BMP characters are kept, and control characters are allowed
when JSON-escaped, U+0000 included (GP-23). U+0000 is written `\u0000` in the
file and in the canonical form; a raw 0x00 byte is malformed JSON. This differs
on purpose from project definition text, which is bounded to 16,000 UTF-16
code units and rejects U+0000 because it is stored in project storage, where
PostgreSQL `jsonb` cannot hold the character. Manifest text is not stored
there: it stays in the artifact bytes and in resolved output. An upgrade
resolution that would copy template text into a project override
(`convert_to_replace`) is checked against the project rule and refused when
the text does not fit it.

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

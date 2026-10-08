# Domain Pack authoring and operations (M16)

This guide describes the implemented **definition layer**. A Domain Pack is an
immutable, versioned manifest of defaults. A project explicitly selects exact
pack tuples and owns its definitions and overrides. Resolution produces a
read-only effective configuration; the Runtime still executes its legacy
office, roles, agents and pipelines. Pack-driven execution and persisted pack
run pins belong to M16.5.

There is no pack marketplace, remote registry, `pack:install` command or
`pack:validate` command. The production Runtime currently composes an empty
installed-pack catalog. The local registration example below is for a trusted
test host and lasts only as long as that host process. Do not treat it as an
installation into the persistent Runtime.

## Author and validate a manifest

Use a [schema-1 reference manifest](../../packages/domain-pack-legal/manifest.json)
as a structural example and the [public contract](../../packages/domain-pack-contracts/README.md)
for field rules. The other reference manifests are
[development](../../packages/domain-pack-development/manifest.json) and
[manufacturing](../../packages/domain-pack-manufacturing/manifest.json).
Each manifest has `schemaVersion: 1`, a reverse-DNS `id`, an exact
`MAJOR.MINOR.PATCH` `version`, a root `manifestDigest`, a compatible integer
`coreContract` interval, metadata, exact dependency tuples and all contribution
arrays. The current contract requires every contribution section, even when it
is empty. Use local IDs for definitions and local references; `workflows.stages`
are ordered. A new immutable version is required when the manifest content
changes. Never reuse an `(id, version)` for different bytes.

The public parser rejects malformed UTF-8/JSON, duplicate keys, unknown fields,
bad references and unsupported contribution shapes. It parses but does not
compare the declared digest. After editing a copied manifest, calculate its
new semantic digest from the exact file bytes, then set the root
`manifestDigest` to the result:

```bash
bun -e '
import { readFileSync } from "node:fs";
import { computeManifestDigest, parseDomainPackManifest } from "./packages/domain-pack-contracts/src/index.ts";
const bytes = readFileSync(process.argv[1]);
console.log(computeManifestDigest(parseDomainPackManifest(bytes)));
' packages/domain-pack-legal/manifest.json
```

Run this verification from the repository root against the final file. The
`1` is the current core contract version used by the reference test hosts:

```bash
bun -e '
import { readFileSync } from "node:fs";
import { computeArtifactDigest, verifyDomainPackManifest } from "./packages/domain-pack-contracts/src/index.ts";
const bytes = readFileSync(process.argv[1]);
const pack = verifyDomainPackManifest(bytes, 1);
console.log(JSON.stringify({
  id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest,
  artifactDigest: computeArtifactDigest(bytes),
}));
' packages/domain-pack-legal/manifest.json
```

`manifestDigest` identifies canonical manifest content; `artifactDigest`
identifies the exact installed UTF-8 bytes. Neither proves that an installer is
trusted. Dependencies and project selections use exact `(id, version,
manifestDigest)` tuples, not version ranges or `artifactDigest`.

For a local test host, a trusted installer registers those exact bytes through
the [catalog adapter](../../packages/runtime-host/src/installed-domain-pack-catalog.ts).
This runnable example creates an **ephemeral** catalog and prints the tuple it
registered:

```bash
bun -e '
import { readFileSync } from "node:fs";
import { computeArtifactDigest } from "./packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "./packages/runtime-host/src/installed-domain-pack-catalog.ts";
const bytes = readFileSync(process.argv[1]);
const catalog = new InMemoryInstalledDomainPackCatalog(1, ["local-demo"]);
const tuple = catalog.register({
  bytes, artifactDigest: computeArtifactDigest(bytes),
  provenance: { installerId: "local-demo", reference: "local-fixture" },
});
console.log(JSON.stringify(tuple));
' packages/domain-pack-legal/manifest.json
```

The host chooses trusted installer IDs. A manifest cannot trust itself. The
catalog rechecks bytes, both digests, schema, compatibility and provenance.
Its registrations are process-local; project bindings are separate persistent
state. The [reference tests](#exercise-the-four-examples) supply trusted
catalogs to Runtime test hosts. The shipped persistent host supplies no
official packs, so a nonempty selection there reports unavailable packs.

## Select and customize definitions

The commands below are the actual CLI surface. They require a reachable
Runtime, an existing `PROJECT_ID`, and, for a nonempty selection, a trusted
host that has registered the exact artifacts. `project:create "Pack demo"`
creates a project. With `--json`, its output contains `projectId` and
`created`; set `PROJECT_ID` from that value before using the commands:

```bash
ai-office project:create "Pack demo" --json
```

Derive `PACKS` from a verified file; this example uses the legal reference
artifact:

```bash
PACKS=$(bun -e '
import { readFileSync } from "node:fs";
import { verifyDomainPackManifest } from "./packages/domain-pack-contracts/src/index.ts";
const pack = verifyDomainPackManifest(readFileSync(process.argv[1]), 1);
console.log(JSON.stringify([{
  id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest,
}]));
' packages/domain-pack-legal/manifest.json)
```

Read the current revisions; do not assume they are zero on an existing
project.

```bash
ai-office project:pack:show --project "$PROJECT_ID" --json
ai-office project:pack:preview --project "$PROJECT_ID" --packs "$PACKS" --json
ai-office project:pack:apply --project "$PROJECT_ID" --packs "$PACKS" --expected-revision 0 --json
ai-office project:configuration:show --project "$PROJECT_ID" --json
```

`PACKS` is a JSON array of only `id`, `version` and `manifestDigest` objects;
use the values returned by manifest verification or catalog registration. The
example revision `0` applies only when `project:pack:show` reported
`configurationRevision: 0`. Preview is read-only. Apply checks the exact
revision, resolves the installed dependency closure and audits a changed
selection. A missing artifact, untrusted provenance, wrong digest, incompatible
core contract, duplicate active pack version, dependency problem, or collision
with a project-owned definition blocks the change. Selection is explicit;
installing an artifact never selects it for a project.

`project:pack:preview` prints its report and exits 1 when it contains issues.

Project definitions have a **separate** revision. Use
`project:definition:show` to read it, then preview and apply a single mutation:

```bash
MUTATION='{"action":"put_owned","kind":"roles","id":"gardener","enabled":true,"payload":{"id":"gardener","title":"Volunteer gardener"}}'
ai-office project:definition:show --project "$PROJECT_ID" --json
ai-office project:definition:preview --project "$PROJECT_ID" --mutation "$MUTATION" --json
ai-office project:definition:apply --project "$PROJECT_ID" --mutation "$MUTATION" --expected-revision 0 --json
```

The example definition revision `0` applies only to a new definition state.
`put_owned` needs no pack; an empty `packs: []` selection is valid. To customize
a pack definition, use `put_override` with its exact source tuple plus `kind`
and `localId`. This example prepares a replacement for the legal pack's
`researcher` role; run it only after that pack is selected in a trusted test
host:

```bash
OVERRIDE=$(bun -e '
import { readFileSync } from "node:fs";
import { verifyDomainPackManifest } from "./packages/domain-pack-contracts/src/index.ts";
const pack = verifyDomainPackManifest(readFileSync(process.argv[1]), 1);
console.log(JSON.stringify({
  action: "put_override",
  source: { id: pack.id, version: pack.version, manifestDigest: pack.manifestDigest,
    kind: "roles", localId: "researcher" },
  operation: "replace",
  payload: { id: "researcher", title: "Senior legal researcher" },
}));
' packages/domain-pack-legal/manifest.json)
ai-office project:definition:preview --project "$PROJECT_ID" --mutation "$OVERRIDE" --json
ai-office project:definition:apply --project "$PROJECT_ID" --mutation "$OVERRIDE" --expected-revision "$DEFINITION_REVISION" --json
```

Set `DEFINITION_REVISION` from `project:definition:show` and run the apply
command only after inspecting the preview. Other kinds support the applicable
`replace`, `extend` or `disable` operations. Preview reports the ownership
transition and typed issues before any write; `project:definition:show` and
`project:definition:preview` exit 1 when they report issues. Replacing an
existing owned entry or override also requires its `expectedEntryRevision`.
A project may add, replace or disable optional defaults, but cannot weaken
mandatory pack policy or core approvals, mint grants, or change Runtime
authority. `project:configuration:show` is a derived read; it does not activate
roles, agents or workflows.

For removal, preview a `remove_owned` mutation such as
`{"action":"remove_owned","kind":"roles","id":"gardener"}`, or a
`remove_override` mutation with the same exact `source` object used by
`put_override`. Apply with the current **project definition** revision after
review. To deselect all packs, use `--packs '[]'` with the binding preview and,
when reconciliation is needed, the upgrade flow below; an empty selection
does not automatically delete project-owned definitions.

## Review conflicts and upgrades

Use `project:pack:upgrade` for an existing selection change that alters a
pack-owned contract or needs override reconciliation. `project:pack:apply`
does not carry project overrides to a new tuple. Without `--approve`, upgrade
prints a read-only plan with template changes, override outcomes, issues,
authoritative revisions, and `planDigest`. An issue-free resolvable plan also
has a prospective configuration digest.
Set `NEXT_PACKS` from the new, verified manifest using the same tuple command
as for `PACKS`; include the complete desired selection, not just the changed
pack:

```bash
RESOLUTIONS='[]'
ai-office project:pack:upgrade --project "$PROJECT_ID" --packs "$NEXT_PACKS" --resolutions "$RESOLUTIONS" --json
```

If the plan reports a conflict, inspect its exact source. Supported explicit
resolutions include `remove_override` and, where valid,
`retain_as_project_owned`; `convert_to_replace` applies only to an extension
conflict. Replace `RESOLUTIONS` with the reviewed JSON array, preview again, and resolve
every issue. A source definition removed upstream, a removed pack, competing
overrides, a newly occupied extension field, an owned-definition collision,
or a stronger role/capability/policy contract can block the plan. There is no
automatic winner or silent downgrade of mandatory policy.

For a conflict involving the earlier legal `researcher` override, this is the
exact resolution shape. It uses the **old** selected tuple from `PACKS`:

```bash
RESOLUTIONS=$(bun -e '
const old = JSON.parse(process.argv[1])[0];
console.log(JSON.stringify([{
  source: { ...old, kind: "roles", localId: "researcher" },
  action: "remove_override",
}]));
' "$PACKS")
ai-office project:pack:upgrade --project "$PROJECT_ID" --packs "$NEXT_PACKS" --resolutions "$RESOLUTIONS" --json
```

Use a resolution only for a conflict the plan actually reports. Its object
has exactly `source` and `action`; `source` has the old `id`, `version`,
`manifestDigest`, `kind` and `localId`.

After reviewing an issue-free plan, copy **that plan's** digest and apply the
same desired tuples and resolutions:

```bash
ai-office project:pack:upgrade --project "$PROJECT_ID" --packs "$NEXT_PACKS" --resolutions "$RESOLUTIONS" --approve "$PLAN_DIGEST" --json
```

The Runtime recomputes the plan before writing. Changed revisions, installed
artifacts, tuples or resolutions invalidate the digest; preview and review
again. A successful upgrade audits the selection and reconciled definitions.
It does not mutate the installed catalog or execute a pack workflow.

## Exercise the four examples

| Example          | Source                                                                    | What the test proves                                                                                                       |
| ---------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Development      | [manifest](../../packages/domain-pack-development/manifest.json)          | Expressible definitions match the legacy five-kind development profile; legacy execution stays authoritative.              |
| Legal            | [manifest](../../packages/domain-pack-legal/manifest.json)                | Matter definitions bind, resolve, customize and survive a reviewed upgrade; no legal service is run.                       |
| Manufacturing    | [manifest](../../packages/domain-pack-manufacturing/manifest.json)        | Production-order definitions and evidence resolve; a project inspector survives an upgrade; no MES/ERP/PLC operation runs. |
| Pack-free garden | [fixture](../../tests/fixtures/project-definitions/community-garden.json) | Zero selected packs support project-owned roles, agents, workflow, artifacts and knowledge.                                |

Run the committed integration examples and the shared four-project gate from
the repository root:

```bash
bunx --bun vitest run tests/integration/development-pack-parity.test.ts tests/integration/legal-reference-pack.test.ts tests/integration/manufacturing-reference-pack.test.ts tests/integration/custom-domain-definitions.test.ts tests/integration/four-domain-definition-gate.test.ts
```

The [Unix-socket CLI tests](../../tests/e2e/daemon-cli.test.ts) exercise the
`project:pack:*`, `project:definition:*` and
`project:configuration:show` commands with test-supplied catalogs:

```bash
bunx --bun vitest run tests/e2e/daemon-cli.test.ts -t 'previews and applies an explicit project pack binding over the socket|previews, blocks and applies a pack upgrade over the socket'
```

The [M16 plan](generic-core-domain-packs.md) records detailed conflict and
compatibility rules; [ADR-0026](../adr/ADR-0026-core-domain-pack-boundary.md)
records the core/pack authority boundary.

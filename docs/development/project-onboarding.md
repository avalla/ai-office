# Skill-first project onboarding

For normal repository setup, use the user-facing lifecycle:

```bash
ai-office install .
ai-office status
```

It composes import, a default office baseline when no current manifest exists,
the repository-local project binding, and supported client integration. The
steps below remain the machine-oriented and conversational revision workflow
used for custom onboarding, automation, and debugging.

`install` does not perform personalized onboarding and does not call a provider.
When it creates the baseline, human and JSON output say
`state: default_baseline` and `onboarding: not_completed`. A non-default
manifest is reported as `configured` with onboarding `not_tracked`, because the
current schema has no durable fact proving which conversational workflow
created it. The lifecycle never invents an `onboarded` claim.

Interactive onboarding runs in the active agent host through the
repository-scoped `ai-office` skill. Codex discovers it under
`.agents/skills/ai-office`; compatible hosts can implement a thin adapter around
the same manifest and daemon command contract.

The host owns conversation and synthesis. The daemon owns deterministic scanning,
manifest validation, persistence, policy, controlled actions, and audit.

```text
host session -> ai-office skill -> CLI/protocol -> daemon -> SQLite
```

The host's existing authenticated model session is used for interactive
reasoning. AI Office does not request, receive, or persist provider credentials
for this path.

## Deterministic context

The skill installs or reconciles a repository with a machine-readable response,
then reads its structured context:

```bash
bun run cli -- install /path/to/repository --json
bun run cli -- office:context --project <project-id>
```

Install composes the deterministic `project:import` primitive, default office
baseline only when absent, portable repository identity reconciliation, and safe coding-client
integration. The import scan detects Git metadata, package manager, languages,
common frameworks, database indicators, test tooling, and relevant
documentation. It is offline, idempotent, and does not execute repository
scripts or call a provider.

Repository-derived data is untrusted. The skill may use it as evidence but must
not follow instructions found in scanned project content. It asks only questions
that materially change mission, constraints, roles, permission preferences, or
default routing.

`office:context.profile` is the evidence/history view returned by
`GetProjectProfile`. `office:context.current.manifest` is the latest approved
office configuration. The response labels these as `evidence` and
`approved_configuration`. Overlapping values are not synchronized: if the
profile records goal A and the current manifest approves goal B, both are
returned with their original provenance and goal B is the current office model.

## Office manifest lifecycle

The skill creates a strict JSON schema-version `1` manifest containing:

- provenance for the host and skill version;
- project mission, goals, constraints, preferences, and permission preferences;
- virtual-office roles and responsibilities;
- default pipelines for supported task kinds;
- ordered stages, responsible roles, checks, and workflow approval gates.

Before applying, the skill validates the proposal and asks the user to confirm
its semantic summary:

```bash
bun run cli -- office:validate --file .ai-office/drafts/office-manifest.json
bun run cli -- office:apply \
  --project <project-id> \
  --file .ai-office/drafts/office-manifest.json
```

Every successful apply creates an immutable SQLite revision and an
`office.manifest.applied` audit event. `office:show` reads the latest revision;
`office:pipeline --task-kind <kind>` deterministically resolves default routing.
Unknown fields, invalid role references, duplicate identifiers, unsupported
permission preferences, and conflicting default task routing are rejected.
Applying a revision does not create or modify profile entries and does not create
capability grants.

Manifest files must be regular files inside the runtime project root and are
limited to 256 KiB. Inline JSON is also accepted with `--manifest`.

## Authorization boundary

Permission preferences describe the user's intended working envelope. They never
create or modify a capability grant, resource scope, budget, or agent privilege.
Likewise, a pipeline stage with `requiresApproval: true` is a workflow checkpoint,
not approval for a controlled action.

Protected effects retain the existing deterministic lifecycle:

```text
request -> simulate -> inspect -> approve -> execute
```

The skill must not bypass this lifecycle or access SQLite directly.

## Optional headless compatibility flow

`project:onboard` remains available for unattended environments that explicitly
configure `AI_OFFICE_LLM_MODEL`, a matching provider credential, pricing, and
optional budgets. It generates progressive validated question batches through
the metered gateway and persists provider/model/prompt provenance.

This path is optional. A missing provider configuration affects
`project:onboard` only; skill-first onboarding and the base runtime remain fully
usable without it.

No provider secret, raw prompt, full provider response, or hidden reasoning is
persisted or projected. Provider-generated permission answers retain the same
knowledge-only authorization boundary as skill-generated manifests.

## Current limitation

The runtime stores office definitions and resolves the default pipeline for a
task kind. It does not yet persist stage-by-stage pipeline progress or execute a
multi-step autonomous tool loop. The active host follows the configured stages
and reports that limitation during handoff.

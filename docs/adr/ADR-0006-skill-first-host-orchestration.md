# ADR-0006: Use host skills for interactive office orchestration

- Status: Accepted
- Date: 2026-08-20

## Context

Interactive project onboarding was implemented as a daemon-backed CLI flow that
called a configured model provider. This made onboarding depend on a model name,
provider pricing, and an API credential even when the user was already working
inside an authenticated agent host such as Codex or Claude.

Onboarding also needs to grow beyond questions into project modeling, virtual
roles, default task pipelines, and ongoing operation. Placing that conversational
reasoning in the local daemon would couple the base runtime to one provider and
duplicate capabilities already supplied by the active host.

## Decision

Use a host skill as the primary interactive experience. The skill owns
conversation, repository-context interpretation, office synthesis, and pipeline
proposal using the host's existing authenticated session.

Keep the local daemon authoritative for validation, persistence, policy,
controlled actions, execution state, and audit. The boundary is a strict,
schema-versioned JSON office manifest plus machine-oriented daemon CLI commands:

```text
host agent -> ai-office skill -> CLI/protocol -> daemon -> application -> SQLite
```

Store each accepted manifest as an immutable project-scoped revision. Manifest
permission preferences are descriptive project knowledge only. They never
create capability grants. Pipeline approval gates never replace controlled-action
authorization or approval.

Retain the metered provider-backed onboarding path as an optional headless
compatibility flow. It is not required for base installation or interactive
onboarding.

## Consequences

- Interactive setup uses the model session already authenticated by the host and
  does not require provider API credentials in AI Office.
- The same runtime contract can support thin adapters for other compatible agent
  hosts without moving authority into prompts.
- Office structure and default routing become validated, auditable project state.
- Truly unattended model execution still requires a separately authenticated
  executor or optional provider configuration.
- The first implementation stores and resolves pipelines but does not yet own a
  durable multi-stage pipeline executor.

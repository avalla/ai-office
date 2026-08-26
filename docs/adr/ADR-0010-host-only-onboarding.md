# ADR-0010: Make conversational onboarding host-only

- Status: Accepted
- Date: 2026-08-26
- Supersedes: the provider-backed compatibility clause in ADR-0006 and the
  onboarding-specific composition described by ADR-0005

## Context

AI Office had two conversational onboarding paths. The repository-scoped
`ai-office` skill used the model session already authenticated by Codex or
Claude, while `project:onboard` constructed an OpenAI or Anthropic provider in
the daemon CLI composition root. The latter required a model reference, an API
credential, pricing, and optional budget configuration, generated and persisted
question batches, and maintained daemon prompt transport.

Keeping both paths made help and setup ambiguous, made `.env` appear necessary,
and preserved two orchestration implementations for the same product outcome.
It also let normal command composition inspect provider configuration even when
the command had nothing to do with onboarding.

## Decision

Conversational onboarding is owned exclusively by an active supported coding
host, currently Codex CLI or Claude Code, through the canonical `ai-office`
skill.

```text
Codex or Claude model session
  -> ai-office skill
  -> install + office:context
  -> adaptive questions in the host conversation
  -> validated office manifest
  -> explicit user confirmation
  -> office:apply
  -> SQLite authority
```

The host model may generate adaptive questions and interpret their answers. Raw
question batches are conversational working state, not a second authority. The
daemon validates and persists only accepted domain state through its existing
application services.

Remove the `project:onboard` command, onboarding generator port and use case,
provider adapter, and provider configuration from daemon/CLI composition. No
onboarding command reads `AI_OFFICE_LLM_MODEL`, `OPENAI_API_KEY`, or
`ANTHROPIC_API_KEY`.

Keep the generic metered LLM gateway and provider adapters separate from
onboarding. They may support a future explicitly designed executor, but they
must not become an implicit onboarding fallback.

## Compatibility

Applied SQLite migrations are immutable. Existing `project_question` and
`onboarding_generation` tables and rows remain in upgraded databases. Profile
queries continue to expose historical questions, and `project:answer` remains
available only to close a question already stored by an older runtime. No
current command creates new provider-generated questions or generation rows.

No migration deletes historical provider, model, prompt-version, question, or
answer data. No credentials were stored by the removed path.

## Alternatives considered

### Keep the command but hide it from help

Rejected. The second orchestration and credential path would remain executable
and could drift from the host skill.

### Keep only `--generate` for automation

Rejected. This would preserve the same provider, pricing, persistence, and
authority ambiguity under a narrower flag. Automation can use the deterministic
`office:*` manifest contract without asking AI Office to own model credentials.

### Delete historical tables and answers

Rejected. It would require destructive data migration and would violate upgrade
compatibility without improving the current product boundary.

### Remove the entire LLM gateway

Rejected as disproportionate. Metering, provider normalization, and adapters are
separate infrastructure with potential executor uses; onboarding no longer
composes or invokes them.

## Consequences

- A normal installation requires no `.env`, model selection, provider pricing,
  or API credential.
- Codex or Claude can still generate personalized, adaptive questions using its
  authenticated model session.
- CLI help, the skill, and current documentation expose one onboarding model.
- The daemon remains deterministic and authoritative for validation,
  persistence, policy, controlled actions, and audit.
- Fully unattended conversational onboarding is no longer supported. A future
  unattended executor requires a separate decision and authentication model.
- Historical generated questions remain visible as legacy evidence but cannot
  be regenerated or extended by current commands.

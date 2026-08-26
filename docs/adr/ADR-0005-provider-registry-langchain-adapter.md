# ADR-0005: Keep model providers behind an infrastructure registry

- Status: Accepted for generic provider infrastructure; onboarding composition superseded by ADR-0010
- Date: 2026-08-11

## Context

The former onboarding composition root selected only `openai` and directly constructed the native OpenAI Responses adapter. That coupled CLI composition to one vendor even though metering already depended on a normalized provider port.

AI Office needs replaceable model infrastructure without moving task execution, agents, policy, memory, retries, usage accounting, or budgets into a third-party orchestration framework.

## Decision

Parse `AI_OFFICE_LLM_MODEL` as `<provider>:<model>` in an infrastructure registry. The registry validates provider-native credentials and returns an `LlmProvider` plus the bare model used by pricing and requests.

Use `LangChainModelProvider` as the default compatibility adapter for registered OpenAI and Anthropic chat models. Disable LangChain provider retries. Preserve the existing native OpenAI Responses adapter as an optional infrastructure implementation.

Keep the execution path:

```text
explicit application consumer -> MeteredLlmGateway -> LlmProvider
  -> registry-selected LangChainModelProvider -> vendor
```

The application and domain packages must not import LangChain. `MeteredLlmGateway` remains authoritative for pricing, currency checks, budget authorization and reservation, usage persistence, and cost events.

Temporarily accept a bare `AI_OFFICE_LLM_MODEL` when paired with `AI_OFFICE_LLM_PROVIDER`; document this form as deprecated.

## Consequences

- OpenAI and Anthropic can be selected without changing a future application consumer.
- Adding Gemini, OpenRouter, or Ollama requires an infrastructure registration and provider package, not domain changes.
- Provider-specific environment variables remain at the composition boundary.
- Provider metadata and latency can be returned without changing cost semantics.
- Cached-input and reasoning detail are zero when LangChain does not expose them because the existing normalized usage contract requires numeric fields; missing total input/output usage is rejected.
- LangChain package upgrades are isolated to the LLM gateway but remain an infrastructure maintenance responsibility.

ADR-0010 removes the onboarding consumer and its CLI composition. The registry
remains infrastructure and is not initialized by normal daemon commands.

# ADR-0034: Adaptive Agent Learning & Experience Governance

- Status: Proposed
- Date: 2026-10-13
- Scope: M20 — Adaptive Agent Learning (AL-01–AL-05)

## Context

[PR #171](https://github.com/avalla/ai-office/pull/171) proposed an Adaptive
Agent Learning direction: AI Office should improve future agent outcomes from
**verified** execution experience. The proposal names four learning surfaces.
Two of them already exist in bounded form: knowledge retrieval (L1) through
the optional SurrealDB-backed `AgentKnowledgeStore`
([ADR-0025](ADR-0025-native-agent-knowledge-store.md),
[ADR-0030](ADR-0030-typed-governed-knowledge-admission-provenance.md),
[ADR-0032](ADR-0032-categorized-multi-domain-agent-knowledge.md)) and
procedural skills (L2) through versioned, reviewed skill and instruction
packages ([ADR-0006](ADR-0006-skill-first-host-orchestration.md),
[ADR-0012](ADR-0012-shared-project-guide-and-repository-skills.md)).
Experience evaluation and optimization (L3) and model adaptation (L4) do not
exist.

Without an explicit decision, learning work risks four failures: conflating
advisory knowledge, authoritative Runtime state, and trained model weights;
assuming training availability that frontier providers do not offer;
contaminating datasets across tenant or project boundaries; and letting
learned outputs drift into policy, authorization, or approval gates. The
proposal must also remain recoverable from the Runtime and documentation long
after the originating conversation ends.

## Decision (proposed)

1. **Four strictly separated learning surfaces.**
   - L1 *Knowledge*: scoped facts, decisions, provenance, expiry and
     versioning through `AgentKnowledgeStore`. Advisory only; never
     authoritative project state.
   - L2 *Procedures*: candidate skills, instructions and playbooks, versioned
     and explicitly reviewed before adoption.
   - L3 *Optimization*: evaluation of experiences, scoring, and strategy or
     model routing improvements, always behind governance and benchmarks.
   - L4 *Model adaptation*: optional curated SFT/preference datasets, LoRA
     for compatible open-weight models, and managed fine-tuning only for
     specific provider/model offerings verified to support it.
2. **LoRA and fine-tuning never replace the knowledge store.** Retrieval and
   skills continue to work when no training backend is available.
3. **Training availability is capability-detected, never assumed.** No
   commitment that OpenAI or Anthropic frontier models accept LoRA or
   fine-tuning; backend support is confirmed per provider and model before
   use.
4. **Learning scopes are Project, Domain and Global**, with explicit,
   verified promotion. Domain scope requires reviewed generalization across
   explicitly authorized projects of the same domain. Global scope requires
   redaction, rights checks and explicit governance approval, and is never a
   covert tenant-data-sharing channel.
5. **Rigorous separation of trust classes.** Advisory knowledge,
   authoritative Runtime data, and trained model weights are distinct
   classes with distinct admission rules. Learned content is untrusted until
   its admission criteria are satisfied.
6. **Fine-tuning backends sit behind a provider-neutral port**
   (`FineTuningBackend`) with deterministic capability detection,
   reproducible jobs, budget limits and artifact hashing. Provider SDKs and
   credentials never leak into application or domain code.
7. **A registry covers datasets, models and adapters** with versioning,
   provenance, content addressing and rollback. Promotion requires owner
   approval; rollback is immediate.
8. **Data protection is a requirement, not hardening**: tenant and project
   isolation, secret scanning, consent and rights checks, de-duplication, and
   the ability to retract or supersede examples from future dataset
   versions.
9. **Learning can never modify governance.** No learned output may change
   policy, authorizations, capability grants, task authority, audit history,
   approval gates or pipeline constraints. Authorization stays deterministic
   and is never delegated to an LLM or a training process.

Delivery is sliced as AL-01–AL-05 under the Runtime milestone
**M20 — Adaptive Agent Learning** (status `planned`). Full slice definitions
live in the Runtime requirements AL-01–AL-05 and in
[docs/development/adaptive-agent-learning.md](../development/adaptive-agent-learning.md).

## Alternatives considered

- **Fold experiences into `AgentKnowledgeStore`.** Rejected: it would
  conflate advisory knowledge with evaluated experience and trained weights,
  and it would bypass the provenance rules of
  [ADR-0030](ADR-0030-typed-governed-knowledge-admission-provenance.md).
- **Vendor-managed fine-tuning only.** Rejected: provider lock-in, unverified
  availability assumptions, and no path for local open-weight models.
- **Let learning adjust policy or gates.** Rejected: violates the
  deterministic, deny-by-default authorization invariant; learning outputs
  are advisory until a human-governed admission path accepts them.
- **Keep the proposal as prose only.** Rejected: decisions, requirements and
  tasks would be unrecoverable from the Runtime; consolidation into M20,
  AL-01–AL-05 and this ADR makes them durable.

## Principles

1. A merged PR, a telemetry event, or a successful run is not a lesson.
   Experiences become usable only through evaluation and explicit admission
   (AL-02).
2. Benchmark and dataset quality criteria exist **before** any training
   starts; AL-05 gates AL-04 usage.
3. Tenant and project isolation is mandatory at every layer; cross-project
   training data sharing is denied by default.
4. Every dataset example traces to an admitted experience with provenance;
   retraction removes examples from future dataset versions.
5. Provider and backend details stay behind ports and the registry; the
   domain never imports provider SDKs.
6. Cost per successful task is a first-class metric alongside correctness.
7. This ADR authorizes no implementation. Work starts only after acceptance,
   and slice execution follows the milestone dependency chain.

## Consequences

- New persistence (experience records, datasets, artifact registry) requires
  forward-only migrations with fresh and upgrade coverage.
- A benchmark harness must exist before training; benchmark gaming and
  holdout overfitting are blocking concerns.
- The Runtime gains planned milestone M20 with five proposed requirements
  and five linked tasks; documentation gains this ADR and
  `docs/development/adaptive-agent-learning.md`.
- Integration points are boundaries, not dependencies: `AgentKnowledgeStore`
  (ADR-0025/0030/0032), Runtime execution and audit, model routing
  (ADR-0019), M19 execution continuity, and Domain Packs (ADR-0026).

## Open questions

- Which storage substrate hosts the experience store: Runtime-owned storage
  or SurrealDB alongside `AgentKnowledgeStore`? Resolved at AL-01 design
  time, after [ADR-0031](ADR-0031-runtime-owned-delivery-state.md) open
  questions settle the aggregate pattern.
- Does L3 strategy routing extend the ADR-0019 profile model or define a new
  optimization surface?
- Who owns and governs the held-out historical task sets used for
  benchmarking?
- How do experience export and checkpoint resume interact with the Runtime
  milestone M19 (Execution Continuity & Handoff)?
- Does L2 procedural adoption reuse the existing office manifest and skill
  compiler paths, or require a new review channel?

## References

- [PR #171 — docs: propose Adaptive Agent Learning roadmap](https://github.com/avalla/ai-office/pull/171)
- [Roadmap M20 section](../development/roadmap.md)
- [M20 plan: adaptive-agent-learning.md](../development/adaptive-agent-learning.md)
- [Native agent knowledge](../development/agent-knowledge.md) and
  [deployment](../development/agent-knowledge-deployment.md)
- [Agent model routing](ADR-0019-agent-model-routing.md),
  [delivery state](ADR-0031-runtime-owned-delivery-state.md),
  [core/pack boundary](ADR-0026-core-domain-pack-boundary.md)

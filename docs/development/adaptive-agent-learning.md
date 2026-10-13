# Adaptive Agent Learning — M20 plan

Status: **proposed** (2026-10-13). Governed by
[ADR-0034](../adr/ADR-0034-adaptive-agent-learning-experience-governance.md)
(proposed). Registered in the Runtime as milestone
**M20 — Adaptive Agent Learning** (`56d58da2-129f-46a6-92fd-f17bbeda4272`,
status `planned`) with requirements **AL-01–AL-05** and five linked tasks.
This document is the milestone plan; the Runtime owns milestone state; the
roadmap owns milestone status. Nothing here implements, trains, or commits to
a provider capability.

Origin: [PR #171](https://github.com/avalla/ai-office/pull/171) proposed this
direction on 2026-10-12; this plan consolidates it durably.

## Goal

Make AI Office improve future agent outcomes from **verified** execution
experience, without confusing advisory knowledge, executable governance, and
model weights. Learning is provider-neutral and domain-neutral, supporting
software, legal, research, and mixed-domain offices with isolation
boundaries.

## Four distinct learning surfaces

1. **Knowledge (L1)**: scoped facts, decisions, provenance, expiry and
   versioning through the optional SurrealDB-backed `AgentKnowledgeStore`.
   Exists today (ADR-0025, ADR-0030, ADR-0032); remains advisory and never
   replaces ProjectStorage authority.
2. **Procedures (L2)**: candidate skills, instructions and playbooks,
   versioned and explicitly reviewed before adoption. Exists today as the
   skill and instruction packages (ADR-0006, ADR-0012).
3. **Optimization (L3)**: evals, ranked experiences, model/strategy routing
   and outcome-based improvements, always behind governance and benchmarks.
   Does not exist; AL-02 and AL-05 create its foundation.
4. **Model adaptation (L4)**: optional curated SFT/preference datasets, LoRA
   for compatible open-weight models, and managed fine-tuning only for
   specific provider/model offerings that actually support it. Does not
   exist; AL-03 and AL-04 create it. No assumption that frontier Claude or
   OpenAI models accept LoRA or fine-tuning.

## Learning scopes and hard boundaries

- **Project**: project-specific knowledge and solutions.
- **Domain**: generalized, reviewed reusable practices across explicitly
  authorized projects of the same domain.
- **Global**: generic strategies promoted only following redaction, rights
  checks and explicit governance; never a covert tenant-data-sharing channel.

Training and retrieval cannot modify approvals, capability grants, task
authority, audit history or policy gates. Learned content is untrusted until
its admission criteria are satisfied. Data protection, secret scanning,
tenant/project isolation, and ability to retract or supersede examples are
requirements, not optional hardening.

## Delivery slices

The authoritative requirement text lives in the Runtime (requirement keys
AL-01–AL-05 under M20); the summaries below mirror it for readers.

### AL-01 — Experience Store & Provenance

- **Objective**: durable, immutable, provenance-rich records of agent
  execution experience that future learning surfaces can trust.
- **Requirements**: project/tenant/domain scopes; run, task and agent
  linkage; input/output artifact references with hashes; timestamps,
  confidence, versioned evaluation evidence, supersession, redaction and
  retention rules; append-only storage with typed empty/error semantics.
- **Scope / non-goals**: storage, schema, provenance contracts and audit
  only. No evaluator logic, no dataset export, no training.
- **Dependencies**: ADR-0034 acceptance; existing Runtime execution and audit
  aggregates. `AgentKnowledgeStore` stays advisory and separate.
- **Acceptance criteria**: records immutable and provenance-complete;
  redaction and retention enforced and tested; unauthorized scope access
  rejected; empty/unavailable/invalid/failed states distinguished.
- **Tests**: schema, provenance, redaction, retention, supersession,
  concurrency; fresh-migration and upgrade tests; storage-outage fault
  injection.
- **Risks / constraints**: experience records never become authoritative
  project state; tenant isolation mandatory; no secrets in records.
- **Definition of done**: ADR-0034 accepted; implementation merged with green
  `bun run check`; independent review and Codex review resolved; Runtime
  requirement verified.

### AL-02 — Experience Evaluation & Admission

- **Objective**: evaluate recorded experiences against tests, independent
  reviews, human decisions and actual task outcomes before they influence
  any learning surface.
- **Requirements**: typed evaluator ports with deterministic authorization;
  domain-specific evaluators through generic ports; uncertainty and
  conflicting evidence tracked; unverified lessons quarantined; explicit
  reviewed admission with audit trail; evidence versioned and bound to the
  experience.
- **Scope / non-goals**: evaluation and admission only; no dataset export,
  no strategy changes, no training.
- **Dependencies**: AL-01.
- **Acceptance criteria**: only experiences meeting admission criteria are
  promoted; rejected/conflicting experiences cannot reach retrieval, skills
  or datasets; every admission decision auditable and reversible.
- **Tests**: evaluator units; conflicting-evidence cases; quarantine and
  retraction flows; adversarial admission attempts; audit completeness.
- **Risks / constraints**: evaluation cannot modify approvals, grants, task
  authority, audit history or gates; evaluator results advisory until
  admitted.
- **Definition of done**: admission flow implemented and reviewed; green
  `bun run check`; independent and Codex reviews resolved; requirement
  verified.

### AL-03 — Training Dataset Curation

- **Objective**: export authorized, admitted experiences as curated SFT and
  preference datasets with lineage, versioned splits and leakage-resistant
  holdouts.
- **Requirements**: datasets built only from admitted experiences;
  de-duplication and sanitization with secret scanning; license, consent and
  rights checks recorded; lineage to experience and provenance records;
  versioned splits with explicit holdout policy; no cross-project sharing by
  default; opt-in Domain/Global promotion per ADR-0034 scope rules.
- **Scope / non-goals**: dataset generation, validation, export; no training
  execution, no backend selection.
- **Dependencies**: AL-02.
- **Acceptance criteria**: every exported example traces to an admitted
  experience; holdout leakage checks pass; sanitization failures block
  export; cross-project sharing denied unless explicitly authorized and
  logged.
- **Tests**: curation units; de-duplication and near-duplicates; leakage
  detection; sanitization and secret scanning; export determinism.
- **Risks / constraints**: dataset contamination is a blocking defect;
  retracted examples removable from future dataset versions; tenant
  isolation mandatory.
- **Definition of done**: curation pipeline implemented with tests; green
  `bun run check`; independent and Codex reviews resolved; requirement
  verified.

### AL-04 — Pluggable Fine-Tuning & LoRA Backends

- **Objective**: provider-neutral training interfaces for open-weight LoRA
  and capability-detected managed fine-tuning, with reproducible jobs,
  budgets and rollback.
- **Requirements**: `FineTuningBackend` port with deterministic capability
  detection; open-weight LoRA adapters first; managed fine-tuning only for
  verified provider/model offerings; reproducible job configuration, budget
  limits, artifact hashes and run provenance; training optional — retrieval
  and skills keep working without it.
- **Scope / non-goals**: backend abstraction, job orchestration, artifact
  production; no benchmark definition, no rollout policy.
- **Dependencies**: AL-03; ADR-0034 backend abstraction decision.
- **Acceptance criteria**: backend usable only after capability detection
  confirms support; jobs reproducible from recorded configuration and dataset
  version; budget exhaustion stops jobs; artifacts content-addressed and
  rollbackable.
- **Tests**: backend contract tests with deterministic fakes; capability
  detection; budget and failure injection; reproducibility.
- **Risks / constraints**: provider details stay behind the port; unavailable
  training never degrades retrieval or skills; no provider lock-in.
- **Definition of done**: port and at least one open-weight LoRA adapter
  implemented with tests; green `bun run check`; independent and Codex
  reviews resolved; requirement verified.

### AL-05 — Benchmark, Model Registry & Safe Rollout

- **Objective**: comparative evaluation and controlled rollout of learned
  artifacts behind explicit promotion and instant rollback.
- **Requirements**: benchmark baseline vs retrieval+skills vs specialist
  adaptation on held-out historical tasks; metrics cover correctness, missed
  defects, recovery, latency, total tokens and **cost per successful task**;
  registry for datasets, models, adapters with versioning, provenance,
  rollback; owner-approved promotion; instant rollback; governance untouched.
- **Scope / non-goals**: benchmark harness, registry, rollout governance; no
  new training backends.
- **Dependencies**: AL-02 and AL-04. Benchmark and dataset quality criteria
  must exist before any training starts.
- **Acceptance criteria**: benchmark results reproducible on pinned dataset
  versions; no promotion without owner approval; rollback restores prior
  behavior; governance invariants untouched by learning outputs.
- **Tests**: benchmark determinism; registry versioning and rollback;
  promotion gates; governance non-interference.
- **Risks / constraints**: training before benchmark and quality criteria are
  defined is prohibited; benchmark gaming and holdout overfitting are
  blocking concerns.
- **Definition of done**: benchmark and registry implemented with tests;
  green `bun run check`; independent and Codex reviews resolved; requirement
  verified.

## Incremental plan

1. **Phase 1 — ADR and Experience Store.** Accept ADR-0034; implement AL-01.
2. **Phase 2 — Evaluator.** AL-02: provenance, de-duplication input checks,
   quality scoring and promotion of validated experiences.
3. **Phase 3 — Retrieval and skills integration.** Wire admitted experiences
   into retrieval and skills; compare results against the L1/L2 baseline.
4. **Phase 4 — Datasets and LoRA experimentation.** AL-03 dataset generation;
   AL-04 LoRA experimentation on open-weight models.
5. **Phase 5 — Benchmarks and controlled rollout.** AL-05 comparative
   benchmarks and controlled rollout.

Training must not start before the benchmark and dataset quality criteria are
defined. Phases 3–5 each gate on the previous phase and on owner approval.

## Runtime registration (2026-10-13)

| Entity | Key | Runtime ID |
| --- | --- | --- |
| Milestone | M20 | `56d58da2-129f-46a6-92fd-f17bbeda4272` (planned) |
| Requirement | AL-01 | `918dfa05-9b57-4128-a067-1698b07409c8` |
| Requirement | AL-02 | `ed89f81b-3b6f-4590-950b-300828f87a2e` |
| Requirement | AL-03 | `4e95ed92-4e81-4ea2-bd3e-31ba020cf942` |
| Requirement | AL-04 | `a7402ad7-7420-42f4-b62c-0c11709bd5d2` |
| Requirement | AL-05 | `30318bde-7b5b-489f-a256-ef3464c7dc9f` |
| Task | AL-01 | `3f311274-33b3-4d06-b870-14a0c28e828f` |
| Task | AL-02 | `1a4af607-3df4-49c6-bd9c-daab39d71f24` |
| Task | AL-03 | `483309e6-2244-4be2-96db-0d0c319a47a2` |
| Task | AL-04 | `3d259978-57f8-4878-a762-5674f12405f8` |
| Task | AL-05 | `33591b97-0f3e-45ce-83e8-bc87a6a41111` |
| Runtime ADR | ADR-0034 | `a7cd0045-b5f3-41f3-908c-5ce75010f20d` |

Task dependencies form the chain AL-02 → AL-01, AL-03 → AL-02, AL-04 →
AL-03, AL-05 → AL-04.

## Integration boundaries

- `AgentKnowledgeStore` and governed admission (ADR-0025, ADR-0030,
  ADR-0032): experiences cite knowledge records; knowledge stays advisory.
- Runtime execution, audit and cost metering: provenance and cost-per-task
  metrics come from existing aggregates.
- Model routing (ADR-0019): L3 improvements may extend routing profiles.
- M19 — Execution Continuity & Handoff (Runtime `active`): checkpoint and
  resume may export and re-import experience context; no dependency is
  claimed in either direction.
- Domain Packs (ADR-0026): pack-declared categories may classify experiences
  and procedures.

These are integration boundaries, **not** a claim that M19 or M16.5 depends
on this milestone. No new code, model training or provider commitment is
authorized by this document.

## Open questions

Tracked in ADR-0034: experience-store storage substrate; L3 routing vs
ADR-0019; benchmark dataset ownership; M19 interaction; L2 adoption channel.

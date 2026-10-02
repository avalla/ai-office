# M17 — Execution Observability & Heterogeneous Actors Foundation

Status: planned. This is a delivery plan, not an implemented capability. The
authoritative milestone, requirement and task records live in the AI Office
Runtime; this document holds the dependency graph because the current task
model has no native dependency edge or direct milestone reference.
Project milestone ID: `472deabb-a3b7-441b-808d-b6fa71a3830e`.

## Boundary and prerequisites

M17 observes actual executor work without transferring workflow authority to
hooks. `Actor` identifies who or what participates; `Role` states expected
responsibility; `Capability` states permitted operations only after a grant;
`Assignment` binds an actor to work; `Execution` records one governed attempt;
`Presence` and activity are separate observations; `Evidence` records bounded
facts. An AI agent is one actor kind, and an LLM process is one possible
executor. Prompt, model, tokens, CLI session and tool calls are provider or
execution details, not mandatory actor fields.

The current `AgentRun` remains the governed AI execution record. M17 adds a
compatible execution seam and an `ExecutorSession` for the external runtime
session when one exists. A session is not another task, pipeline, stage or run
authority. No cosmetic `AgentRun` rename or rewrite of old records is required.
An orchestrated path is Task → PipelineRun → PipelineStageRun → Assignment →
AgentRun → ExecutorSession → executor → observed lifecycle events. The Runtime
creates and fences the governed records. A hook reports facts about a session;
it cannot create or advance them or declare task success.

M17 builds on M11/M11.5 run and stage authority, M12's worker launch/observe
port where managed external execution needs it, ADR-0015 read models, and the
current controlled-action, model-routing, audit and recovery contracts. It uses
ADR-0026/0027 and M15/M16 work for the core/domain boundary, but does not wait
for every Domain Pack or implement a pack. The React navigation and behavior
delivered by [PR #86](https://github.com/avalla/ai-office/pull/86) are the
dashboard baseline. M17 does not reimplement its SPA or count its existing
run/pipeline views as new work.
PostgreSQL session persistence must follow the existing ProjectStorage/RLS
boundary and M15-PG-PARITY where that prerequisite remains incomplete.

The proposed [ADR-0028](../adr/ADR-0028-actor-execution-and-observation.md)
is the first decision gate. Its status is proposed; implementation must accept
or revise it against the current code and provider APIs. Provider hook support
and installation methods must be confirmed against the supported Codex and
Claude Code versions during EO-T06/EO-T07, rather than inferred from a shared
event vocabulary.

## Requirements

All requirements are proposed and must be verified with the stated observable
result. Their project keys are stable; task keys below are title prefixes.

| Key | Verifiable requirement |
| --- | --- |
| EO-R01 | A versioned, bounded, provider-neutral `ExecutorLifecycleEvent` contract validates provider, event kind, occurrence time, native and AI Office identifiers; adapters map only semantically equivalent events and preserve an unknown provider event as sanitized opaque evidence. |
| EO-R02 | A durable, project-owned `ExecutorSession` has stable identity, provider, managed/external binding, applicable agent/run/stage references, native session ID, lifecycle times, and bounded metadata; it never owns workflow state. |
| EO-R03 | Queries and audit distinguish Runtime-managed execution from externally observed unbound sessions; repository/CWD association may identify only a deterministically resolved registered project and never guesses task, role, actor, stage or run. |
| EO-R04 | A supported Codex lifecycle adapter correlates managed sessions, ingests supported structured events, updates last activity, and observes external sessions only where its actual hook API permits; setup and negative tests document unsupported events. |
| EO-R05 | A supported Claude Code lifecycle adapter meets the same boundary through shared ingestion logic, with its own factual event mapping, installation/configuration and unsupported-event tests. |
| EO-R06 | Valid observed events are durably recorded as bounded, sanitized evidence with provider/native identity and provenance; no prompt, tool argument, command body, credential or unsafe path is stored or exposed. |
| EO-R07 | Runtime read models separately report actor/agent operational state, presence availability and last activity, deriving `working`, `awaiting_approval`, `idle`, `interrupted` and terminal states only from appropriate persisted facts; elapsed quiet time alone proves none of them. |
| EO-R08 | Runtime query surfaces join task, active pipeline/stage, assignment, authoritative run, executor session/provider and activity without losing exact relationships to a presentation limit. |
| EO-R09 | React `Work`, `Pipelines`, `Agents` and project sections render those query surfaces, including session, provider, managed/external distinction, last activity and truthful unavailable/empty states; the specified global and project navigation remains present. |
| EO-R10 | Only Runtime commands and existing guarded executor completion can create/transition Task, PipelineRun, PipelineStageRun and AgentRun; hook tool/session events and external sessions cannot advance stages or assert success. |
| EO-R11 | Persisted lifecycle changes publish bounded SSE invalidation hints for affected read models; dashboard reconnect re-queries authoritative APIs and SSE never carries full state. |
| EO-R12 | Managed hook correlation uses registration plus scoped, expiring, single-session proof/fencing checked by the Runtime; identifiers or environment variables alone grant no binding, wrong project/provider/run and stale proof fail closed. |
| EO-R13 | Delivery has deterministic duplicate/out-of-order/retry handling and documented restart, hook failure, executor crash, missing end and stale-session reconciliation; disappearance never completes an AgentRun. |
| EO-R14 | Existing AgentRun IDs, statuses, fencing, task locks, historical data, CLI and model routing remain compatible; a documented `WorkExecution`/`ExecutionRun` generalization path adds no naming-only migration. |
| EO-R15 | A minimal Actor identity/type seam can represent `human`, `ai_agent`, `robot`, `machine`, `service` and `system` without requiring all kinds to be instantiated now or assigning them LLM fields. |
| EO-R16 | Role, Capability and Assignment contracts can bind to an Actor independently of its execution provider and preserve current role matching, grants, approvals and separation rules for AI agents. |
| EO-R17 | Public extension points and contract tests show how future human/robot/machine/service execution and presence adapters can participate without changing task/pipeline/governance core; no such production adapter is delivered here. |
| EO-R18 | Forward-only migrations and read compatibility preserve existing installations, snapshots and legacy run records; an old project starts and behaves as before with no reinstall or forced backfill. |
| EO-R19 | SQLite and PostgreSQL session/event repositories satisfy the same storage contract, project/tenant isolation, foreign keys, atomic lifecycle/audit rules and representative upgrade tests; PG RLS is enforced. |
| EO-R20 | Audit identifies Runtime-authoritative, executor-observed and external-unbound facts distinctly, with bounded sanitized fields and no observed event impersonating a governed decision. |
| EO-R21 | An accepted/revised actor/execution/presence ADR, lifecycle and recovery diagrams, Codex/Claude setup, external-session limits, security/threat model and operator semantics match delivered behavior. |
| EO-R22 | Automated contracts and Unix-socket/dashboard integration tests prove managed and external scenarios, malformed/forged events, parity, recovery, no authority escalation and bounded evidence. |

## Delivery graph and tasks

Dependencies are plan edges, not native Runtime task dependencies. Parallel work
may begin only after its listed gates are met. Each row is one reviewable task;
its linked requirement set is also the project task→requirement relation.

```text
EO-T01 ADR/semantics
  → EO-T02 protocol/security → EO-T03 session + SQLite → EO-T04 PostgreSQL
                                              ↓
                                       EO-T05 ingestion
                                       ↙             ↘
                               EO-T06 Codex      EO-T07 Claude
                                       ↘             ↙
                                    EO-T08 read models → EO-T09 SSE → EO-T10 dashboard
                                                               ↘            ↓
                                                    EO-T11 Actor seam ←────┘
EO-T04 + EO-T05 + EO-T06 + EO-T07 → EO-T12 recovery/hardening
EO-T10 + EO-T11 + EO-T12 → EO-T13 end-to-end qualification → EO-T14 docs/exit
```

| Task | Depends on | Linked requirements | Acceptance and review artifact |
| --- | --- | --- | --- |
| EO-T01 — Actor/execution ADR and compatibility | M15/ADR-0027, ADR-0026, M11/M12 assessment | R14–R17, R21 | Accept/revise ADR-0028 with Actor/Role/Capability/Assignment/Execution/Presence/Evidence boundaries, AI AgentRun mapping, authority and migration decision; document rejected alternatives. No product change. |
| EO-T02 — Lifecycle protocol, binding and security design | T01 | R01, R03, R10, R12, R13 | Specify schema, event taxonomy and unknown-event preservation; registration/proof, local-first threat limit, managed/external discovery, dedupe key and out-of-order policy; contract examples reject forged IDs and unsupported semantic mappings. |
| EO-T03 — ExecutorSession domain/port and SQLite | T02 | R02, R14, R18, R19 | Add narrow application port/domain rules and forward SQLite migration for session and event identity; fresh/upgrade, ownership, FK and snapshot compatibility tests; session cannot mutate workflow. |
| EO-T04 — PostgreSQL persistence and parity | T03; M15-PG-PARITY where needed | R02, R18, R19, R22 | Add forward PG migration/repository with tenant RLS and equivalent storage-contract, upgrade and cross-project denial tests; report any prerequisite gap explicitly. |
| EO-T05 — Provider-neutral ingestion core | T03 | R01, R06, R10, R12, R13, R20 | Runtime validates proof and schema, sanitizes/bounds payload, commits session/event/audit consistently, deduplicates and rejects stale authority; hooks cannot write governed lifecycle tables. |
| EO-T06 — Codex hook adapter and setup | T02, T05; M12 launch port for managed starts | R03, R04, R06, R12 | Use documented supported Codex hooks, pass verified managed context, register/observe unbound sessions only when supported, update activity, provide reversible installation/configuration and mapping/negative tests. |
| EO-T07 — Claude Code hook adapter and setup | T02, T05; M12 launch port for managed starts | R03, R05, R06, R12 | Same acceptance for Claude Code's actual hooks without duplicating ingestion business logic; preserve provider-specific event distinctions and tested setup. |
| EO-T08 — Operational execution read models/API | T05, T06, T07 | R03, R07, R08, R14 | Exact task/stage/assignment/run/session joins, separate operational state/presence/activity and bounded samples; query API returns safe provider/native identity and unknown/unavailable states. |
| EO-T09 — Lifecycle invalidation | T05, T08 | R11 | Session/event changes invalidate affected project, task, run, pipeline, agent and activity queries through existing SSE topics or versioned additions; reconnect re-queries, no state payload. |
| EO-T10 — React operational console | T08, T09; PR #86 baseline | R07–R09, R11 | Global Overview/Projects/Work/Pipelines/Agents/Memory and project Overview/Pipeline/Tasks/Milestones/Requirements/Agents show real Runtime facts; Work/Pipelines/Agents show binding, stage, actor, run, provider, session, activity and precise empty/unavailable states; no UI query logic duplication. |
| EO-T11 — Minimal heterogeneous Actor seam | T01, T08, T10; M16 boundary review | R14–R17 | Introduce only the accepted core identity and adapter contracts; existing AI behavior is unchanged; synthetic human/robot/service/machine contract fixtures prove no required model, prompt, token, tool or CLI session fields. No production non-AI adapter. |
| EO-T12 — Recovery, ordering and adversarial hardening | T04–T07 | R02, R03, R10, R12, R13, R18–R20, R22 | Inject malformed, duplicate, reordered, delayed, wrong-provider/project/run, crash, restart, lost-end and stale-external cases; no forged authority, silent completion, duplicate audit or secret leak; SQLite/PG results agree. |
| EO-T13 — End-to-end qualification | T04, T10–T12 | R03–R05, R08–R10, R14, R17–R20, R22 | Prove the three exit scenarios below through Unix socket, read APIs and React refresh, including terminal transition and legacy upgrade; record provider/version coverage. |
| EO-T14 — Operator docs and milestone exit | T13 | R04, R05, R21, R22 | Publish tested setup, lifecycle/recovery diagrams, security limits, external behavior, API/presence semantics and architecture/roadmap status; docs match commands and tests before milestone completion. |

The requirement→task mapping above is normative. Every EO requirement has at
least one task, and every task links to at least one EO requirement. Task
descriptions in the Runtime copy the dependency, acceptance and exclusion for
review; requirements belong to M17 and carry their own verifiable condition.

## Correlation and operational semantics

For a managed launch, the Runtime creates/fences the run and registers a session
before invoking the executor. The adapter receives an explicit envelope with
project, task, actor/agent, run, pipeline and stage IDs where applicable and a
scoped proof; environment variables are one transport option, not authority.
The Runtime verifies the proof, ownership, provider, active fence and registration
on ingestion. Local Unix-socket access alone does not authenticate a hostile
same-UID process. Session proof prevents an arbitrary ID copied into a hook
payload from binding another run; stronger same-UID isolation remains M10 work.
The proof and secret-bearing environment values never enter audit, metadata,
read models or UI.

The protocol may normalize `session_started`, `session_ended`, turn start/end or
stop, tool start/end/failure, approval required/resolved, interruption and
subagent start/stop *only where a provider emits an equivalent fact*. Store a
safe `provider_event_type` for unmapped events with no fabricated common
meaning. A tool completion says nothing about task success. Native session IDs
are exposed only if their format and sensitivity are reviewed.

For unbound observation, a canonicalized CWD/repository may select one
registered project if ownership and ambiguity checks pass. The session has no
task, stage, role, AI Office agent or governed run. Unsupported hook installation
or missing context is reported as unavailable, not as an invented idle session.
Presence is independent of execution status: `last_activity_at` advances on
accepted facts; `quiet for …` is a display of elapsed time, not proof of idle,
failure or offline. Stale sessions require explicit reconciliation and cannot
close authoritative runs by timeout alone.

## Milestone exit scenarios

1. **Managed execution:** AI Office owns a task and active PipelineRun, assigns
   its stage to an AI actor, creates a fenced AgentRun, launches supported Codex
   or Claude, registers the ExecutorSession and propagates verified context.
   A structured lifecycle/tool event is verified, sanitized, stored and audited.
   Runtime queries join task, pipeline, stage, actor, run, provider, session and
   last activity; the React console shows them and refreshes through SSE hints
   and re-query. Session end closes the session; only governed completion/failure/
   cancellation changes AgentRun and stage/task. The actor stops reading as
   working after authoritative terminal execution.
2. **External observation:** manually launched Codex in one registered checkout
   emits a supported event without trusted context. AI Office may show an
   external/unbound project session, with no task/stage/pipeline/AgentRun or
   invented role. Ambiguous repository resolution yields no project binding.
3. **Heterogeneous extension:** a contract fixture for future HumanActor and
   RobotActor, plus service/machine types, can bind role/assignment and distinct
   execution/presence adapters without an LLM, prompt, model, token usage, CLI
   session or tool call and without changing task/pipeline/governance core.

Preserve task and pipeline lifecycles, AgentRun fencing, task locks, model
routing, approvals, audit, local-first Runtime authority, existing CLI and data,
and SQLite/PostgreSQL parity. Migrations are forward-only. Session and event
state cannot become an alternative pipeline engine or second workflow store.

## Non-goals

- MES implementation, OPC-UA integration, PLC control or robot fleet management.
- Human time tracking, employee surveillance, HR attendance or advanced human presence.
- A generic workflow engine rewrite or replacing AgentRun everywhere for naming purity.
- Autonomous assignment based on guessed external sessions or hooks as pipeline authority.
- Implementing every executor/provider or production human, robot, machine or service adapters.
- Changing model routing, controlled-action approval or Domain Pack resolution as a side effect.

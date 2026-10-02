# ADR-0028: Actor, execution and executor observation boundary

- Status: Proposed; EO-T01 must accept or revise before implementation
- Date: 2026-10-02
- Scope: M17 planning, compatible with ADR-0014/0015/0017/0021/0026/0027

## Context

`AgentRun` is the current governed AI execution record. Pipeline stages assign
registered agents with roles, and the Runtime fences run completion. The
bounded Claude worker can report a native session and final output, but the
Runtime has no durable executor-session lifecycle or hook telemetry contract.
Operational read models and the React dashboard delivered by PR #86 show current run and
pipeline facts but cannot infer ongoing tool/session activity. Future Domain
Packs need human, robot, machine, service and system actors without treating
them as LLM processes. The current trusted-local daemon is not a same-UID
security boundary.

## Proposed decision

1. Keep `Actor`, `Role`, `Capability`, `Assignment`, `Execution`, `Presence` and
   `Evidence` distinct. Role defines expected responsibility; actor identifies
   the participant; assignment binds the two to work; execution is a concrete
   governed attempt. Presence and last activity are observed facts, not a
   universal heartbeat rule. Provider/model/prompt/tokens/tools are optional
   execution capabilities, never base Actor requirements.
2. Retain `AgentRun` and its IDs/status/fence as the current AI execution
   authority. Introduce only a compatible seam toward `WorkExecution` or
   `ExecutionRun`, selected by EO-T01 after checking storage, query, snapshot and
   queue contracts. Do not migrate data to rename fields.
3. Add `ExecutorSession` only for an external executor session. Its project,
   actor/agent, AgentRun, pipeline/stage references, provider, native ID,
   managed/external binding, timestamps and sanitized metadata refer to
   existing authorities. An external/unbound session cannot supply a governed
   run or task by inference.
4. Provider adapters translate supported structured hooks into a versioned
   common event envelope. Unmapped events retain sanitized provider identity
   without guessed semantics. Ingestion validates a managed registration and
   scoped proof/fence; environment IDs and socket access alone do not bind a
   hook to a run. Hooks may update session/activity/evidence but never create or
   transition tasks, stages, pipelines, AgentRuns, approvals or actions.
5. Runtime query services derive operational state from authoritative records
   plus observed facts and expose explicit unknown/unavailable values. SSE
   carries invalidation hints only. Audit marks event provenance as Runtime
   authoritative, managed executor observed or external unbound observed.
6. Session event identity supports deduplication and out-of-order handling;
   restart, lost end or timeout can mark an observation stale only under a
   documented rule. They never imply AgentRun completion. Forward-only SQLite
   and PostgreSQL migrations, tenant isolation and existing-run compatibility
   are required.

## Decision gates for EO-T01 and EO-T02

- Choose the minimal Actor identity representation and mapping from registered
  AI agent, with explicit project ownership and role/assignment compatibility.
- Check whether `Execution` needs a persisted generic identity now or only an
  application port/typed reference until a non-AI adapter exists.
- Choose registration/proof lifetime, storage, dedupe identity, event ordering
  and recovery states against the local threat model and AgentRun fence.
- Confirm supported Codex and Claude Code hook APIs/versions and safe setup
  before committing to a normalized event mapping or external observation.
- Show that existing run, pipeline, approval, action, model and snapshot
  contracts remain readable and governed after upgrade.

## Consequences and exclusions

This is a proposed architecture boundary, not an implemented Actor aggregate,
session table, event API or provider hook. It narrows M17 delivery and leaves
M12 worker launching, M16 Domain Pack resolution, M10 hostile same-UID
isolation, MES/robotics and HR workflows to their own scopes. A proof bound to
a local session prevents arbitrary identifier injection; it cannot by itself
protect against a hostile process with the same OS identity and access to the
executor environment.

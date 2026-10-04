# Native agent knowledge retrieval

AK-01 defines `AgentKnowledgeStore` as a secondary, non-authoritative
application port. AK-02 implements its SurrealDB read behavior and the
CairnKeep-compatible search term. AK-03 composes it independently into the
Runtime when explicitly enabled. AK-04 uses the connected store for worker
context and run retrieval provenance.
SurrealDB does not store project, task, run, approval, or audit authority.
CairnKeep integration was removed in AK-08; no current command reads its
external database. Existing imported records and historical run retrieval
provenance remain readable; new knowledge is admitted only through
`AgentKnowledgeStore`.

## Runtime composition (AK-03, AK-09)

Foreground hosts read `AI_OFFICE_AGENT_KNOWLEDGE_PROVIDER` once at bootstrap. Unset,
empty, or `none` disables native knowledge. `surrealdb` requires these host-only
values: `AI_OFFICE_SURREALDB_URL` (`ws://` for loopback only or `wss://`),
`AI_OFFICE_SURREALDB_NAMESPACE`, `AI_OFFICE_SURREALDB_DATABASE`,
`AI_OFFICE_SURREALDB_USERNAME`, and `AI_OFFICE_SURREALDB_PASSWORD`. Namespace
and database are simple identifiers. A SQLite Runtime additionally requires
`AI_OFFICE_AGENT_KNOWLEDGE_TENANT_ID`; a PostgreSQL Runtime binds knowledge to
its trusted storage tenant instead. The portable `repositoryId` will be added
by the application caller in AK-04, never inferred from a checkout path.

Managed services instead select `<AI_OFFICE_HOME>/agent-knowledge.json` and
owner-only `credentials/AI_OFFICE_SURREALDB_USERNAME` and
`credentials/AI_OFFICE_SURREALDB_PASSWORD` through a non-secret service marker.
They ignore all foreground Agent Knowledge variables. An absent file disables
knowledge; an invalid selected file or missing/insecure credential is
`misconfigured`, without environment fallback. PostgreSQL takes its tenant from
authoritative storage and rejects a tenant in the managed file. See the
[persistent deployment guide](agent-knowledge-deployment.md).

Configuration remains outside project state, snapshots, generated Markdown,
and SQLite/PostgreSQL authority. Credentials and endpoint values are never returned in
health or errors. The five-second deadline bounds how long Runtime bootstrap
waits for the connection. The SurrealDB client has no abort-signal API: on
timeout the host requests a disconnect, disables reconnects, and closes any
handle that arrives later. A client operation that never settles cannot be
guaranteed to finish. Invalid configuration or a failed connection leaves the
authoritative Runtime running without a knowledge store. The connected store
is closed when the host stops. Connection setup may initialize the existing
AK-02 schema, but AK-03 does not create or change knowledge records.
`/health` reports `knowledge.provider` and
`knowledge.startup` (`disabled`, `misconfigured`, `connected`, or `unavailable`)
as the **startup observation**, not a live database probe. Restart to retry
after a failure or configuration change. AK-03 introduced no knowledge mutation command; AK-05 later added reviewed admission.

## Retrieval contract

- A trusted caller supplies tenant and portable `repositoryId` on every call.
  The adapter rejects invalid scope and never derives it from a checkout path,
  Runtime-local project ID, or model output.
- `findKnowledge` searches one literal substring after default Unicode
  lowercasing of both the supplied text and stored text. This is not accent
  normalization or full Unicode case folding. It accepts at most 200 Unicode
  code points in the supplied query and returns at most five hits.
  It excludes superseded decisions. An optional agent ID narrows the result.
- The caller can derive that literal from a task query with
  `knowledgeCompatibilitySearchTerm`. It uses CairnKeep's existing rule: the
  longest word of at least three Unicode code points after excluding function
  words and generic task verbs, earliest on ties. The helper retains
  deterministic JavaScript default lowercase, matching the SurrealDB adapter.
  If no term
  qualifies, it keeps the whole query. This preserves the current modest
  recall; it does not make multiword, semantic, or vector search equivalent.
- Results are ordered by creation time descending, then kind and ID ascending.
  There is no score or relevance ranking. A missing match returns `[]`.
- Returned rows must have a valid scoped record ID, scope, fields, optional
  agent filter, and literal match. Duplicate, over-limit, or malformed rows
  fail with `KNOWLEDGE_INVALID_RESULT`; database query failures become
  `KNOWLEDGE_QUERY_FAILED`. Neither error includes backend details.

The compatibility term is selected outside the SurrealDB adapter so the port
continues to mean exactly the literal text supplied by its caller. The term
selection remains stable after removal of the former adapter.

## Worker retrieval and provenance (AK-04)

`WorkerAgentExecutor.prepare` validates the task, agent, role and pipeline
before `RunContextAssembler` retrieves knowledge. Only the Runtime-composed
tenant and the authoritative portable repository binding form the store scope;
a missing repository binding skips retrieval. The assembler normalizes the task
title (or uses the stage objective), limits it to 200 code points, selects one
compatibility term, and asks for at most five scoped hits. A 5-second deadline
bounds the wait for a search. The store operation itself has no abort API, so a
timed-out operation may still finish later without influencing that run.

The existing `WorkerContext.projectMemory` field carries bounded advisory
excerpts with `provider: surrealdb`; the field name keeps the worker input
schema stable. Each excerpt is limited to 1,200 code points, all excerpts to
4,000, and the serialized field to 16 KiB or the remaining worker context
budget, whichever is smaller. Knowledge does not grant a capability or change
authoritative project state. A disabled store leaves the field and retrieval
record absent. Unavailable, failed, empty and skipped retrievals leave the
field absent; cancellation also aborts preparation.

Before any excerpt is injected, the assembler appends one run-local retrieval
record and its references atomically. The record contains outcome, typed error,
SHA-256 of both the bounded context query and the exact literal term, the
derived portable memory identity, counts, and each result's kind, ID, injection
and transformation flags. The provider query digest is null before a search
attempt and is retained for failed, cancelled and timed-out attempts. A true
`truncated` flag also marks content sanitized before injection. `sha256:` of
the original title/text pair identifies the stored content version. It stores
no query text, body, endpoint or credential. A
provenance write failure suppresses injection; a competing write for the same
run refuses preparation. `run:show` reports the retrieval. Historical
CairnKeep rows remain readable.

## Governed admission (AK-05)

New memories and decisions are written only through the authoritative Runtime's
`knowledge:plan` and `knowledge:admit` commands while native knowledge is
connected. The operator supplies a project, a completed real worker run, and
the exact text (plus a title for a decision). The application checks the
project, portable repository binding, task, agent, run ownership, completion,
worker execution provenance, and persisted result. Simulation and controlled
action runs cannot be used as knowledge sources.

`knowledge:plan` returns a bounded, reviewable JSON plan with the full proposed
text, source run, deterministic knowledge ID, a digest of the canonical run
result, and an SHA-256 plan hash. It does not write knowledge or audit state.
The operator reviews that output, then passes the exact hash and a reviewer
identity to `knowledge:admit` with the same content. The Runtime recomputes the
plan against current authority; any change invalidates the hash. The current
trusted-local operator model records the supplied reviewer identity but cannot
authenticate human presence from another same-UID process.

Admission first appends an audit event containing the reviewer, plan hash,
scope and run references, never the body. Failure of this approval append
stops before SurrealDB mutation with a bounded error. The service checks the
deterministic ID for an existing, exactly matching record and graph, then
writes an immutable scoped record only when absent. It verifies the graph and
appends a final recorded event. The response reports `recorded` or
`reconciled`; the latter means an explicit same-hash call found the exact
record and skipped a second write.

A failed write may have committed remotely. A failed final audit leaves an
otherwise verified record without a confirmed final audit. Both return typed,
sanitized uncertainty and require an explicit same-hash `knowledge:admit` call
to reconcile. Failure-audit errors cannot replace those typed outcomes or
expose backend details. A mismatched existing record fails closed; changed
content or authority invalidates the reviewed hash. The current trusted-local
reviewer identity is supplied by the caller and is not proof of human presence.
`knowledge:trace` reads the scoped record and verified provenance graph.

The limit is 4,000 Unicode code points and 16 KiB of text, with a 200 code
point decision title. Knowledge remains advisory; approval does not grant a
capability or change task, run, or project authority. AK-05 admitted
run-sourced records only; [AK-11](#admission-provenance-ak-11) adds two further
verified sources under the same plan, approval and audit sequence. The
historical AK-06 import used a distinct provenance policy.

## Admission provenance (AK-11)

[ADR-0030](../adr/ADR-0030-typed-governed-knowledge-admission-provenance.md)
records this decision. Every admitted record names the source that actually
produced it. The set is
closed and typed; the caller selects one explicitly and the Runtime verifies it
against authoritative project state before it returns a plan.

```text
KnowledgeRecord
    provenance -> KnowledgeAdmissionSource
                  agent_run | handover | operator_confirmed
```

| Source               | Use it for                                                      | CLI selector                                                                              | Verified evidence stored with the record                   |
| -------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `agent_run`          | Knowledge a completed worker run of the project produced        | `--run <runId>` (or `--source agent-run --run <runId>`)                                   | run, task, agent, digest of the run result                 |
| `handover`           | Interpretation learned during a confirmed project handover      | `--source handover --handover <confirmationId>`                                           | confirmation ID, repository fingerprint, scan ID, time     |
| `operator_confirmed` | Knowledge from interactive Codex/Claude or operator-guided work | `--source operator-confirmed --confirmed-by <operator> --evidence <kind:id>[,<kind:id>…]` | confirming operator, 1–8 resolved project evidence records |

### Why no run is fabricated

A run, task and agent on a record assert that a specific worker execution
produced it. Knowledge learned during handover or an interactive session has no
such execution, so manufacturing one would make the provenance false and would
pollute run, cost and pipeline history. Non-run records therefore carry `null`
run, task and agent references and their own typed evidence instead. An
external Codex or Claude session is likewise not provenance: AI Office neither
authenticates nor owns it, so no session identifier is accepted as a source, as
evidence, or as a stored field. Unknown options and unknown evidence kinds are
rejected.

### Agent run

Unchanged from AK-05. The plan keeps `schemaVersion: 1`, its hashed shape and
therefore its plan hash and deterministic `ak_<planHash>` ID, so records
admitted before AK-11 still reconcile on an exact retry. The plan output adds a
`provenance` object that restates the run, task and agent; it is not part of
the version 1 hash because those fields already are.

### Confirmed handover review

`handover:confirm` records the user-confirmed repository review as a
user-origin profile entry and now returns its `confirmationId`. A handover
admission is planned only when that ID is the project's **active** confirmed
review and its stored fingerprint equals the fingerprint of the current scan
evidence. Each of the following fails closed:

- the repository was only scanned or imported, an agent produced an
  interpretation, or an office manifest was approved
  (`KNOWLEDGE_HANDOVER_NOT_CONFIRMED`);
- the ID is a superseded confirmation or belongs to another project
  (`KNOWLEDGE_HANDOVER_NOT_CONFIRMED`);
- the repository evidence changed after the confirmation
  (`KNOWLEDGE_HANDOVER_STALE`); confirm the review again first.

The provenance is the confirmation ID, the confirmed fingerprint, the scan ID
when one was recorded, and the confirmation time, which also dates the record.
The existing distinction between discovery, repository review, user
confirmation and the approved organizational model is unchanged: only the
third is admission evidence, and knowledge never makes a readiness dimension
ready.

### Operator-confirmed evidence

For knowledge learned outside a run and outside handover, the provenance states
only what AI Office can verify: which project records support the knowledge and
which operator explicitly confirmed it. Evidence is one to eight unique
references of kind `requirement`, `adr`, `review`, `task` or `handover`. The
Runtime resolves each inside the project: governance state for requirements
that were not rejected, accepted ADRs and approved reviews (a pending, rejected
or superseded conclusion supports nothing), the task repository for tasks, and the current confirmed review for `handover`. A
reference that is missing, belongs to another project, or is a stale handover
fails with `KNOWLEDGE_EVIDENCE_UNAVAILABLE`. Each stored reference carries a
Runtime-derived label, never caller text. Other supporting material, such as a
repository path, is named in the knowledge text.

The confirmation boundary is `knowledge:admit` itself. The plan names the
confirming operator (`--confirmed-by`), that name is part of the plan hash, and
admission requires `--actor` to equal it (`KNOWLEDGE_CONFIRMATION_MISMATCH`
otherwise). The approval is appended to authoritative audit state before any
store write. Nothing else counts as confirmation: not invoking a client, not a
repository change, not an agent message, not an unrelated command. This is the
existing trusted-local, single-user operator model: the Runtime records the
supplied identity and cannot authenticate human presence or distinguish one
same-UID process from another.

An operator-confirmed record has no earlier authoritative timestamp, so the
plan reports `createdAt: null` and the record is dated at admission.

### Plan, hash and approval

Non-run plans are `schemaVersion: 2`. Their hash covers the content, project,
repository binding, tenant and the complete typed provenance, with evidence in
canonical `(kind, id)` order so that argument order never matters. Admission
recomputes the plan from current authority: a changed source, a re-confirmed or
stale handover review, changed evidence, or a different confirming operator
produces a different hash or a typed refusal, and the earlier approval no
longer applies. The source is selected explicitly; `--run` alone means
`agent-run`, and an option that belongs to another source is a usage error
rather than being ignored.

### Storage

Provenance is typed fields on the knowledge row, not a metadata blob.
`knowledge_memory` and `knowledge_decision` gain `provenance_kind` and the
kind-specific fields `handover_confirmation_id`, `handover_fingerprint`,
`handover_scan_id`, `handover_confirmed_at`, `confirmed_by` and `evidence[]`
(`kind`, `id`, `label`). A row without `provenance_kind` is a run record and
keeps its verified run, task, agent and source graph. Schema version 3 relaxes
`run_id`, `task_id` and `agent_id` to optional on existing databases without
rewriting rows. Schema assertions reject a field that belongs to another kind;
because SurrealDB does not evaluate an assertion for an absent optional value,
the adapter enforces on every write and read that each kind's own fields are
present, and a mixed or incomplete row fails with `KNOWLEDGE_INVALID_RESULT`.

A non-run record and its provenance are one row written in one transaction, so
neither exists without the other and no run, task, agent or source node is
created. Provenance is immutable: a write to an existing ID must match every
field, including provenance, and a run-backed write cannot take over a non-run
ID or the reverse.

### Trace, search and audit

`knowledge:trace` keeps its `provenance` object and adds:

- `admissionSource`: the source kind, the originating project and the
  source-specific evidence (`agent_run`: run, task, agent; `handover`:
  confirmation, fingerprint, scan, time; `operator_confirmed`: operator and
  evidence; `legacy_import`: the imported CairnKeep scope, key and digest);
- `admission`: the plan hash and the audit aggregate (`agent_knowledge`, the
  record ID) under which the approval and outcome events were recorded. It is
  `null` for an imported legacy record, which no governed admission wrote.

`knowledge:search` works across all kinds and adds `provenanceKind` to each
hit. Non-run hits have `null` run, task and agent, so `--agent` and agent-scoped
retrieval return run-backed records only.

Each admission appends `knowledge.admission.approved` before the write and
`knowledge.admission.recorded` or `knowledge.admission.failed` after it. For
every source the events carry the reviewer as actor, the project, the record
ID, the plan hash, the provenance kind and the evidence identifiers, and never
the knowledge text. Together they answer who requested the admission, from
which source and evidence, under which exact plan, which record resulted, and
when. `knowledge:trace` points at these events; it does not read them back.

### Authority boundaries

Only the Runtime validates and persists knowledge. Workers, skills, host
clients, repository hooks and dashboard clients have no write path; the worker
context still receives bounded advisory excerpts only. A provenance source is
evidence about the project. It grants no capability, approves no action, and
does not make authoritative information admissible: the
[classification](#what-native-project-knowledge-is-and-is-not) applies to every
source.

## Durable project knowledge policy (AK-10)

AK-10 makes durable project knowledge an explicit, stable part of agent work.
It is a policy and one read-only command. It adds no store, no provider, no
automatic ingestion, and no write path beyond AK-05 admission.

The policy has one client-neutral definition,
`packages/application/src/agent-client/project-knowledge-policy.ts`. The
checked-in distribution skill and the skill projected into installed
repositories both embed that section verbatim, and `bun run validate:skills`
fails when either drifts. Claude reads the same shared skill through its
bridge, so Codex and Claude receive identical guidance. The canonical handover
workflow carries the matching step and boundary.

### What native project knowledge is and is not

Native project knowledge is non-authoritative, advisory context held in
`AgentKnowledgeStore`: project-specific understanding that materially helps a
later agent and is expensive or non-obvious to rebuild from the repository.
Typical entries are component responsibilities and relationships,
project-specific conventions, the rationale behind a non-obvious choice,
recurring pitfalls, verified workarounds, lasting operational constraints,
integration relationships, and lessons from completed work.

It is never a competing source of truth:

| Information                                         | Source of truth                       |
| --------------------------------------------------- | ------------------------------------- |
| Source code, configuration, technical documentation | repository                            |
| Goals, constraints, preferences, roles, pipelines   | approved office manifest              |
| Milestones and requirements                         | governance state                      |
| Architectural decisions                             | ADRs                                  |
| Tasks and the execution lifecycle                   | task and run state                    |
| Deterministic repository structure and facts        | repository scan and handover evidence |
| Knowledge reusable across projects                  | global memory (`memory:*`)            |
| Non-authoritative, project-specific context         | `AgentKnowledgeStore`                 |

Global memory in `global.sqlite` holds only knowledge meant for reuse across
projects: general engineering patterns, reusable practices, role and workflow
lessons, cross-project conventions. Project-specific architecture or
implementation facts stay out of it.

A decision and the knowledge around it are separate records. The decision lives
in an ADR, a requirement, the manifest or governance state; its rationale,
consequences and lessons may become knowledge. A `decision`-kind knowledge
record is context about a decision, not the decision. When knowledge and an
authoritative record disagree, the authoritative record wins.

### When agents create it

Agents treat knowledge as a possible output of project handover,
implementation, debugging, research, code review, QA and verification,
architectural investigation, and completed-task retrospection. Before treating
substantial work as wrapped up they consider knowledge promotion and tell the
user what they would promote. "Nothing to promote" is a normal outcome; a
completed task is not by itself a reason to admit anything.

Agents never promote credentials, secrets, tokens or sensitive configuration;
raw copies of repository files; large code excerpts; transient command output;
temporary execution state; speculation presented as fact; information that is
cheap and deterministic to regenerate from the repository unless the
interpretation or rationale is itself valuable; or knowledge known to be
superseded.

### Search, provenance and approval

1. Search first with `knowledge:search --project <id> --query <literal-text>`,
   optionally `--limit <1..5>` and `--agent <id>`. It is read-only and writes neither
   knowledge nor audit state. It uses the retrieval contract above unchanged:
   one contiguous literal substring matched against lowercased record text (not
   full Unicode case folding), at most `--limit` hits (five by default), newest
   first, superseded decisions excluded, scoped by the Runtime-bound tenant and
   the project's portable repository binding. It matches record text only,
   never titles, and `--agent` excludes imported legacy records, which carry no
   agent, so a duplicate check never passes `--agent`. The command applies
   no term selection and rejects positional arguments, so the caller supplies
   one distinctive word or exact, quoted phrase and repeats the search with
   another. Option values beginning with `--` are rejected, so a flag-like term
   drops its leading dashes (`--query no-verify`). Output carries no truncation
   marker: a full page (hits equal to `--limit`) may mean more, so narrow the
   term. Output is
   `{ schemaVersion: 1, hits }`; each hit has `id`, `kind`, `title`, `text`,
   `agentId`, `runId`, `taskId`, `source`, `createdAt`, `provenanceKind` and a
   `legacy` flag for imported records; a legacy hit carries its import time as `createdAt`. It
   never returns the tenant, endpoint or credentials. Failures are typed:
   `KNOWLEDGE_STORE_NOT_CONNECTED` (no connected store),
   `KNOWLEDGE_PROJECT_NOT_FOUND`, `KNOWLEDGE_PROVENANCE_UNAVAILABLE` (the
   project has no portable repository binding; run `ai-office install .`),
   `KNOWLEDGE_INVALID_QUERY`, `KNOWLEDGE_QUERY_FAILED` and
   `KNOWLEDGE_INVALID_RESULT`. Any failure means the duplicate check did not
   happen: the agent does not plan and reports the candidate and error code.
2. Classify the candidate against the table above.
3. Propose only verified content. A record has no confidence field, so
   remaining uncertainty is stated in the text.
4. Do not create contradictory duplicates. When a hit already covers the
   candidate, nothing is admitted. No governed command supersedes or retracts
   an admitted record, so a correction would leave both records live; agents
   tell the user which record is wrong or outdated and why, and admit nothing
   that contradicts it.
5. Plan, review, admit: `knowledge:plan --project <id>` with the options of the
   [admission source](#admission-provenance-ak-11) and
   `--kind memory --text <text>` or
   `--kind decision --title <title> --text <text>` (a title is required for a
   decision and rejected for a memory), user review of the exact plan and
   hash, then `knowledge:admit` with identical options plus
   `--approve <plan-hash> --actor <reviewer>`, as described under governed
   admission. `knowledge:trace` shows the stored provenance.

The generated `AI-OFFICE.md` project instructions point every client at this
workflow; agents never write the store directly.

Provenance is the verified [admission source](#admission-provenance-ak-11):
a completed worker run, a confirmed handover review, or operator-confirmed
project evidence. Further evidence such as a repository path is named in the
text. The reviewer is the user; the trusted-local limits on reviewer identity
described above still apply.

### Relation to handover

```text
repository
    ↓
deterministic scan / handover evidence
    ↓
agent interpretation
    ↓
durable AgentKnowledgeStore entries when materially useful
```

Scan facts remain repository-scan evidence in the project profile. The
confirmed review remains handover evidence recorded by `handover:confirm`.
Only interpretation may become knowledge, through the same workflow as any
other work and with handover provenance once the review is confirmed. Handover
never copies repository structure into knowledge, never starts a run to obtain
a source, and knowledge never satisfies a readiness dimension.

### Current limits

- Admission needs one of the three verified sources. Knowledge with none, for
  example an interpretation before the handover review is confirmed or an
  interactive finding no project record supports, is reported to the user as a
  candidate rather than admitted.
- Operator confirmation and reviewer identity are trusted-local. They are not
  cryptographic human-presence authentication: `--confirmed-by` and `--actor`
  are caller-supplied, so a same-user process with shell access, including a
  host Codex or Claude session, can plan and admit an operator-confirmed record
  itself. The Runtime guarantees that the cited evidence exists in the project
  and that the admission is audited; it does not judge whether the evidence
  supports the text. The user's review of the exact plan is the control.
- A confirmed handover review travels with portable project snapshots. After
  `project:restore` it is accepted as handover evidence when its fingerprint
  matches the restored scan evidence, although `handover:confirm` did not run
  on this Runtime.
- Evidence is checked when the plan is computed and again at admission, not
  afterwards: a record is not invalidated when a cited requirement, task or
  handover review later changes. `knowledge:trace` shows what was verified at
  admission.
- `knowledge:trace` reports the audit aggregate and plan hash but does not
  read the audit events back.
- No command supersedes or relates records. The policy tells agents not to add
  a contradictory duplicate, to report an outdated record to the user, and to
  name the replaced record in the text of a correction.
- Search is literal substring matching on record text with five results and
  no truncation marker. It can miss a differently worded duplicate, a record
  whose distinctive term appears only in its title, older matches beyond the
  five newest, and, with `--agent`, every imported legacy record.
- The policy is agent guidance. The Runtime enforces the admission path,
  scope, bounds and audit; it does not classify content or detect secrets in
  submitted text. The user's review of the exact plan is the control.

## Historical CairnKeep import (AK-06)

AK-06 provided a bounded, explicit, reviewed import of visible CairnKeep named
scope entries into a separate native legacy-memory table. AK-08 removed the
adapter, `project-memory:status`, `knowledge:legacy-plan`, and
`knowledge:legacy-import`; that workflow is no longer available. Existing
imported entries retain source scope, key, SHA-256 value digest and import time.
They have no invented AI Office run, task, agent or source creation time.
`knowledge:trace` exposes their legacy origin, and bounded native search can
return them. Historical run retrieval provenance remains readable through
`run:show`. Neither the Runtime nor AK-08 deletes the external CairnKeep store.
Unimported scopes must be retained and reviewed separately outside AI Office.
See the [historical project memory record](project-memory.md).

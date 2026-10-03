# Agent runtime

`run:tick --json` returns schema version 1 with a result for every processed run,
including its status, sanitized execution/cleanup errors and action references.
Capacity is bounded to 1–100. An empty batch or entirely successful execution
returns exit code 0; failures, cancellations or cleanup failures return 1.
An interrupted state write returns `interrupted` with a typed persistence error
and retains its lock for recovery. This is an execution outcome, not a new
persisted AgentRun status.
Action `approval_pending` means the intent was processed, not that its mutation
executed. Executor exception text is not exposed or persisted as a run error.

M3 loads `agents/*/agent.yaml` with Bun's native YAML parser and validates every field before persistence. `agent:sync` upserts stable project-scoped role and agent identities.

The [bundled profile guide](../../agents/README.md) describes four core delivery
profiles in `agents/` and fourteen opt-in specialists in `agent-catalog/`.
Normal synchronization of `agents/` registers and enables the core set only;
the separate catalog or a selected subset must be deliberately synchronized.
Each synchronized agent is enabled and can be scheduled outside an active
pipeline without an office revision. A revision is required for pipeline routing.
Sync upserts definitions: it neither removes nor disables previously synchronized
specialists when only the core set is synchronized again. It does not grant
controlled-action authority or change the office manifest or default pipelines.
Companion `system.md` files are trusted role guidance inputs. `agent:sync` loads,
validates, bounds, and persists their text with a version in the synchronized
role. Each scheduled `AgentRun` pins that guidance; changing a source file after
scheduling cannot change the run. The worker receives generic Runtime constraints
and the pinned role guidance as separate system sections. Guidance is bounded and
never copied into audit or queue payloads. The canonical role key is the manifest
role ID (`architect`, `developer`, `reviewer`, `qa`); synchronization fails closed
when a catalog uses an incompatible key.

`run:schedule` validates project, runnable task, and enabled agent, creates a queued run,
and acquires the task lock in one short transaction. In that transaction it
reads the agent's role and freezes the run's model assignment from host model
routing ([ADR-0019](../adr/ADR-0019-agent-model-routing.md)): a resolved
`<provider>:<model>` with its policy, profile and source, or `unrouted` when the
host has no routing. Resolution failure leaves no run or lock. It can persist one immutable
controlled-action intent containing resource, operation, and canonical JSON
arguments. Lock acquisition is a conditional SQLite upsert: a live lock is never
removed, while a lock with `expires_at <= now` is replaced atomically. A second
active run for the same task fails with a typed error. The repository also
exposes owner-only lock renewal, used by real worker execution. Scheduling refuses a
second non-terminal run even if its previous lease expired: expiration alone
does not prove the old work stopped.

`run:tick` processes queued runs with bounded capacity outside the daemon's
global command FIFO. Runs with an action intent use the M6D-lite executor gateway.
The CLI and daemon allow its response to outlive short-command transport
deadlines. Worker deadlines belong to role limits; state/cancellation requests
remain responsive. Each persisted execution transition invalidates the dashboard
before the batch finishes, so live progress does not wait for command completion.
Admission atomically checks fresh task, agent, pipeline and lease facts, records
the claiming Runtime instance, and prevents concurrent ticks claiming one run
twice. Blocked/terminal tasks and stale authority cannot dispatch work;
runs without one require an explicit worker or simulation selection. Without
either selection, a batch containing normal queued tasks fails before dispatch
and leaves the queue unchanged. The gateway returns only action
identity, outcome, and status to the runtime. Connector output and implementation
objects do not cross that boundary. Execution returns an explicit `completed`,
`failed`, or `cancelled` result. A worktree cleanup error is reported separately
and never hides the primary execution error. Lock release is attempted only
after a terminal state was persisted; interrupted writes retain recovery evidence.

The state sequence is `queued -> preparing -> running -> reviewing -> completed`. Errors finish as `failed`; cancellation support is present in the domain and executor boundary. Each persisted transition appends exactly one immutable event in the same short transaction as the current-state update.

At restart, `preparing`, `running`, and `reviewing` runs are discoverable through
`run:reconcile`. `run:cancel` requests stopping live work or cancels queued work;
approved reconciliation resolves orphaned execution without replay or task
status changes. Ambiguous effects remain blocked. See [run recovery](run-recovery.md).
No subprocess, Git mutation, LLM call, or long-running transaction is used by the simulator.

The retained worktree manager is a deterministic test implementation; current
worker, simulation and controlled-action executors do not allocate fake paths.
Git worktree integration and an autonomous LLM tool loop remain future. A
mutation requested by a run remains simulated until separately approved and
executed. Recoverable runs and `executing` or `execution_unknown` actions remain
observable and are never replayed automatically.

## Real worker operation

After scheduling a task, choose the executor explicitly:

```bash
ai-office run:tick --project <project-id> --worker claude
ai-office run:tick --project <project-id> --worker claude --worker-model <model>
ai-office run:tick --project <project-id> --worker codex
ai-office run:tick --project <project-id> --worker codex --worker-model <model>
ai-office run:tick --project <project-id> --worker gateway
ai-office run:show --project <project-id> --run <run-id>
```

`--worker gateway` executes routed runs whose assigned provider the metered LLM
gateway supports (currently `openai:`). It is a `WorkerRuntime` behind the same
`WorkerAgentExecutor` as the Claude worker, so context pinning, authority
fencing, lease renewal, provenance (`llm-gateway`), cancellation, deadline and
fenced acceptance are unchanged; it sends one request with the persisted model
and parameters, meters it through `MeteredLlmGateway` against the role budget,
and accepts only a bounded `{"summary", "content"}` answer from exactly the
assigned model. It refuses unrouted and historical runs, `--worker-model`,
unsupported parameters, missing credentials, missing pricing and an insufficient
budget before any provider request. See
[agent model routing](llm-cost-control.md#execution).

Use `--simulate` for a deterministic test instead. Selection applies to normal
tasks in that tick's batch; controlled-action intents always use their gateway.
When the Runtime supplies a configured default executor, it is accepted only
if its prepared execution provides validated worker provenance and an
acceptance fence. An execute-only adapter fails closed before `running`; direct
calls to the authoritative wrapper's `execute()` also fail closed. The
legacy `execute()` method remains available for internal compatibility but is
not an authoritative `run:tick` dispatch contract. For the built-in Claude
worker, AI Office owns the SQLite authority/completion fence and rejects stale
task, agent, role, pipeline or lease facts before `reviewing`. For configured
adapters, AI Office validates the provenance shape and requires `accept()`, but
the adapter is trusted code: the Runtime cannot prove that its implementation
is equivalent to the built-in fence.
The daemon needs Claude Code `2.1.259` or newer on its PATH and a working
client login. The adapter checks only the semantic version before dispatch; it
does not infer security capabilities from `claude --help`, whose output is not
complete. The baseline invocation deterministically includes `--safe-mode`,
`--restricted`, `--tools ""`, `--disallowedTools "mcp__*"`, strict empty MCP
configuration, empty ordinary setting sources, disabled slash commands,
`--permission-mode dontAsk`, `--permission-prompts none`, no session
persistence, JSON output/schema, and bounded turns/budget. This is model-visible
tool isolation, not process-level isolation. `--restricted` is not a sandbox
against same-UID code, administrators, or managed-host policy; managed policy
hooks may still run. Operators requiring process-level isolation must add an
OS/container policy outside this adapter's guarantee. A host started before a
PATH/login change may need to be restarted explicitly.

The Codex worker runs only explicitly audited `codex-cli` versions, held in an
allowlist in the adapter. The only audited version is `0.160.0`: an older,
newer, pre-release or unparseable version fails with `WORKER_UNAVAILABLE`
before any task is dispatched, until that version is audited and added. No
version range is accepted and no other worker is tried. The worker also needs
that CLI on the Runtime host PATH and a file-backed ChatGPT login of a
supported personal plan.

Only explicitly audited personal ChatGPT account classes are supported. The
adapter reads the plan claim (`chatgpt_plan_type`) from the login's tokens and
admits exactly `free`, `go`, `plus`, `pro`, `prolite` and `promax`, the values
`codex-cli` 0.160.0 writes for personal plans. Managed organizational
workspaces are intentionally unsupported: Team, Business, Enterprise,
Education and their variants, any plan the adapter does not list, a missing
plan and a malformed token or claim all fail with `WORKER_UNAVAILABLE` before
any Codex process is started, the version and feature probes included, and no
other worker is tried. An API-key login and every other credential kind in
`auth.json` are refused the same way; provider API credentials belong to the
gateway worker, which has its own trust model.

The restriction exists because `codex-cli` 0.160.0, once authenticated with a
managed-workspace login, downloads provider-controlled workspace configuration
and applies it to the session. In a local reproduction such configuration
defined an MCP server that Codex started as a host process under this worker's
exact flags, `mcp_servers={}` included, and turned on a feature that was not
disabled on the command line. The download was observed for the `business`, `ent26`,
`enterprise`, `enterprise_cbp_automation`, `enterprise_cbp_usage_based`, `hc`,
`edu`, `education` and `edu_pro` claims; the allowlist does not depend on that
list. The check is made by AI Office itself while it validates `auth.json`.
An authenticated Codex probe is deliberately not used as the boundary, since
fetching and applying managed configuration can have side effects before the
Runtime could inspect the result.

A bounded Codex run never refreshes its copied login. The credential
generation admitted by AI Office stays fixed for the lifetime of the run,
because a refreshed credential can carry a different plan or workspace
identity: with `codex-cli` 0.160.0, a stored personal login whose access token
had expired was refreshed at startup, the issuer returned Enterprise tokens,
and Codex then downloaded the workspace configuration and started its MCP
server. Two controls prevent this:

- The child's `CODEX_REFRESH_TOKEN_URL_OVERRIDE` is always
  `http://127.0.0.1:0/ai-office-refresh-disabled`, a loopback address nothing
  can listen on. 0.160.0 sends every refresh there, whether it is triggered by
  a token near expiry or by the provider answering `401`, so the refresh fails,
  no new tokens are installed and the run fails closed instead of changing
  identity. This is the boundary.
- A login is admitted only if its access token's `exp` claim satisfies
  `exp > now + run timeout + 5 minutes + 1 minute`. The run timeout is the
  role timeout of the run; five minutes is the window before expiry in which
  0.160.0 refreshes (it refreshed with 280 seconds left and not with 320); one
  minute allows for clock difference with the issuer. Before the run timeout
  is known, the same rule is applied with a zero timeout, ahead of the version
  and feature probes. A missing, non-integer, non-positive or out-of-range
  `exp` is refused. This keeps predictably stale runs from starting; it is
  not what stops a refresh.

An expired or nearly expired login therefore fails with `WORKER_UNAVAILABLE`.
The operator refreshes it by running or logging in with Codex outside AI
Office, then retries. AI Office does not call the refresh endpoint itself and
does not use an authenticated Codex probe to refresh and inspect the result,
since either would let provider-controlled managed configuration become active
before the boundary exists. Tokens refreshed inside an isolated run are
neither accepted nor persisted.

The claims are read locally and their signature is not verified. This decides
which stored logins the worker will hand to Codex; it does not authenticate
them, and the provider still does when Codex uses the login. It relies on the
login file being what the operator's own `codex login` wrote, on Codex 0.160.0
deciding from the same claim of the same, unrefreshed tokens, and on the
provider not treating a personal plan as a managed workspace. It says nothing about the safety of account classes
that have not been audited, and a provider-side change for an admitted plan
would not be detected. Both tokens in the file must name the same admitted
plan. Only the plan claim is read; nothing decoded is logged or stored.

A managed-workspace Codex executor would need its own capability and trust
design rather than reuse of this worker. Executor credentials are not yet
modelled by trust mode (personal subscription, provider API key, managed
workspace, Runtime-owned credential); that is follow-up work outside this
adapter.

Every `codex` process it starts, including the version and feature probes, runs
in a fresh private temporary tree (mode `0700`). The tree holds an empty `HOME`,
an isolated `CODEX_HOME` and a private working directory, which during
`codex exec` contains only the generated output schema. The child environment
is exactly `PATH`, that `HOME`, that `CODEX_HOME` and a fixed
`CODEX_REFRESH_TOKEN_URL_OVERRIDE` (see below); provider keys, proxy variables,
the operator's Codex home and any refresh override in the operator's
environment are not inherited.

The worker owns the whole process group of each `codex` process. On success as
well as on failure, cancellation and timeout it kills every remaining member
of the group and waits for the group to be empty before it returns, and only
then removes the tree. That wait has no upper bound: where the Runtime process
is itself the reaper of orphaned processes and does not reap them (for example
as PID 1 of a container), a killed descendant stays a zombie and the call does
not return. This is a known defect tracked as follow-up work. A process that leaves the group (a new session) is not
owned. If the tree cannot be removed the run fails with `WORKER_FAILED` rather
than reporting a result while a copy of the login may remain.

The tree is created under the Runtime's temporary directory, whose ancestors
are not trusted. Codex normally walks up from its working directory to a
project root marked by `.git` and loads that directory's `.agents/skills` and
`.codex/skills`; a `.git` in the temporary directory itself would be enough.
The worker therefore turns project-root discovery off
(`project_root_markers=[]`) for the feature probe and for `codex exec`, so no
ancestor project state, skills included, is loaded.

Authentication is the only operator state that crosses into the isolated home.
The adapter reads `auth.json` from the operator's Codex home (`CODEX_HOME`, or
`~/.codex`) and copies it, mode `0600`, into the isolated home. The source must
be the Runtime user's own regular file; it is opened read-only and without
blocking, checked on the opened descriptor, read up to a fixed size, and never
rewritten. `auth.json` itself is not followed when it is a symbolic link; a
Codex home directory that is a link still resolves. A keyring-only login, a
missing, empty, oversized or non-JSON file, a FIFO, socket, device or
directory in its place, a relative `CODEX_HOME` and a login outside the
supported personal plans fail with `WORKER_UNAVAILABLE` before any Codex
process starts. The login is read and admitted again immediately before it is
copied, so the copied bytes are the admitted ones; the worker never falls back to
the operator's home, and `OPENAI_API_KEY`/`CODEX_API_KEY` are not used. Because
only that file is copied, the operator's `AGENTS.md`, `AGENTS.override.md`,
`config.toml`, skills, rules, MCP and plugin configuration, memories and
session history are not loaded. The copy is deleted with the tree, which is
ordinary file removal, not secure erasure. The copy is never refreshed and the
operator's `auth.json` is never rewritten.

`codex exec` runs with `--ephemeral`, `--ignore-user-config`,
`--strict-config`, `--sandbox read-only`, web search disabled, no MCP servers,
bundled skills disabled, project instruction files disabled
(`project_doc_max_bytes=0`) and project-root discovery disabled
(`project_root_markers=[]`). It disables every default-enabled capability
feature of the supported CLI: shell and process execution (`shell_tool`,
`unified_exec`, `unified_exec_tty`, `shell_snapshot`, `code_mode_host`,
`code_mode`, `code_mode_only`, `sleep_tool`, `hooks`, `worktrees`,
`workspace_dependencies`), local image reading (`view_image`), network, browser
and computer automation (`image_generation`, `browser_use`,
`browser_use_external`, `browser_use_full_cdp_access`, `in_app_browser`,
`computer_use`, `in_app_local_automation`), apps, plugins, skills and MCP
(`apps`, `plugins`, `plugin_sharing`, `remote_plugin`,
`skill_mcp_dependency_install`, `skill_search`, `mentions_v2`,
`tool_call_mcp_elicitation`, `tool_suggest`, `auth_elicitation`), agents, goals
and memory (`multi_agent`, `multi_agent_v2`, `goals`, `memories`,
`guardian_approval`) and background or interactive surfaces
(`daemon_auto_start`, `in_app_updates`, `in_app_chat`, `in_app_dictation`,
`realtime_conversation`, `fast_mode`). Before any task is dispatched the
adapter runs `codex features list` with the same `--disable` flags and
configuration overrides and requires the reported state to match its audit: an unknown feature key, a feature that
stays enabled, or an enabled feature the adapter has never audited (for example
one added by a newer CLI) fails with `WORKER_UNAVAILABLE`. In 0.160.0
`--disable unified_exec` is accepted but has no effect; `shell_tool` is what
removes the shell tools, and the check requires it to be off. The probe runs
without the login; `codex exec` runs with it. What Codex loads only for an
authenticated session is therefore not covered by the probe: managed workspace
configuration is kept out by the plan allowlist together with the refresh
block above, and provider-supplied model metadata is a stated limitation
below.

What this does not achieve:

- The model context is not only Runtime data. Codex adds its own built-in
  instructions, sandbox notice and an environment block naming the temporary
  working directory, shell, date and timezone. The recorded `inputHash` covers
  the Runtime context only.
- Provider-supplied model metadata is not pinned. With a ChatGPT login Codex
  fetches the model list from the provider at session start and uses it in the
  same run; it can change the model-visible tools and the base instructions
  without any change of CLI version, so the version allowlist does not cover
  it. In every case tried under this worker's flags it changed what the model
  is shown and told, not what the client will execute.
- Feature flags do not remove tools that Codex derives from model metadata. On
  0.160.0 a code-mode model is still shown `exec`, `wait`, `request_user_input`
  and the sub-agent tools, and other models `apply_patch` and
  `request_user_input`. In this configuration they were observed to be refused
  by the client (`exec` because its host is disabled, sub-agents because an
  ephemeral session has no rollout, `apply_patch` by the read-only sandbox), but
  they are model-visible and a refused call still costs a model round trip.
- Host-level Codex configuration under `/etc/codex` (configuration,
  requirements, rules, agents and skills) is controlled by the host
  administrator and is not excluded.
- Codex itself starts local helper processes such as `lsb_release` and
  `getconf`, resolved through the inherited `PATH`, before any model
  interaction. With a ChatGPT login it also sends its own analytics events
  (thread id, model, operating system, CLI version) to the provider.
- This narrows what the Codex client loads and offers. It is not a boundary
  against another process of the same user, which can read the temporary copy
  while it exists, as it can read the operator's own login.

The adapter accepts exactly one completed JSONL turn with exactly one
schema-constrained `{summary, content}` message. Reasoning items, non-fatal
notice items and the `Reconnecting... n/m` notice Codex prints while it retries
a dropped stream are ignored; a retry that recovers still needs the completed
turn and a zero exit, and one that gives up ends in a failed turn. Any other
`error` event, any other item, any unknown event, a failed turn and anything
after the completed turn fail closed. Codex emits no JSONL
item for a tool call it refuses, so this check bounds the result and is not
what keeps tools away. The recorded model is the persisted routed model, never
one named by the output. Runtime authorization and controlled-action policy
remain authoritative. A Runtime host started before a PATH/login change may
need a restart.

The Codex CLI reports token usage but no trustworthy USD estimate to this
adapter. The role timeout is enforced by process termination. The CLI does not
expose an equivalent hard `maxCostMicros` or model-iteration limit: the result
records unknown cost, malformed usage is recorded as unknown, and operators who
need a metered budget must select the gateway worker. Codex only produces
analysis and drafted content; it does not edit files or run tests for the
Developer stage.

When the optional BullMQ queue is enabled, `AI_OFFICE_QUEUE_WORKER=codex`
selects this worker for every queued run on that Runtime host; the default
remains `claude`, and any other value leaves the queue misconfigured rather
than selecting a worker. Queued runs execute the same `run:tick --worker codex`
command, with the same isolation and authentication, as an explicit tick. The
queue has one host-wide worker setting; mixed Claude and Codex stages need
explicit per-run `run:tick` selection until per-agent executor routing is
implemented. A run that the selected worker cannot execute fails; no other
executor or provider is tried.

The first real worker produces **analysis and drafted content**. It receives
task title/description, synchronized agent/role identity and version, and the
active pinned stage's objective/checks when present. That data is sent to the
selected external client; operators must choose task content accordingly.
When the optional native `AgentKnowledgeStore` is connected, the Runtime-composed
tenant and authoritative portable repository identity scope one bounded,
task-derived search. The current adapter is SurrealDB. `RunContextAssembler`
adds advisory excerpts through the compatibility field
`WorkerContext.projectMemory` and records run-local retrieval provenance before
injection. It records separate digests of the bounded context query and the
exact literal term supplied to the store when a search was attempted. The
block is omitted when nothing was injected, and retrieval failures never fail
the run. Preparation honors the run's AbortSignal, including direct
`WorkerAgentExecutor.execute`, so cancellation during retrieval cancels the run
before any worker starts. A run that already has retrieval provenance is never
prepared again. CairnKeep integration has been removed; previously imported
records can still enter context through native retrieval. See
[native agent knowledge](agent-knowledge.md).
It receives no repository path, resource tools, role source files, or skills.
The trusted, pinned role guidance is injected separately from the generic Runtime
system constraints; task text remains data in the user/task context. Tool
declarations in a role do not grant tools to this adapter. Filesystem reads/writes, shell tests, commits and connectors are not
part of this worker contract.

The application pins adapter/version and the SHA-256 of this bounded context
before dispatch, renews the task lease and checks authority while running.
The final bounded result, session/model identifiers when reported, and usage
are persisted in the run; `run:show` also displays native knowledge retrieval
provenance and the references that entered the context. The CLI and dashboard
run detail show the result.
The dashboard identifies simulation, controlled action, real worker and unknown
historical execution separately. Task history links to each run's events/output.
Historical provenance is never guessed from a result's prose.

For Claude, the role's timeout and iteration limit become process deadline and
client turn limit. Its `maxCostMicros` denotes millionths of a USD client cost
estimate per run. This client-side estimate limit is separate from gateway
budgets and actual billing; subscription cost is unknown. Reported input tokens
exclude cache-read/cache-creation counts. Missing estimates or tokens remain
unknown. Routed runs execute exactly their persisted model: the Claude worker passes it
as `--model` and its `reasoning_effort` as `--effort`; Codex passes it as
`--model` and `model_reasoning_effort`. Each refuses other
providers and `max_output_tokens` with `WORKER_MODEL_UNSUPPORTED` before
dispatch. `run:tick` checks the batch first and starts nothing when a queued
routed run cannot be honored. `--worker-model` overrides client model selection
only for unrouted runs and runs scheduled before migration `0030`; it cannot
replace an assigned model (`WORKER_MODEL_CONFLICT`). Model assignment never
changes role limits. For the gateway worker the same `maxCostMicros` is the
run's metered `agent_run` budget in USD micros, reserved before the request;
its cost is gateway-recorded, never a client estimate. `run:show [--json]`
reports the assignment, actual model and usage, gateway metering or client
estimate, and the role limits applied at dispatch. See
[agent model routing](llm-cost-control.md#agent-model-routing).

Cancellation or deadline stops and reaps the whole worker process group on
POSIX before the execution returns. The real Claude and Codex workers are
unsupported on Windows until a tested Job Object or equivalent process-tree ownership boundary
exists; simulation and controlled actions are not disabled. Controlled action
invocation receives the assigned role timeout and propagates its AbortSignal.
A connector that ignores cancellation is not detached: the runtime waits for
its call to return, leaving the operation observable until an explicit result
or reconciliation. This means graceful shutdown is not bounded for a
non-cooperative in-process connector in the current lifecycle architecture;
adding a timeout would create a detached promise or falsely close storage.
It must not be reported as a definite failure when an external side effect
could be ambiguous; the separately executed mutation path retains the existing
`execution_unknown` reconciliation model.
If the host crashes, the new host cannot attest that the old external process
stopped: recovery reports `externalWorkerUnobserved`. Inspect the installed
client/process before explicitly reconciling that record; reconciliation does
not resume execution. A completed run means its generated output was collected,
not that the task or stage is accepted. Pipeline advancement, independent review
and all protected mutation approvals remain explicit separate operations.

See [ADR-0017](../adr/ADR-0017-bounded-external-worker.md) for the boundary and
remaining autonomous-delivery work.

## Dashboard filtered-page cost

Filtered task pages intentionally evaluate the authoritative operational-status
projection in application code rather than introducing a second SQL status
engine. The regression benchmark in
`tests/integration/operational-queries.test.ts` seeds 10,000 tasks and asserts
100 status-projection batches at the current page batch size of 100; a second
live-refresh query repeats the same bounded linear work. This is acceptable for
the current local target, so no cache or materialized status table is added
until measurements show that the single-source projection is no longer within
the target latency.

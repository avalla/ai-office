# LLM providers, gateway, and cost control

The LLM gateway provides a normalized provider port, provider registry, deterministic mock, infrastructure-only LangChain compatibility adapter, native OpenAI Responses HTTP adapter, retry-aware fallback chain, and metered gateway. The default registry supports OpenAI and Anthropic. Callers must supply input and output token bounds (`usageBound`) and accounting context.

Onboarding never constructs a provider client from this registry. Codex or
Claude owns conversational onboarding through the `ai-office` skill, so normal
installation does not need a `.env`, model reference, or provider credential.
The Runtime host uses the registry's provider descriptors and model-reference
parser, without constructing clients, to validate
[agent model routing](#agent-model-routing) and assign each run an immutable
model. The only product command that sends a model request through the gateway
is the explicit `run:tick --worker gateway`.

## Agent model routing

Model selection keeps four concepts apart
([ADR-0019](../adr/ADR-0019-agent-model-routing.md)):

| Concept | Where it lives | Portable |
| --- | --- | --- |
| model policy (`economical`, `balanced`, `high_reasoning`) | role definition, SQLite | yes |
| model profile (`<provider>:<model>` plus parameters) | host routing file | no |
| resolved model | `agent_run.model_routing_json`, frozen at scheduling | no |
| provider credentials | Runtime host environment or client login | never |

### Where routing is read

The Runtime host reads routing once at start; restart the Runtime after any
change.

| Runtime | Source |
| --- | --- |
| managed service (`service install`) | only `<AI_OFFICE_HOME>/model-routing.yaml` |
| foreground, `AI_OFFICE_MODEL_ROUTING_FILE` set | that absolute or `~/` file |
| foreground, otherwise | `<AI_OFFICE_HOME>/model-routing.yaml` when present |

The generated Runtime systemd unit and launchd plist carry
`AI_OFFICE_MODEL_ROUTING_SOURCE=runtime_home` next to `AI_OFFICE_HOME`, so a
managed Runtime discovers the same file after reboot or login on both platforms
and ignores `AI_OFFICE_MODEL_ROUTING_FILE` and `AI_OFFICE_LLM_MODEL` from the
service manager's environment. `service install` notes (by name only) routing
variables set in the invoking shell that the service will not use. A Runtime
definition generated before this marker is reported `managed_outdated`; run
`ai-office service install` once to replace it. Afterwards, changing routing
needs only a Runtime restart (`systemctl --user restart ai-office-runtime.service`
or `launchctl kickstart -k gui/$(id -u)/com.ai-office.runtime`), not a reinstall.

### File format

```yaml
schema_version: 1
profiles:
  economical:
    model: openai:<economical-model>
    reasoning_effort: low
    max_output_tokens: 4000
  balanced:
    model: openai:<balanced-model>
    reasoning_effort: medium
  high_reasoning:
    model: openai:<strong-model>
    reasoning_effort: high
policies:          # optional; a policy also maps to a profile with its own name
  default: balanced
default_profile: balanced   # optional
agents:            # optional HOST-GLOBAL overrides: every project's agent with this name
  developer:
    profile: economical
projects:          # optional overrides for one Runtime project (ids from project:list)
  <project-id>:
    agents:
      developer:
        profile: high_reasoning
      security:
        model: anthropic:<client-model>
```

Model names are placeholders. The file never accepts credentials; unknown or
credential-like keys make routing invalid. Precedence is project agent override,
host-global agent override, role policy, `default_profile`, then (foreground
only) the legacy `AI_OFFICE_LLM_MODEL`. An agent name is not an Agent identity:
an entry under `agents` applies to that name in every project on the Runtime,
while `projects.<project-id>.agents` applies only inside one project. Project
keys are Runtime project ids, never repository paths. Without routing, runs are
scheduled `unrouted` and a client worker keeps its default. Any explicit invalid
value fails every schedule closed; no invalid rule falls back to a lower one.

### Inspection

Inspection never sends a model request or writes state:

```bash
ai-office agent:models --project <id> [--json]   # agent, policy, profile, model, source, budget
ai-office model:check [--project <id>] [--json]  # exit 1 on errors
ai-office run:show --project <id> --run <id> [--json]
```

`model:check` reports the routing source, override scope, undefined policies
and profiles, malformed refs, unsupported providers, invalid parameters,
unresolved defaults and overrides as errors; and as warnings missing gateway
credentials (by variable name only), missing pricing, overrides for unknown
agents or projects, ignored ambient settings of a managed Runtime and deprecated
legacy forms. For each assigned provider it states whether the gateway worker
can execute it.

### Execution

Runs keep the model assigned when they were scheduled, whatever changes later in
role policy, profiles, overrides or host environment; retries and recovery reuse
the same run row. Execution uses only the persisted selection; a worker that
cannot honor it exactly fails before dispatch and `run:tick` leaves such a batch
queued. Controlled-action arguments are ordinary connector data and never select
a model.

| Assigned provider | First-party executor | Parameters | Cost evidence |
| --- | --- | --- | --- |
| `openai` | `run:tick --worker gateway` | `reasoning_effort` and `max_output_tokens` applied exactly | metered by the gateway |
| `anthropic` | `run:tick --worker claude` | `reasoning_effort` as `--effort`; `max_output_tokens` refused | client estimate or unknown |

The gateway worker:

- executes only routed runs (`WORKER_MODEL_REQUIRED` for unrouted and historical
  runs) and accepts no `--worker-model`;
- resolves the provider through `ModelProviderRegistry.resolveModelRef` with the
  persisted ref, so ambient `AI_OFFICE_LLM_MODEL` is ignored;
- refuses providers and parameters its descriptor does not declare, and missing
  credentials, before pricing, reservation or any request;
- sends one request with the persisted model, the profile's reasoning effort and
  an output cap: the profile's `max_output_tokens`, else a bounded default
  (`32000`) recorded with the result — set `max_output_tokens` on profiles for
  small role budgets;
- fails closed with `WORKER_MODEL_MISMATCH` when the vendor reports another model
  (configure the exact model name the vendor returns; aliases that resolve to
  another name are not accepted); the answered request is still charged at its
  reserved worst case (`charge_basis = 'reserved_envelope'`), and the usage row
  records the model that answered;
- requires the answer to be exactly `{"summary", "content"}` within the worker
  output limits; a truncated or malformed answer is metered but never accepted,
  and a provider response with missing or impossible usage is rejected and
  charged at the reserved worst case;
- reads `OPENAI_API_KEY` from the Runtime host environment only. Managed services
  are never given credentials: under a managed Runtime, gateway runs fail with a
  credential error before any request unless the service manager's own
  environment provides the key.

### Cost governance

Model routing never widens cost governance. Role `maxCostMicros`, iteration and
timeout limits apply unchanged whatever model, profile, override or executor was
chosen.

For a gateway run, the role's `maxCostMicros` (USD micros) is the run's
`agent_run` budget; a narrower existing run budget is kept and a wider one is
lowered to the role limit. The gateway requires active USD pricing for the exact
provider/model (`WORKER_PRICING_UNAVAILABLE` otherwise, never treated as zero),
reserves the worst-case cost of the bounded request against the run budget
before sending it (`WORKER_BUDGET_EXHAUSTED` if it does not fit), then records
usage and cost idempotently and consumes the reservation. The worst case prices
the byte-bounded input at the dearer of the input and cached-input rates and the
output cap at the dearer of the output and reasoning rates, each token once. See
[cost accounting](../architecture/cost-accounting.md#usage-and-pricing-contract)
for the usage contract, the exact cost formula and how to encode vendor pricing
with `pricing:set`. Only the `agent_run`
budget is reserved: project, task and agent budgets are not co-reserved by this
request.

`run:show` separates the assigned model, the actual provider/model and tokens,
and cost. Gateway runs report `usage.metering` (actual, estimated and reserved
micros, currency, pricing version, applied parameters, run budget) and never a
client estimate; client-login workers report only the client's estimate or
unknown cost. The role limits applied at dispatch are recorded for every worker
run, and gateway cost also appears in `cost:list`.

## Provider configuration

For a gateway consumer, `ModelProviderRegistry.resolveModelRef` builds a
provider for a supplied canonical reference such as a run's persisted selection,
ignoring ambient `AI_OFFICE_LLM_MODEL`. The legacy single-model `resolve` reads
one canonical model reference in `<provider>:<model>` form:

```bash
AI_OFFICE_LLM_MODEL=openai:<model>
OPENAI_API_KEY=...
```

```bash
AI_OFFICE_LLM_MODEL=anthropic:<model>
ANTHROPIC_API_KEY=...
```

The registry derives the provider from the prefix, validates the model and required credential before constructing an adapter, and returns the bare model name to the gateway. Pricing therefore remains keyed by `provider=openai, model=<model>`.

For backwards compatibility, a bare `AI_OFFICE_LLM_MODEL=<model>` is accepted only when `AI_OFFICE_LLM_PROVIDER=<provider>` is also set. This compatibility form is deprecated. When the model is prefixed, its prefix is authoritative and the compatibility variable is ignored.

Provider-native credentials remain infrastructure concerns. The current registry reads only `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; keys are never passed through domain or application objects. Missing configuration errors list environment-variable names, never their values.

## Dependency and execution boundary

```text
run:tick --worker gateway
    -> WorkerAgentExecutor (context, fence, lease, acceptance)
    -> GatewayWorkerRuntime
    -> MeteredLlmGateway
    -> ExactModelProvider
    -> ModelProviderRegistry.resolveModelRef
    -> OpenAiResponsesProvider (OpenAI) | LangChainModelProvider (Anthropic)
```

`ModelRequest.parameters` carries provider-neutral execution parameters. Every
adapter applies each parameter exactly or throws
`UnsupportedModelParameterError` before contacting the vendor. The registry
builds OpenAI providers with the native Responses adapter, which forwards
`reasoning.effort` and `max_output_tokens` verbatim (the vendor rejects values a
model does not support), sends `store: false`, requires the effective model and
request ID, and reports response status. The LangChain compatibility adapter,
still used for Anthropic, refuses execution parameters because it cannot
guarantee they are applied.

LangChain is a compatibility adapter only. It does not own agents, tools orchestration, memory, retries, policy, task execution, pricing, or budgets. Provider retries are disabled in the registered LangChain chat models, and the native adapter never retries, so retry and fallback behavior remains explicit in AI Office.

Pricing values and budgets use integer micros, bounded by JavaScript's safe-integer range when stored in SQLite (`0..9,007,199,254,740,991`). Floating-point monetary values are never accepted.

For a fallback chain, the gateway resolves active pricing for every candidate provider/model and rejects the whole request if any candidate is unpriced or uses a different currency. It reserves the maximum candidate worst case within the usage bounds with one atomic `authorizeAndReserve` transaction, executes outside the transaction, then prices and persists the provider/model that actually answered. The unused part of a reservation is not counted as spend. Actual cost above the reservation is allowed and recorded as an explicit `overage_micros`; it remains visible for audit. `completeMetered` returns the recorded cost evidence alongside the response.

Supported budget scopes are `project`, `task`, `agent`, and `agent_run`, each with project ownership checks. `milestone` is intentionally unsupported until a reliable milestone-to-task/run accounting relation exists. Reservations have an expiry. Expired rows stop reducing availability immediately, but their status changes only through the explicit, deterministic cleanup method. Calls that fail or are cancelled before any provider answer release their reservation; an answer rejected after it was received is charged at the reserved worst case instead.

Provider usage is idempotent by `provider + provider_request_id` when the provider supplies an ID. Pricing intervals use half-open boundaries (`effective_from <= at < effective_to`) and overlapping intervals for the same provider/model/currency are rejected.

The registry's provider builders read native environment variables and pass keys directly to the corresponding adapter; no key is persisted. Automated tests use fake chat models or transports and never call live provider APIs.

The LangChain adapter maps text, effective model, provider request ID, standard usage metadata, provider response metadata, and measured latency into the normalized response. The cost contract requires numeric cached-input and reasoning token counts as subsets of the input and output totals (LangChain's `input_tokens` and `output_tokens` are inclusive), so unavailable optional detail maps to zero, matching the native OpenAI adapter. The adapter does not infer or fabricate non-zero provider-specific usage fields. If total input or output usage is absent, the response is rejected instead of being guessed.

The CLI exposes pricing, budget, cost-report and read-only model routing
commands. Standard gateway tests use deterministic providers and injected
transports rather than paid calls. Any further consumer must define its own
purpose, accounting dimensions, authentication boundary, and approval model
before composition.

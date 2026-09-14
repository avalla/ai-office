# Cost accounting

The LLM gateway meters provider usage and records answered calls as cost events. The CLI manages pricing, budgets, and reports; `run:tick --worker gateway` is the only product command that sends metered provider requests.

## Accounting context

Every metered request has:

- a project;
- a purpose;
- provider and model identity;
- the pricing version used;
- optional task, agent, and agent-run dimensions.

Budget scopes currently supported are project, task, agent, and agent run. Workspace and milestone budgets are not accepted by the current application.

## Cost lifecycle

```text
authorize -> reserve -> execute -> measure -> consume -> release
```

Budget checks account for active reservations, not only historical spending. Pricing and budget values use integer micros; floating-point money is not accepted.

Before a provider call, the gateway prices all fallback candidates and atomically reserves the maximum candidate worst case. Provider work happens outside the transaction. On success, the gateway normalizes input, cached-input, output, and reasoning tokens, then atomically persists usage and actual cost for the provider/model that answered. Unused reservation is not spend; actual cost above the reservation is recorded as explicit overage.

## Usage and pricing contract

`ModelUsage` holds inclusive totals with subset details, matching what OpenAI and LangChain usage metadata report:

| Field               | Meaning                                            |
| ------------------- | -------------------------------------------------- |
| `inputTokens`       | every input token, cached or not                   |
| `cachedInputTokens` | the part of `inputTokens` read from a prompt cache |
| `outputTokens`      | every output token, reasoning included             |
| `reasoningTokens`   | the part of `outputTokens` spent on reasoning      |

A detail larger than its total is invalid: the provider response is rejected, never priced into negative or nonsensical quantities. Cost is computed from four mutually exclusive buckets, so no token is charged twice:

```text
actual_micros = floor((
    (inputTokens  - cachedInputTokens) * input_per_million
  + cachedInputTokens                  * cached_input_per_million
  + (outputTokens - reasoningTokens)   * output_per_million
  + reasoningTokens                    * reasoning_per_million
) / 1_000_000)
```

Each `pricing:set` rate therefore prices one bucket and replaces, never adds to, another rate:

| Option           | Prices                                    |
| ---------------- | ----------------------------------------- |
| `--input`        | uncached input tokens                     |
| `--cached-input` | cached input tokens, instead of `--input` |
| `--output`       | non-reasoning output tokens               |
| `--reasoning`    | reasoning tokens, instead of `--output`   |

To encode a vendor's published price list, copy its rates directly (converted to micros per million tokens). For OpenAI models, whose reasoning tokens are billed as ordinary output, set `--reasoning` equal to `--output`; reporting reasoning tokens then adds nothing. No negative or compensating values are needed.

The reservation is the highest cost any valid usage within the request's bounds can have. A worst-case request of `I` input and `O` output tokens reserves `floor((I * max(input, cached_input) + O * max(output, reasoning)) / 1_000_000)`: each token is priced once at its dearer rate, never at both.

## Failures

When no provider answer was received (a request refused before sending, HTTP or network failure, timeout, or cancellation), the reservation is released. A vendor may still bill a request that timed out or was cancelled after it was sent; AI Office has no usage evidence for it and does not charge it.

When the provider answered but the answer was rejected before its usage could be priced, the call is not treated as free. This covers a different effective provider or model, a malformed response, and usage with impossible subsets. The gateway records a cost event with `charge_basis = 'reserved_envelope'` (migration `0031`) whose actual amount is the reserved worst case, priced from the pricing version of the dearest requested candidate, and consumes the reservation. The usage row keeps what the provider validly reported, such as a substituted model and its request ID, and zero tokens when usage was unusable. If even that record cannot be written, the reservation is left active until it expires rather than released. Answers whose usage is valid, including truncated or malformed model output, are recorded with `charge_basis = 'reported_usage'` before the output is judged.

Provider usage is idempotent by provider plus provider request ID when that ID is available; a rejected answer that repeats an already recorded request ID is not charged again. Historical cost rows retain the pricing version and amount used at execution time; rows recorded before this contract are not repriced.

Provider failures are typed. The fallback chain advances only for retryable failures; configuration and invalid-response errors stop immediately.

# Adaptive project onboarding

`project:import` performs a deterministic quick scan of an existing local repository:

```bash
bun run cli -- project:import /path/to/repository
```

The import scan detects Git metadata, package manager, languages, common frameworks, database indicators, test tooling, and relevant documentation. It persists structured facts with origin and confidence plus timestamped scan history. Re-importing the same canonical path refreshes detected facts while retaining the project ID, user answers, questions, generations, and historical scans.

Import is deliberately offline and deterministic. It does not run repository scripts, require an API key, call an LLM, or create a hardcoded business questionnaire.

## Adaptive generation

Run the primary interactive flow with:

```bash
bun run cli -- project:onboard --project <project-id>
```

When there are no unanswered questions, onboarding reads project metadata, scanner facts, current profile entries, existing answers, and question history. It then calls the existing metered LLM gateway with purpose `project_onboarding`. Provider output is parsed as JSON and validated by one strict Zod schema before persistence. Unknown fields, malformed JSON, arbitrary categories or answer types, invalid select options, duplicate options, permission values outside the allowed vocabulary, and batches above five questions are rejected.

Generation is progressive: one command handles one batch, and a later invocation can generate a follow-up round after the current questions have answers. The current limits are five questions per batch and three generated rounds. A `ready` response contains no questions and ends generation.

For automation, generate and persist one batch without prompting, inspect IDs, then answer questions individually:

```bash
bun run cli -- project:onboard --project <project-id> --generate
bun run cli -- project:profile --project <project-id>
bun run cli -- project:answer \
  --project <project-id> \
  --question <question-id> \
  --answer "<value>"
```

Text and boolean answers are validated according to the generated answer type. Select answers must use the persisted options. Multi-select answers use comma-separated values.

## Permission knowledge is not authorization

Permission-category questions may use only these project-knowledge values:

- `read_files`;
- `modify_files`;
- `run_tests`;
- `run_shell`;
- `install_dependencies`;
- `create_branches`;
- `create_commits`;
- `network_access`.

They describe user preferences for future agent work. They never create or modify a `capability_grant`, filesystem scope, security policy, budget, or agent privilege. Controlled-action authorization remains deterministic and separate.

## Provenance, deduplication, and failure semantics

Persisted questions identify their source as `deterministic` (legacy/technical questions retained during upgrades) or `llm`. Each LLM question links to an `onboarding_generation` containing provider, model, prompt version `project-onboarding-v1`, semantic input SHA-256, round, status, and creation time. The hash covers the facts, existing answers, question history, prompt version, and generation round through the repository's canonical serialization convention.

Question text/category normalization and successful input hashes provide deterministic deduplication. An answered question cannot be recreated identically. No embeddings or semantic index are used.

The application reads context before the provider call and does not keep a SQLite transaction open while waiting for the provider. Only after response validation does a short transaction persist the generation and whole question batch. A persistence error rolls back both. Provider/validation failures record a sanitized failed generation when possible and preserve prior questions and answers. Gateway reservation, release, usage, pricing, cost, retry, and budget errors retain their normal behavior.

## Untrusted repository boundary

Repository-derived data is untrusted. The prompt labels scanner facts as data, not instructions, and does not include arbitrary whole files. Repository text cannot direct the model to run tools, expose credentials, change capabilities, bypass budgets, select provider credentials, or request access outside the project. The model can only propose questions in the allowed structured shape.

This milestone does not add embeddings, vector search, RAG, a code/symbol index, cross-project memory, or agent-runtime controlled-action integration.

## Manual smoke test

1. Export `AI_OFFICE_LLM_PROVIDER=openai`, `AI_OFFICE_LLM_MODEL=<model>`, and `OPENAI_API_KEY=<secret>` in the daemon environment.
2. Start the daemon with `bun run daemon`.
3. Import a repository and retain the returned project ID.
4. Configure an active `pricing:set` entry for provider `openai` and the selected model. Optionally configure `budget:set --project <id>`; insufficient hard budget fails before provider invocation.
5. Run `project:onboard --project <id>` and answer the generated questions.
6. Rerun onboarding to request a follow-up round, or use `--generate` plus `project:answer`.
7. Inspect `project:profile --project <id>` and optionally regenerate deterministic Markdown with `project:export`.
8. Inspect metered spend with `cost:list --project <id>`.

No provider secret, raw prompt, full provider response, or hidden reasoning is persisted or projected.

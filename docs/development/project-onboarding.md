# Existing project onboarding

`project:import` performs a deterministic quick scan of an existing local repository.

```bash
bun run cli -- project:import /path/to/repository
```

The quick scan detects:

- Git remote and current branch;
- package manager;
- languages;
- common frameworks;
- database indicators;
- test tooling;
- relevant documentation.

Detected information is persisted as structured profile entries with origin and confidence.
Each successful import records a completed, timestamped scan. Re-importing the same
canonical path refreshes detected facts while retaining the project ID, user answers,
and historical scans. Existing duplicate project rows are never deleted automatically.

The command persists three initial questions for information that cannot be safely inferred:

1. the next concrete outcome;
2. autonomous agent operations;
3. immutable architectural or technological constraints.

It can add deterministic follow-up questions when no test tooling or documentation is found.
An unanswered question is stored only once.

Run the interactive flow with:

```bash
bun run cli -- project:onboard --project <project-id>
```

For automation, inspect question IDs and answer one question at a time:

```bash
bun run cli -- project:profile --project <project-id>
bun run cli -- project:answer \
  --project <project-id> \
  --question <question-id> \
  --answer "<value>"
```

Answers are stored as `goal`, `preference`, `constraint`, or `permission`.
Permission answers accept `all`, `none`, or a comma-separated list containing:

- `read_files`;
- `modify_files`;
- `run_tests`;
- `run_shell`;
- `install_dependencies`;
- `create_branches`;
- `create_commits`;
- `network_access`.

The categorized profile can be exported with:

```bash
bun run cli -- project:export --project <project-id>
```

This regenerates `.ai-office/generated/project-profile.md`. SQLite remains authoritative;
the Markdown file contains no independent state.

The importer deliberately does not run untrusted project scripts and does not call an LLM.
Deep code analysis, symbol graphs and embeddings belong to later milestones.

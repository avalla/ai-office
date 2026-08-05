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
The command then prints adaptive onboarding questions for information that cannot be safely inferred.

The importer deliberately does not run untrusted project scripts and does not call an LLM.
Deep code analysis, symbol graphs and embeddings belong to later milestones.

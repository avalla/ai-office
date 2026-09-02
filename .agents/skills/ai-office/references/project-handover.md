# Project handover reference

Handover is the organizational transfer of a repository to the virtual office.
AI Office becomes the persistent management layer for the project so later
sessions do not have to rebuild the context from scratch.

Handover is not an authorization change. It grants no capability, approves no
controlled action, alters no policy, and starts no agent run.

## Machine surface

`ai-office next [path] [--json]` is the deterministic entry point. The JSON
payload is versioned independently from `ai-office status`:

```json
{
  "schemaVersion": 1,
  "project": { "id": "...", "name": "...", "root": "/canonical/root" },
  "runtime": { "daemon": "reachable", "authoritativeState": "available" },
  "handover": {
    "schemaVersion": 1,
    "state": "needs_handover",
    "repository": "existing",
    "dimensions": [
      {
        "id": "product_direction",
        "title": "Product direction",
        "state": "needs_input",
        "detail": "..."
      }
    ],
    "recommendedActions": [
      {
        "id": "complete_project_handover",
        "kind": "conversational",
        "priority": "high",
        "title": "Hand this project over to your virtual office",
        "reason": "...",
        "prompt": "Take this project in charge. ..."
      }
    ],
    "suggestedPrompts": ["..."]
  }
}
```

Exit code `0` means the handover state was assessed. Exit code `1` means the
authoritative runtime could not be consulted and the assessment is `unknown`.

## Handover states

- `unknown` — the runtime or authoritative project state is unavailable.
- `not_connected` — no valid repository identity or runtime association.
- `not_imported` — connected, but the repository was never scanned.
- `needs_handover` — scanned, but no approved product context exists.
- `in_progress` — product context exists and some dimensions still need input.
- `ready` — every readiness dimension is satisfied.

## Readiness dimensions

Each dimension is `not_started`, `discovered`, `needs_input`, `ready`, or
`unknown`.

| Dimension | Ready when |
| --- | --- |
| Project connection | Repository identity and runtime association are valid and an office manifest exists |
| Repository understanding | A repository scan exists and an approved office manifest confirms it |
| Agent clients | At least one supported client is configured for the repository |
| Product direction | The approved office records a mission and at least one goal |
| Delivery plan | At least one milestone is active |
| Working agreement | The approved office records constraints or working preferences |

`repository` is `existing` or `new`. The classification is deterministic: a
repository counts as existing when at least two structural signals are present
among detected languages, frameworks, testing tooling, a package manager, and
more than one documentation file.

## What handover persists

AI Office persists only management state it owns:

- office manifest revisions (mission, goals, constraints, preferences, roles,
  pipelines);
- governance records (milestones, requirements, ADRs, reviews);
- tasks;
- deterministic repository scan evidence in the project profile.

The repository stays authoritative for code, configuration, and technical
documentation. Never copy repository files into AI Office to make a dimension
look complete.

## What handover never does

- It does not create or widen capability grants.
- It does not approve or execute controlled actions.
- It does not change pipeline enforcement or approval gates.
- It does not start agent runs.
- It does not rewrite committed project state to match a proposal.

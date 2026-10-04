# Project handover reference

Handover is the organizational transfer of a repository to the virtual office.
AI Office becomes the persistent management layer for the project so later
sessions do not have to rebuild the context from scratch.

Handover is not an authorization change. It grants no capability, approves no
controlled action, alters no policy, and starts no agent run.

## Four distinct concepts

| Concept                       | Produced by                                                                      | Authoritative for                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Discovery                     | the deterministic repository scan                                                | detected languages, frameworks, tooling, documentation, file counts, commit evidence |
| Repository review             | an agent reading the repository and comparing it with the stored AI Office state | nothing on its own                                                                   |
| User confirmation             | the user accepting or correcting that review                                     | that repository understanding is current                                             |
| Approved organizational model | `office:apply`                                                                   | mission, goals, constraints, preferences, roles, pipelines                           |

An approved office manifest never certifies repository understanding: it
carries no architecture, no implementation state, and no review acceptance. A
project configured before the handover workflow existed therefore reports
repository understanding as `discovered`, not `ready`.

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
    "state": "in_progress",
    "repository": "existing",
    "openQuestions": { "blocking": 0, "advisory": 0 },
    "dimensions": [
      {
        "id": "repository_understanding",
        "title": "Repository understanding",
        "state": "discovered",
        "detail": "..."
      }
    ],
    "recommendedActions": [
      {
        "id": "confirm_repository_review",
        "kind": "conversational",
        "priority": "high",
        "title": "Confirm the handover repository review",
        "reason": "...",
        "prompt": "..."
      }
    ],
    "suggestedPrompts": ["..."]
  }
}
```

Exit code `0` means the handover state was assessed. Exit code `1` means the
authoritative runtime could not be consulted and the assessment is `unknown`.

## Recording a confirmed review

```text
ai-office handover:confirm --project <projectId> --summary "<what the office understood>"
```

Run it only after the four workflow preconditions hold: the repository was
actually read, it was compared with the stored AI Office state, the result was
presented to the user, and the user confirmed or corrected it. Never record it
in advance or on the user's behalf.

The confirmation is stored as a user-origin project profile entry
(`handover` / `repository_review`) holding the review summary, the scan it was
bound to, and a fingerprint of the material repository facts. It is evidence,
never permission.

## Handover states

- `unknown` — the runtime or authoritative project state is unavailable.
- `not_connected` — no valid repository identity or runtime association.
- `not_imported` — connected, but the repository was never scanned.
- `needs_handover` — scanned, but no approved product direction exists.
- `in_progress` — product direction exists and something is still missing.
- `ready` — every readiness dimension is satisfied and no blocking question is
  open.

## Readiness dimensions

Each dimension is `not_started`, `discovered`, `needs_input`, `ready`, or
`unknown`.

| Dimension                | Ready when                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Project connection       | Repository identity and runtime association are valid and an office manifest exists |
| Repository understanding | A confirmed review matches the current repository evidence                          |
| Agent clients            | At least one supported client is configured for the repository                      |
| Product direction        | The approved office records at least one goal                                       |
| Delivery plan            | At least one milestone is active                                                    |
| Working agreement        | The approved office records constraints or preferences                              |

The working agreement is read from the approved office only. Project profile
evidence is separately sourced discovery and is never summed into it.

## Re-scan invalidation

The confirmation stores a fingerprint of the material repository facts:
languages, frameworks, databases, testing tooling, repository documentation,
package manager, Git remote, a coarse source-file scale bucket, and commit
evidence. AI Office-managed files such as `AGENTS.md` and `CLAUDE.md` are
excluded, so installing them never changes the fingerprint.

Ordinary edits keep the fingerprint stable. A structural change — a new
language, an order-of-magnitude change in source-file count, new documentation
— makes the confirmation `stale`, the dimension `needs_input`, and the overall
state `in_progress`. The recommended action is to review the changes and
confirm again; the previous confirmation is superseded, never deleted silently.

## Open project questions

Unanswered goal and constraint questions describe context the handover still
needs, so they block `ready`. Preference and permission questions stay
advisory. Answer them with `project:answer` instead of guessing.

## Existing versus new repositories

`repository` is `existing`, `new`, or `unknown`. The classification is
deterministic and measures existing application code rather than tooling
presence, because a fresh scaffold already declares a language, a framework,
and a package manager while a long-lived single-language repository may declare
none of them.

A repository is `existing` when it has at least 25 source files, or at least 8
source files together with real commit history and more than one documentation
file. It is `unknown` when the recorded scan predates file-count evidence;
re-importing the repository records it.

## What handover persists

AI Office persists only management state it owns:

- office manifest revisions (mission, goals, constraints, preferences, roles,
  pipelines);
- governance records (milestones, requirements, ADRs, reviews);
- tasks;
- deterministic repository scan evidence in the project profile;
- the confirmed repository review described above.

The repository stays authoritative for code, configuration, and technical
documentation. Never copy repository files into AI Office to make a dimension
look complete.

## Handover and project knowledge

Handover evidence and durable project knowledge are different things, and each
stays where it belongs:

```text
repository
    ↓
deterministic scan / handover evidence
    ↓
agent interpretation
    ↓
durable AgentKnowledgeStore entries when materially useful
```

never:

```text
repository
    ↓
copy everything into memory
```

- Deterministic repository facts remain repository-scan evidence in the project
  profile. Do not restate them as knowledge.
- The confirmed repository understanding remains handover evidence, recorded
  with `handover:confirm`. Do not duplicate the review summary as knowledge.
- Non-authoritative interpretation discovered while reading the repository —
  why components relate the way they do, a non-obvious convention, a pitfall —
  may become durable project knowledge in `AgentKnowledgeStore` when a later
  agent could not cheaply rebuild it from the repository.
- Handover never copies repository structure, files, or scan output into
  knowledge.
- Knowledge complements handover evidence and authoritative state. It replaces
  neither, and it never makes a readiness dimension `ready`.

Proposing knowledge follows the same **Durable project knowledge** workflow as
any other work: search with `knowledge:search`, plan with `knowledge:plan`,
review the exact plan with the user, then `knowledge:admit`.

Handover knowledge is admitted with handover provenance, never with a run:

```text
repository
    ↓
deterministic scan
    ↓
agent repository review
    ↓
user confirmation
    ↓
handover:confirm            → returns the confirmation ID
    ↓
knowledge:plan --source handover --handover <confirmationId>
    ↓
user review of the exact plan
    ↓
knowledge:admit --approve <planHash> --actor <reviewer>
```

The Runtime accepts that source only while the confirmation is the project's
current confirmed repository review. A scanned or imported repository, an
agent's reading of it, and an approved office manifest are not confirmed reviews. A
superseded confirmation, another project's confirmation, and a confirmation
whose repository evidence has since changed are refused; confirm the review
again first. Handover never starts or invents an agent run to give knowledge a
source, and before the review is confirmed an interpretation is only a
candidate to report to the user.

## What handover never does

- It does not create or widen capability grants.
- It does not approve or execute controlled actions.
- It does not change pipeline enforcement or approval gates.
- It does not start agent runs.
- It does not rewrite committed project state to fit a proposal.
- It does not admit project knowledge without the reviewed
  `knowledge:plan` and `knowledge:admit` workflow.

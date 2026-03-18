---
description: Validate quality gates for a pipeline stage before advancing. Usage: /office:validate <slug> <stage>
---

$ARGUMENTS format: `<slug> <stage>`

- **slug**: project identifier
- **stage**: `prd` | `adr` | `plan` | `tasks` | `dev` | `security` | `qa` | `review` | `user_acceptance` | `release`

---

## Project Config (read first)

Before running any checklist, read `.ai-office/project.config.md` and extract the YAML frontmatter fields:

| Field | Fallback |
|---|---|
| `typecheck_cmd` | `npm run typecheck` |
| `lint_cmd` | `npm run lint` |
| `test_cmd` | `npm run test` |
| `coverage_min` | `80` |
| `lighthouse_min` | `90` |

If the file doesn't exist, use the fallback values and prepend this note to the output:
`ℹ️  No project.config.md found — using defaults. Run /office:setup to configure.`

---

## Stage Checklists

Run the checklist for the given stage. For each item: read the relevant artifact and check if the criterion is satisfied. Report PASS / FAIL / WARN per item.

### `prd`
Artifact: `.ai-office/docs/prd/<slug>.md`
- [ ] Problem statement is defined (non-empty section)
- [ ] At least one goal listed
- [ ] At least one acceptance criterion listed
- [ ] Non-goals section present
- [ ] No unresolved open questions marked with `?`

### `adr`
Artifact: `.ai-office/docs/adr/<slug>.md`
- [ ] Context section is non-empty
- [ ] Decision section states a clear choice
- [ ] At least 2 options considered in the table
- [ ] Consequences (positive and negative) documented

### `plan`
Artifact: `.ai-office/docs/runbooks/<slug>-plan.md`
- [ ] At least one milestone defined
- [ ] Dependencies section present
- [ ] Risks section present and non-empty

### `tasks`
Artifact: `.ai-office/tasks/` (all columns)
- [ ] At least one task file exists for this slug or feature
- [ ] No tasks stuck in WIP for more than a sprint (check file dates if available)
- [ ] README.md counts are consistent with actual file counts

### `dev`
Check: source code, tests, recent git log
- [ ] Run `<typecheck_cmd>` — no errors
- [ ] Run `<lint_cmd>` — no errors
- [ ] Run `<test_cmd>` — all pass
- [ ] No TODOs or FIXMEs introduced in this feature's scope (grep for them)
- [ ] No hardcoded secrets (grep for `password =`, `apiKey =`, `secret =` patterns)

### `security`
- [ ] No SQL injection vectors (parameterized queries used)
- [ ] No XSS vectors (inputs sanitized before rendering)
- [ ] Auth/authz checks present on all protected routes and endpoints
- [ ] No sensitive data in logs
- [ ] Row-level permissions verified for any new data tables or API endpoints

### `qa`
- [ ] All acceptance criteria from PRD checked off
- [ ] Edge cases tested: empty inputs, null values, boundary values
- [ ] No regressions in existing features
- [ ] Test coverage ≥ `<coverage_min>`% (check `<test_cmd>` coverage output)
- [ ] Performance acceptable (no obvious N+1 queries, no blocking UI)
- [ ] Lighthouse score ≥ `<lighthouse_min>` if UI changes present

### `review`
Artifact: `.ai-office/docs/runbooks/<slug>-review.md` (if exists)
- [ ] Technical review section completed
- [ ] Security review section completed
- [ ] Business review section completed
- [ ] Reviewer sign-off present (non-empty decision)

### `user_acceptance`
- [ ] All user stories from PRD verified by a non-developer
- [ ] UAT sign-off documented
- [ ] No blocking issues open

### `release`
- [ ] CHANGELOG updated
- [ ] Version bumped if applicable
- [ ] Deployment verified in staging
- [ ] Rollback plan documented

---

## Output Format

```
Validation: <slug> @ <stage>

✅ Problem statement defined
✅ Goals listed
⚠️  Open questions present — review before advancing
❌ No acceptance criteria found

Result: FAIL (1 error, 1 warning)
Blocking issues: acceptance criteria missing in .ai-office/docs/prd/<slug>.md
```

Only block advance on ❌ FAIL items. ⚠️ WARN items are advisory.

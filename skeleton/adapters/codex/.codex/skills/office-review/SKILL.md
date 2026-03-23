---
name: office-review
description: Multi-sector review of a document or code path. Usage: $office-review <path> [sectors:technical,security,business,ux]
disable-model-invocation: true

$ARGUMENTS format: `<path> [sectors:technical,security,business,ux]`

- **path**: file path to review (relative to project root)
- **sectors**: comma-separated list — default is all four: `technical,security,business,ux`

---

## Project Config (read first)

Read `.ai-office/project.config.md` and extract:

| Field | Fallback |
|---|---|
| `design_system` | `"project design system"` |
| `ui_framework` | `""` |

If the file doesn't exist, use the fallback values silently.

---

## Review Instructions

Read the file at `<path>`. Then perform a review across each requested sector.

---

### Technical Sector

- Unresolved TODOs or FIXMEs present?
- Unsafe type usage (e.g. `any` in TypeScript, missing type hints in Python)?
- Magic numbers or hardcoded strings that should be constants?
- Functions longer than ~50 lines (complex logic not decomposed)?
- Missing error handling at system boundaries?
- Duplicate logic that could be extracted?
- Naming conventions consistent with the rest of the codebase?

**TypeScript-specific checks** (if file is `.ts` / `.tsx`):
- `any` usage: grep for `:\s*any` and `as\s+any` — flag each occurrence
- Unsafe type assertions: grep for ` as ` casts that bypass the type system
- `catch` blocks without `instanceof` narrowing (catching `unknown` then accessing properties unsafely)
- Non-null assertions (`!`) on values that could legitimately be null
- `@ts-ignore` / `@ts-expect-error` comments suppressing real errors

**SOLID principle checks**:
- **S** — Single Responsibility: does the file/class have more than one distinct reason to change? Flag if a class handles both data access and business logic.
- **O** — Open/Closed: are new behaviors added by modifying existing switch/if chains instead of extending? Flag long `switch` on type discriminants.
- **L** — Liskov Substitution: do subclasses override methods in ways that break the parent contract (throw where parent doesn't, return narrower types)?
- **I** — Interface Segregation: are large interfaces/types forced on callers that only need a subset? Flag interfaces with > 7 methods used by many callers.
- **D** — Dependency Inversion: are high-level modules importing concrete low-level implementations directly instead of through abstractions?

Score: start at 10, deduct 1 per issue found (min 0).

---

### Security Sector

- Hardcoded secrets, tokens, or passwords?
- User inputs used directly without validation/sanitization?
- SQL built via string concatenation (injection risk)?
- Auth/authz checks missing on protected operations?
- Sensitive data (PII, tokens) logged or exposed in error messages?
- XSS vectors in rendered output?
- Missing row-level permissions on new data tables or endpoints?

**Systematic secret pattern scan** (grep the file for each):
- `password\s*=\s*["'][^"']{4,}` — hardcoded password values
- `api_?key\s*[:=]\s*["'][^"']{8,}` — hardcoded API keys
- `(secret|token)\s*[:=]\s*["'][^"']{8,}` — hardcoded secrets/tokens
- `-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY` — embedded private keys
- `AKIA[0-9A-Z]{16}` — AWS access key IDs

Skip if the value matches: `${...}`, `process.env.*`, `os.environ.*`, `<placeholder>`, or contains `test`/`example`/`dummy`.

Score: start at 10, deduct 2 per issue (security issues weigh double).

---

### Business Sector

- Does the implementation match the stated requirements / acceptance criteria?
- Are edge cases (empty state, error state, loading state) handled?
- Are error messages user-facing and helpful?
- Are any business invariants at risk (e.g. double-spend, race conditions)?

Score: start at 10, deduct 1-2 per issue.

---

### UX Sector (only for UI/component files)

- Is the component accessible (aria attributes, keyboard nav)?
- Is it responsive across target screen sizes?
- Does it follow **`<design_system>`** conventions? (uses its components/tokens, avoids reimplementing what the system provides)
- If `ui_framework` is `react` or `react-native`: are React patterns correct? (hooks at top level, no conditional hook calls, appropriate memo usage)
- Are loading and empty states handled gracefully?
- Are error states visible to the user?

Score: start at 10, deduct 1 per issue. Skip entirely if file is not a UI component.

---

## Output Format

```
## Review: <path>

### Technical — 8/10
- ⚠️  TODO on line 42: "handle edge case"
- ⚠️  Function `processOrder` is 80 lines — consider splitting

### Security — 10/10
✅ No issues found

### Business — 7/10
- ❌  Empty state not handled in list view (shows nothing instead of placeholder)
- ⚠️  Error message exposes internal field names

### UX — 9/10
- ⚠️  Missing aria-label on icon button (line 88)

---
**Overall: 8.5/10**
**Recommendation:** Needs revision — fix business logic empty state and UX aria label before merging
```

Recommendations:
- **≥ 9**: Approved
- **7–8.9**: Needs revision (minor)
- **< 7**: Major changes required

<!-- ai-office-version: 1.11.0 -->

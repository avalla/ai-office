---
name: office-validate-secrets
description: Scan the codebase for hardcoded secrets and credentials. Usage: /office-validate-secrets [path]
disable-model-invocation: true

$ARGUMENTS format: `[path]`

- **path** (optional): directory or file to scan. Defaults to the project root (`.`).

---

## Steps

1. **Determine scan root**: use `<path>` argument if provided, otherwise `.` (project root).

2. **Skip directories**: always exclude:
   - `node_modules/`
   - `.git/`
   - `dist/`, `build/`, `out/`
   - `.ai-office/`
   - `*.lock`, `bun.lockb`, `package-lock.json`, `yarn.lock`

3. **Scan for secret patterns** — search all text files for the following patterns (case-insensitive):

   | Category | Patterns to search |
   |----------|--------------------|
   | Passwords | `password\s*=\s*["'][^"']+["']`, `passwd\s*=\s*["'][^"']+["']` |
   | API keys | `api_key\s*=\s*["'][^"']+["']`, `apiKey\s*[:=]\s*["'][^"']+["']` |
   | Tokens | `token\s*=\s*["'][^"']+["']`, `access_token\s*=\s*["'][^"']+["']` |
   | Secrets | `secret\s*=\s*["'][^"']+["']`, `client_secret\s*=\s*["'][^"']+["']` |
   | Private keys | `-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY` |
   | AWS | `AKIA[0-9A-Z]{16}`, `aws_secret_access_key\s*=` |
   | GitHub | `ghp_[A-Za-z0-9]{36}`, `github_token\s*=` |
   | Generic high-entropy strings | lines where a quoted string ≥ 32 chars contains mixed case + digits (heuristic — flag as low confidence) |

4. **Allowlist — skip if**:
   - Value is a placeholder: `${...}`, `<...>`, `process.env.*`, `os.environ.*`, `env(...)`, `"your_*_here"`, `"xxx"`, `"todo"`, `"changeme"`, `"placeholder"`, `"example"`, `"test"`, `"dummy"`
   - File extension is `.md`, `.txt`, `.example`, `.sample`, `.template`
   - Line contains `# nosec` or `// nosec` or `/* nosec */`

5. **Report findings**:

   ```
   ## Secret Scan: <path> — <today>

   ### ❌ Confirmed Findings (<N>)

   | File | Line | Category | Snippet |
   |------|------|----------|---------|
   | src/config.ts | 12 | API key | `apiKey = "sk-abc..."` (truncated) |

   ### ⚠️  Low-Confidence Findings (<N>)

   | File | Line | Category | Snippet |
   |------|------|----------|---------|
   | src/utils.ts | 44 | High-entropy string | `"aB3xK7..."` (truncated) |

   ### ✅ Clean
   No confirmed secrets found.
   ```

   **Snippet truncation**: show at most 40 characters of the matched value. Replace the actual secret characters with `[REDACTED]` after the first 6 characters to avoid leaking real values in the report.

   Example: `apiKey = "sk-ab[REDACTED]"`

6. **Remediation advice** (append when findings exist):

   ```
   ### Remediation

   - Move secrets to environment variables and access via `process.env.VAR_NAME`
   - Add `.env` to `.gitignore` and use `.env.example` with placeholder values
   - Use a secrets manager (Vault, AWS Secrets Manager, Doppler) for production credentials
   - Add `# nosec` comment to intentional test fixtures to suppress future warnings
   - Consider running `git filter-repo` or `git secrets` if secrets were already committed
   ```

7. **Exit status summary**:
   - 0 confirmed findings → `✅ No secrets detected`
   - 1–3 confirmed findings → `⚠️  Minor — fix before merging`
   - 4+ confirmed findings → `❌ Critical — do not merge until resolved`

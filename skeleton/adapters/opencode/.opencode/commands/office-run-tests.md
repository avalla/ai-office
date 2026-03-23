# /office-run-tests

Description: Run the project test suite and append results to the status file. Usage: /office-run-tests <slug>

## Steps

1. **Read config**: read `.ai-office/project.config.md` and extract:
   - `test_cmd` (fallback: `npm run test`)
   - `test_runner` (fallback: `vitest`)
   - `coverage_min` (fallback: `80`)

2. **Locate status file**: check `.ai-office/docs/runbooks/<slug>-status.md`. If it does not exist, warn:
   ```
   ⚠️  No status file found for '<slug>'. Run `/office-scaffold <slug> status` first.
   ```
   and stop.

3. **Run the test suite**: execute `<test_cmd>` in the project root. Capture stdout, stderr, and exit code.

4. **Parse results**:
   - Overall result: `PASS` if exit code is 0, `FAIL` otherwise
   - Per-suite breakdown: scan output for test suite names and pass/fail counts (pattern varies by runner — see below)
   - Coverage: scan for a line matching `Coverage:` or `All files` or `Stmts` percentage — extract the overall % if found

   **Runner-specific patterns**:

   | Runner | Suite pattern | Coverage pattern |
   |--------|--------------|-----------------|
   | `vitest` | `✓` / `×` test file lines | `Coverage report` table |
   | `jest` | `PASS` / `FAIL` lines | `All files` row |
   | `pytest` | `passed` / `failed` in summary line | `TOTAL` line with `%` |
   | `go test` | `ok` / `FAIL` lines | `coverage:` in each package line |
   | Other | treat full output as one suite | look for any `%` near "coverage" |

5. **Coverage gate**: if coverage % was found and is below `coverage_min`, mark as `BELOW_THRESHOLD`.

6. **Append results to status file**: add or replace a `## Test Results` section at the bottom:

   ```
   ## Test Results

   **Run:** <today ISO datetime>
   **Command:** <test_cmd>
   **Result:** PASS / FAIL
   **Coverage:** <N>% (threshold: <coverage_min>%) / Not detected

   ### Suite Breakdown

   | Suite | Result | Tests |
   |-------|--------|-------|
   | <suite-name> | ✅ PASS / ❌ FAIL | <passed>/<total> |

   ### Output (last 40 lines)

   ```
   <last 40 lines of stdout/stderr>
   ```
   ```

   If a `## Test Results` section already exists, replace it entirely.

7. **Respond**:

   ```
   Test run: <slug>
   Command: <test_cmd>
   Result: ✅ PASS / ❌ FAIL
   Coverage: <N>% (min: <coverage_min>%)
   Suites: <passed>/<total> passed
   Results written to .ai-office/docs/runbooks/<slug>-status.md
   ```

   If coverage is `BELOW_THRESHOLD`, append:
   ```
   ⚠️  Coverage <N>% is below threshold <coverage_min>% — address before advancing to QA
   ```

<!-- ai-office-version: 1.11.0 -->

<!-- ai-office-version: 1.11.0 -->

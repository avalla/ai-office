---
trigger: when_referenced
---
# Signal Analyst Skills

## Skills Used

| Skill | File | Usage |
|-------|------|-------|
| `review-document-multisector` | `review-document-multisector.md` | Validate signal briefs, backtest reports, and strategy docs across technical, risk, and execution perspectives |

## Skill Usage Patterns

### review-document-multisector

When Used:
- Signal brief review before development begins
- Backtest report review before paper trade approval
- Walk-forward analysis review for overfitting diagnosis
- Strategy spec review before handoff to Scalper

How Used:
- Validate statistical assumptions and methodology
- Check for look-ahead bias, data snooping, overfitting red flags
- Ensure regime conditions and filter logic are explicitly documented
- Confirm that success criteria are measurable and falsifiable

## Skills NOT Used

Signal Analyst does NOT use:
- `run-tests` — Testing and backtesting execution is QA responsibility
- `generate-tests` — Test generation is QA responsibility
- `refactor-safe` — Code implementation is Developer responsibility
- `generate-migration` — Database work is Developer responsibility

## Skill Invocation

```markdown
1. Draft signal hypothesis and indicator logic
2. Document assumptions, regime filters, and parameter ranges
3. Invoke review-document-multisector on signal brief
4. Hand off to QA for backtesting execution
5. Review backtest results and invoke review-document-multisector on report
6. Approve or revise signal before handoff to Scalper
```

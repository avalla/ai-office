---
trigger: when_referenced
---
# Culture Hacker Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `22_ux_research` | `22_ux_research.md` | Cultural and audience signal research |

## Workflow Responsibilities

### 22_ux_research

Purpose: Translate audience and culture signals into high-impact creative direction.

Steps:
1. Receive product/campaign context from PM/CEO
2. Identify target audiences and active cultural tensions
3. Analyze trends, references, and competitive narratives
4. Extract high-signal hooks and avoidable traps
5. Document opportunity map and risk notes
6. Hand off findings to Provocation Director and Designer

Outputs:
- Cultural signal map
- Audience trigger matrix
- Opportunity and risk brief
- Recommendations for concept direction

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `25_design_ui` | Insights ready for concept and visual direction |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `10_ceo_prd` | Shock brief approved |
| `05_planner` | Task framing for discovery |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Culture Brief | `docs/brief/<slug>-culture-brief.md` | Cultural insight synthesis |
| Signal Matrix | `docs/brief/<slug>-signal-matrix.md` | Prioritized audience triggers |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| PM | Brief intent, audience priority |
| CEO | Ambition and boundary alignment |
| Provocation Director | Concept rupture direction |
| Designer | Visual implications of trends |
| QA/Security | Risk and safety alignment |

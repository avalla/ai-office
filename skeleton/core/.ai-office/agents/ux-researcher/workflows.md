---
trigger: when_referenced
---
# UX Researcher Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `22_ux_research` | `22_ux_research.md` | UX research workflow |

## Workflow Responsibilities

### 22_ux_research

**Purpose:** Conduct user research and provide insights

**Steps:**
1. Define research questions
2. Choose research methods
3. Recruit participants (if applicable)
4. Conduct research
5. Analyze data
6. Synthesize insights
7. Create research report
8. Present to stakeholders

**Outputs:**
- Research report
- User personas
- User journey maps
- Usability findings
- Design recommendations

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `25_design_ui` | Research insights ready for design |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `10_ceo_prd` | PRD approved, needs user research |
| `50_qa_validate` | Usability issues found |
| `70_release` | User feedback post-release |

## Document Ownership

UX Researcher owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Research Report | `docs/research/<slug>-research.md` | Research findings |
| User Personas | `docs/research/personas.md` | User archetypes |
| Journey Maps | `docs/research/<slug>-journey.md` | User flow documentation |

## Research Methods

| Method | When to Use |
|--------|-------------|
| User Interviews | Deep understanding of needs |
| Usability Testing | Validate design decisions |
| Surveys | Quantitative data collection |
| Card Sorting | Information architecture |
| A/B Testing | Compare design alternatives |
| Analytics Review | Understand behavior patterns |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| PM | Requirements validation, user stories |
| Designer | Design insights, usability testing |
| Developer | User context for implementation |
| QA | Usability test coordination |

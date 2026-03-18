---
trigger: when_referenced
---
# Provocation Director Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `25_design_ui` | `25_design_ui.md` | Concept rupture and visual direction framing |

## Workflow Responsibilities

### 25_design_ui

Purpose: Transform insight inputs into a high-impact creative direction that is both bold and executable.

Steps:
1. Receive brief and culture signal outputs
2. Define disruptive concept directions (multiple options)
3. Select strongest route with CEO/PM
4. Establish non-negotiable creative principles
5. Collaborate with Designer on visual system
6. Brief video, audio, and image creators for execution

Outputs:
- Concept rupture board
- Direction principles and anti-pattern list
- Execution guardrails for production teams

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `27_video_create` | Final concept direction approved for production |
| `26_audio_create` | Sonic direction defined for concept |
| `29_image_create` | Visual keyframes and art direction ready |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `10_ceo_prd` | Shock brief approved |
| `22_ux_research` | Culture and audience signals synthesized |

## Document Ownership

| Artifact | Location | Purpose |
|----------|----------|---------|
| Concept Board | `docs/brief/<slug>-concept-board.md` | Direction and provocation rationale |
| Creative Guardrails | `docs/brief/<slug>-guardrails.md` | Do/don't boundaries for execution |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| CEO | Ambition level and approval constraints |
| PM | Scope, milestones, and practical trade-offs |
| Culture Hacker | Cultural tension and timing inputs |
| Designer | Visual system and style execution |
| QA/Security | Safety and risk alignment |

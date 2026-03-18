---
trigger: when_referenced
---
# Game Developer Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `28_game_create` | `28_game_create.md` | Game development workflow |

## Workflow Responsibilities

### 28_game_create

**Purpose:** Develop game projects

**Steps:**
1. Receive game design document
2. Plan technical architecture
3. Implement core systems
4. Integrate assets (audio, visuals)
5. Implement gameplay mechanics
6. Optimize performance
7. Conduct playtesting
8. Polish and ship

**Outputs:**
- Game builds
- Technical documentation
- Performance reports
- Playtest results

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `50_qa_validate` | Game ready for QA testing |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `26_audio_create` | Audio assets ready |
| `29_image_create` | Visual assets ready |
| `25_design_ui` | Game UI ready |
| `10_ceo_prd` | Game design approved |

## Document Ownership

Game Developer owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Game Build | `builds/` | Executable games |
| Technical Docs | `docs/game/<slug>-tech.md` | System documentation |

## Game Development Phases

| Phase | Activities |
|-------|------------|
| Pre-production | Architecture, prototypes |
| Production | Core systems, mechanics |
| Alpha | Feature complete |
| Beta | Polish, optimization |
| Gold | Release candidate |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Designer | Game UI, UX |
| Audio Creator | Game audio integration |
| Image Creator | Visual asset integration |
| QA | Playtesting, bug reports |

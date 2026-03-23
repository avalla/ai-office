---
trigger: when_referenced
---
# Audio Creator Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `26_audio_create` | `26_audio_create.md` | Audio creation workflow |

## Workflow Responsibilities

### 26_audio_create

**Purpose:** Create audio assets for projects

**Steps:**
1. Receive audio requirements
2. Understand context and target platform
3. Create or source audio assets
4. Process and optimize audio
5. Create variations and layers (if needed)
6. Document audio assets
7. Deliver for implementation

**Outputs:**
- Audio files (multiple formats)
- Audio documentation
- Implementation notes
- Asset metadata

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `40_dev_implement` | Audio assets ready for implementation |
| `27_video_create` | Audio ready for video integration |
| `28_game_create` | Audio ready for game integration |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `25_design_ui` | UI audio requirements |
| `10_ceo_prd` | Audio feature requirements |

## Document Ownership

Audio Creator owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Audio Assets | `assets/audio/` | Audio files |
| Audio Documentation | `docs/audio/<slug>-audio.md` | Asset specifications |

## Audio Deliverables

| Deliverable | Format | Purpose |
|-------------|--------|---------|
| Sound Effects | WAV, OGG, MP3 | UI, gameplay, feedback |
| Music | WAV, OGG, MP3 | Background, themes |
| Voice-over | WAV, MP3 | Narration, dialogue |
| Ambient | OGG, MP3 | Atmosphere, environment |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Designer | UI audio design |
| Video Creator | Soundtrack, sound design |
| Game Developer | Game audio implementation |
| Developer | Audio integration |

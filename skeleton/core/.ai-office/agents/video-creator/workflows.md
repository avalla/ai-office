---
trigger: when_referenced
---
# Video Creator Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `27_video_create` | `27_video_create.md` | Video creation workflow |

## Workflow Responsibilities

### 27_video_create

**Purpose:** Create video content for projects

**Steps:**
1. Receive video requirements
2. Create storyboard/concept
3. Gather or create assets
4. Edit and composite video
5. Add audio (coordinate with Audio Creator)
6. Add captions and accessibility
7. Optimize for delivery platforms
8. Document and deliver

**Outputs:**
- Video files (multiple formats)
- Storyboards
- Captions/subtitles
- Video documentation

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `40_dev_implement` | Video assets ready for integration |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `26_audio_create` | Audio assets ready |
| `10_ceo_prd` | Video feature requirements |

## Document Ownership

Video Creator owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Video Assets | `assets/video/` | Video files |
| Video Documentation | `docs/video/<slug>-video.md` | Asset specifications |

## Video Deliverables

| Deliverable | Format | Purpose |
|-------------|--------|---------|
| Promotional | MP4, WebM | Marketing, landing pages |
| Tutorial | MP4, WebM | Training, onboarding |
| Demo | MP4, WebM | Product demonstrations |
| Motion Graphics | MP4, WebM, GIF | Animated elements |
| Social | MP4, MOV | Platform-specific content |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| PM | Video requirements, messaging |
| Audio Creator | Soundtrack, sound design |
| Designer | Visual assets, branding |
| Developer | Video player implementation |

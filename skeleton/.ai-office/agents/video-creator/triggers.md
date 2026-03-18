---
trigger: when_referenced
---
# Video Creator Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/27_video_create` | Video creation workflow |

### Workflow Events

| Event | Action |
|-------|--------|
| Marketing needs video | Create promotional content |
| Product demo needed | Create demonstration video |
| Training content needed | Create tutorial videos |
| Brand video needed | Create brand storytelling |

## Secondary Triggers

### Context-Based

- PM requests product video
- Designer needs motion graphics
- Audio Creator provides soundtrack
- Marketing requests promotional content

### Escalation-Based

- Video quality issues reported
- Accessibility concerns (no captions)
- Platform compatibility issues
- Performance issues (file size)

## Activation Conditions

### Required For

- **Marketing Videos** - Promotional and brand content
- **Product Demos** - Feature demonstrations
- **Training Content** - Tutorial and educational videos
- **Motion Graphics** - Animated visual content

### Optional For

- PRD review (video requirements)
- Architecture review (video delivery system)
- Release review (video quality check)

## Trigger Examples

### Example 1: Product Demo

```
PM: "Need demo video for new feature launch"
Video Creator: Creates demonstration video with motion graphics and narration
```

### Example 2: Marketing Video

```
CEO: "Need brand video for homepage"
Video Creator: Creates brand storytelling video with visual effects
```

### Example 3: Tutorial

```
UX Researcher: "Users struggle with onboarding"
Video Creator: Creates step-by-step tutorial video with captions
```

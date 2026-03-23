---
trigger: when_referenced
---
# Audio Creator Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/26_audio_create` | Audio creation workflow |

### Workflow Events

| Event | Action |
|-------|--------|
| Feature needs audio | Create sound effects, music |
| Video production | Create soundtrack, sound design |
| Game development | Create game audio |
| Brand identity | Create audio branding |

## Secondary Triggers

### Context-Based

- Designer needs UI sounds
- Video Creator needs soundtrack
- Game Developer needs game audio
- PM requests audio feature

### Escalation-Based

- Audio quality issues reported
- Accessibility concerns (no captions)
- Audio performance issues in game
- Licensing issues with audio assets

## Activation Conditions

### Required For

- **Game Audio** - All game audio needs
- **Video Soundtracks** - Original music and sound design
- **UI Audio** - Interface sound effects
- **Audio Branding** - Brand audio identity

### Optional For

- PRD review (audio requirements)
- Architecture review (audio system design)
- Release review (audio quality check)

## Trigger Examples

### Example 1: Game Audio

```
Game Developer: "Need footsteps, ambient forest, and combat sounds"
Audio Creator: Creates layered audio assets with variations and transitions
```

### Example 2: Video Soundtrack

```
Video Creator: "Need uplifting background music for product demo"
Audio Creator: Composes original track matching video mood and timing
```

### Example 3: UI Sounds

```
Designer: "Need subtle click sounds for buttons"
Audio Creator: Creates UI sound palette with consistent audio language
```

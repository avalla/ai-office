---
trigger: when_referenced
---
# Audio Creator MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `runcomfy` | `runcomfy` | AI audio generation (via image-to-audio models) |
| `fetch` | `fetch` | Fetch audio resources, documentation |
| `sequential-thinking` | `sequential-thinking` | Complex audio design decisions |

## Adapter Usage Patterns

### runcomfy

**When Used:**
- AI-assisted audio generation (some models support audio)
- Audio visualization assets
- Audio-related image generation (waveforms, spectrograms)

**Note:** RunComfy primarily supports image/video generation. For audio, it can create:
- Visual assets for audio visualization
- Cover art for podcasts/music
- Waveform graphics

### fetch

**When Used:**
- Audio documentation research
- Sound design best practices
- Audio format specifications
- Royalty-free audio sources

**Example:**
```
Fetch Web Audio API documentation for implementation reference
```

### sequential-thinking

**When Used:**
- Complex audio design decisions
- Layered sound design planning
- Adaptive audio system design

**Example:**
```
Design game audio system:
- Identify audio categories
- Plan layering strategy
- Design transitions
- Optimize for performance
```

## Adapters NOT Used

Audio Creator does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `lighthouse` - Performance auditing (QA)
- `ios-simulator` - iOS testing (QA/Developer)
- `stitch` - UI generation (Designer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Audio Creator has focused audio access:

- **Limited RunComfy access** - Primarily for visual assets related to audio
- **No code modification** - Audio Creator doesn't write code
- **No database access** - Audio Creator doesn't query data
- **No security scanning** - Audio Creator doesn't audit code

Audio Creator's role is audio production, not implementation.

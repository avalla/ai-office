---
trigger: when_referenced
---
# Video Creator MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `runcomfy` | `runcomfy` | AI video generation |
| `fetch` | `fetch` | Fetch video resources, documentation |
| `sequential-thinking` | `sequential-thinking` | Complex video planning |
| `playwright` | `playwright` | Screen recording, browser capture |

## Adapter Usage Patterns

### runcomfy

**When Used:**
- AI-generated video content
- Video effects and transformations
- Animated content generation

**Example:**
```
Generate product demo video from text prompt
```

**Key Functions:**
- `generate_video` - Text/image to video
- `edit_image` - Video frame editing

### playwright

**When Used:**
- Screen recording for demos
- Browser-based video capture
- UI walkthrough recording

**Example:**
```
Record browser session for product demo
```

### fetch

**When Used:**
- Video production documentation
- Encoding best practices
- Platform specifications

**Example:**
```
Fetch video encoding specifications for web delivery
```

### sequential-thinking

**When Used:**
- Complex video planning
- Multi-platform delivery strategy
- Accessibility implementation

**Example:**
```
Plan video production:
- Identify key messages
- Structure narrative arc
- Plan visual elements
- Coordinate audio
```

## Adapters NOT Used

Video Creator does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `lighthouse` - Performance auditing (QA)
- `ios-simulator` - iOS testing (QA/Developer)
- `stitch` - UI generation (Designer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Video Creator has focused video access:

- **Full RunComfy access** - AI video generation
- **Playwright access** - Screen recording
- **No code modification** - Video Creator doesn't write code
- **No database access** - Video Creator doesn't query data

Video Creator's role is video production, not implementation.

---
trigger: when_referenced
---
# Image Creator MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `runcomfy` | `runcomfy` | AI image generation (primary tool) |
| `stitch` | `stitch` | AI UI/image generation |
| `fetch` | `fetch` | Fetch image resources, documentation |
| `sequential-thinking` | `sequential-thinking` | Complex image planning |
| `lighthouse` | `lighthouse` | Image performance auditing |

## Adapter Usage Patterns

### runcomfy

**When Used:**
- AI-generated images
- Image editing and transformation
- Style transfer
- Image upscaling

**Example:**
```
Generate hero image for SaaS landing page
```

**Key Functions:**
- `generate_image` - Text to image
- `edit_image` - Image modification
- `download_media` - Asset retrieval

### stitch

**When Used:**
- UI-focused image generation
- Design system imagery
- Component visuals

**Example:**
```
Generate UI component illustrations
```

### lighthouse

**When Used:**
- Image performance auditing
- Optimization recommendations
- Web vitals check

**Example:**
```
Audit image performance on landing page
```

### fetch

**When Used:**
- Image style research
- Best practices discovery
- Platform specifications

**Example:**
```
Fetch image optimization best practices for web
```

## Adapters NOT Used

Image Creator does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `ios-simulator` - iOS testing (QA/Developer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Image Creator has focused image access:

- **Full RunComfy access** - AI image generation (primary)
- **Full Stitch access** - UI-focused imagery
- **Lighthouse access** - Performance auditing
- **No code modification** - Image Creator doesn't write code
- **No database access** - Image Creator doesn't query data

Image Creator's role is image production, not implementation.

---
trigger: when_referenced
---
# Designer MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `stitch` | `stitch` | AI-powered UI design generation |
| `runcomfy` | `runcomfy` | AI image/asset generation |
| `fetch` | `fetch` | Fetch design inspiration, best practices |
| `sequential-thinking` | `sequential-thinking` | Complex design decisions |
| `lighthouse` | `lighthouse` | Accessibility auditing |

## Adapter Usage Patterns

### stitch

**When Used:**
- Generate UI designs from text prompts
- Create design variations
- Rapid prototyping
- Design iteration

**Example:**
```
Generate dashboard UI design with sidebar navigation and data cards
```

**Key Functions:**
- `generate_screen_from_text` - Text to UI design
- `edit_screens` - Modify existing designs
- `generate_variants` - Create design alternatives

### runcomfy

**When Used:**
- Generate custom icons and illustrations
- Create placeholder images
- Generate design assets

**Example:**
```
Generate hero section illustration for SaaS dashboard
```

**Key Functions:**
- `generate_image` - Text to image
- `edit_image` - Image modification

### lighthouse

**When Used:**
- Accessibility auditing
- Color contrast validation
- Accessibility best practices

**Example:**
```
Run accessibility audit on designed page
```

### fetch

**When Used:**
- Design inspiration research
- UI pattern research
- Design system best practices

**Example:**
```
Fetch Material Design guidelines for component patterns
```

## Adapters NOT Used

Designer does NOT use:
- `snyk` - Security scanning (Security Specialist)
- `supabase` - Database operations (Developer/Architect)
- `playwright` - E2E testing (QA)
- `ios-simulator` - iOS testing (QA/Developer)
- `revenuecat` - Revenue operations (not applicable)

## Adapter Constraints

Designer has focused design access:

- **Full Stitch access** - AI UI generation
- **Full RunComfy access** - AI image generation
- **Lighthouse access** - Accessibility auditing
- **No code modification** - Designer doesn't write code
- **No database access** - Designer doesn't query data

Designer's role is visual design and user experience, not implementation.

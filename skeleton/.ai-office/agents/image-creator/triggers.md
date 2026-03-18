---
trigger: when_referenced
---
# Image Creator Triggers

## Primary Triggers

### Slash Commands

| Command | Action |
|---------|--------|
| `/29_image_create` | Image creation workflow |

### Workflow Events

| Event | Action |
|-------|--------|
| Marketing needs imagery | Create promotional images |
| Product needs assets | Create product images |
| Design needs illustrations | Create custom illustrations |
| Brand needs visuals | Create brand imagery |

## Secondary Triggers

### Context-Based

- Designer needs custom illustrations
- Video Creator needs image assets
- PM requests marketing imagery
- Developer needs optimized assets

### Escalation-Based

- Image quality issues reported
- Accessibility concerns (no alt text)
- Performance issues (file size)
- Brand consistency issues

## Activation Conditions

### Required For

- **Marketing Images** - Promotional and advertising content
- **Product Images** - E-commerce and catalog imagery
- **Illustrations** - Custom visual content
- **Brand Assets** - Logo variations, brand imagery

### Optional For

- PRD review (image requirements)
- Architecture review (image delivery system)
- Release review (image quality check)

## Trigger Examples

### Example 1: Marketing Image

```
PM: "Need hero image for landing page"
Image Creator: Creates high-quality hero image optimized for web
```

### Example 2: Product Image

```
Designer: "Need product mockups for e-commerce"
Image Creator: Creates product images with multiple angles and contexts
```

### Example 3: Illustration

```
UX Researcher: "Need custom illustrations for onboarding"
Image Creator: Creates illustration set matching brand style
```
